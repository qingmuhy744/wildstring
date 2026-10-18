"""Managed imports preserve sources and existing edits, with stable IDs and safe names."""

import hashlib
import shutil
from pathlib import Path

import pytest
from filelock import FileLock
from mutagen.flac import FLAC
from pydantic import ValidationError

from wildstring.config import Settings
from wildstring.database import Database
from wildstring.library import importer
from wildstring.library.import_files import component, target_directory
from wildstring.library.importer import import_music
from wildstring.library.repository import LibraryRepository
from wildstring.library.scanner import ScanBusyError, scan_library

FIXTURES = Path(__file__).resolve().parents[2] / "tests/fixtures/audio"


def source(settings, name="原来的名字.flac", title="测试歌曲"):
    settings.music_dir.mkdir(exist_ok=True)
    path = settings.music_dir / name
    shutil.copyfile(FIXTURES / "silence.flac", path)
    tags = FLAC(path)
    tags["title"] = title
    tags["album"] = "测试专辑"
    tags["albumartist"] = "测试艺人"
    tags["tracknumber"] = "3"
    tags["discnumber"] = "2"
    tags.save()
    return path


def store(settings):
    return LibraryRepository(Database(settings.data_dir), settings.library_dir)


def test_copy_normalizes_names_copies_sidecars_and_preserves_sources(
    settings, authenticated_client
):
    path = source(settings)
    original = path.read_bytes()
    path.with_suffix(".lrc").write_text("[00:01]同名测试歌词")
    report = import_music(settings)
    assert report["status"] == "completed"
    assert report["counts"]["copied"] == 1
    assert report["counts"]["assets_copied"] == 1
    track = store(settings).tracks()["items"][0]
    assert track["path"] == "测试艺人/测试专辑/CD02/03 - 测试歌曲.flac"
    target = settings.library_dir / track["path"]
    assert target.read_bytes() == original
    assert target.stat().st_ino != path.stat().st_ino
    assert target.with_suffix(".lrc").read_text() == "[00:01]同名测试歌词"
    assert path.read_bytes() == original
    with authenticated_client(settings) as client:
        assert client.get(f"/api/v1/tracks/{track['id']}/lyrics").json()["source"] == "sidecar_lrc"
        # Taking the import source offline does not interrupt the managed player.
        settings.music_dir.rename(settings.music_dir.with_name("offline-source"))
        assert client.get("/health/ready").status_code == 200
        assert client.get(f"/api/v1/tracks/{track['id']}/stream").content == original


def test_repeat_import_preserves_managed_edits_and_source_change_is_reported(settings):
    path = source(settings)
    original = path.read_bytes()
    import_music(settings)
    track = store(settings).tracks()["items"][0]
    target = settings.library_dir / track["path"]
    tags = FLAC(target)
    tags["title"] = "已整理的标题"
    tags.save()
    edited = target.read_bytes()
    report = import_music(settings)
    assert report["counts"]["unchanged"] == 1
    assert target.read_bytes() == edited
    assert path.read_bytes() == original
    assert store(settings).tracks()["items"][0]["id"] == track["id"]
    assert store(settings).tracks()["items"][0]["title"] == "已整理的标题"
    tags = FLAC(path)
    tags["title"] = "源文件也变化了"
    tags.save()
    report = import_music(settings)
    assert report["status"] == "completed_with_errors"
    assert report["errors"][0]["code"] == "source_changed_managed_copy_preserved"
    assert target.read_bytes() == edited


def test_collisions_require_review_and_identical_sources_deduplicate(settings):
    first = source(settings, "a.flac")
    second = source(settings, "b.flac")
    tags = FLAC(second)
    tags["comment"] = "another recording version"
    tags.save()
    shutil.copyfile(first, settings.music_dir / "c.flac")
    report = import_music(settings)
    assert report["counts"]["copied"] == 1 and report["counts"]["duplicates"] == 1
    from wildstring.library.intake import Intake, IntakeApproval

    intake = Intake(settings, store(settings))
    item = intake.items()["items"][0]
    assert item["issues"] == ["release_collision"]
    intake.approve(item["id"], IntakeApproval(version=item["version"], overrides={}))
    assert import_music(settings)["counts"]["copied"] == 1
    tracks = store(settings).tracks()["items"]
    assert len(tracks) == 2
    assert len({t["path"] for t in tracks}) == 2
    assert any("[" in t["path"] for t in tracks)
    assert len(list(settings.library_dir.rglob("*.flac"))) == 2
    assert import_music(settings)["counts"]["copied"] == 0


def test_interrupted_copy_never_publishes_partial_audio_and_retries(settings, monkeypatch):
    path = source(settings)
    link = importer.os.link

    def interrupt(*args, **kwargs):
        raise KeyboardInterrupt

    monkeypatch.setattr(importer.os, "link", interrupt)
    with pytest.raises(KeyboardInterrupt):
        import_music(settings)
    assert not list(settings.library_dir.rglob("*.flac"))
    assert not list(settings.library_dir.rglob(".wildstring-import-*"))
    monkeypatch.setattr(importer.os, "link", link)
    assert import_music(settings)["counts"]["copied"] == 1
    assert path.is_file()


def test_missing_source_and_missing_managed_copy_do_not_delete_or_replace_data(settings):
    source(settings)
    import_music(settings)
    track = store(settings).tracks()["items"][0]
    target = settings.library_dir / track["path"]
    target.unlink()
    report = import_music(settings)
    assert report["status"] == "completed_with_errors"
    assert not target.exists()
    settings.music_dir.rename(settings.music_dir.with_name("offline-source"))
    assert import_music(settings)["status"] == "failed"


def test_unsafe_names_symlinks_and_busy_lock_are_rejected(settings, tmp_path):
    assert component("../CON<>:?. ", "空") == "_CON____"
    assert component("NUL", "空") == "_NUL"
    assert len(component("繁體" * 200, "空").encode()) <= 160
    path = source(settings, title="../../危险/歌名:*?")
    outside = tmp_path / "outside"
    outside.mkdir()
    (settings.library_dir / "测试艺人").symlink_to(outside, target_is_directory=True)
    assert import_music(settings)["counts"]["errors"] == 1
    assert not list(outside.iterdir())
    (settings.library_dir / "测试艺人").unlink()
    assert import_music(settings)["counts"]["copied"] == 1
    assert path.is_file()
    with FileLock(settings.data_dir / "library-scan.lock"):
        with pytest.raises(ScanBusyError):
            import_music(settings)
    with pytest.raises(ValidationError):
        Settings(
            _env_file=None,
            music_dir=tmp_path,
            data_dir=tmp_path.parent / "other-runtime",
            library_dir=tmp_path / "managed",
        )


def test_import_migrates_old_direct_source_catalog_ids(settings):
    path = source(settings)
    # Simulate the earlier scanner catalog pointing at the import root.
    legacy = settings.model_copy(update={"library_dir": settings.music_dir})
    scan_library(legacy)
    original = LibraryRepository(Database(settings.data_dir), settings.music_dir).tracks()["items"][
        0
    ]
    report = import_music(settings)
    assert report["status"] == "completed"
    current = store(settings).tracks()["items"][0]
    assert current["id"] == original["id"]
    assert current["path"] != path.name
    assert (
        hashlib.sha256((settings.library_dir / current["path"]).read_bytes()).digest()
        == hashlib.sha256(path.read_bytes()).digest()
    )


def test_fallback_directory_creation_does_not_follow_symlink(settings, tmp_path, monkeypatch):
    outside = tmp_path / "private"
    outside.mkdir()
    (settings.library_dir / "linked").symlink_to(outside, target_is_directory=True)
    monkeypatch.setattr(importer.os, "supports_dir_fd", set())
    with pytest.raises(OSError):
        with target_directory(settings.library_dir, Path("linked/new/file.flac")):
            pass
    assert not (outside / "new").exists()
