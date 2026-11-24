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
    settings, authenticated_client, storage_schema
):
    path = source(settings)
    original = path.read_bytes()
    path.with_suffix(".lrc").write_text("[00:01]同名测试歌词")
    report = import_music(settings)
    assert report["status"] == "completed"
    assert report["counts"]["copied"] == 1
    assert report["counts"]["assets_copied"] == 1
    with Database(settings.data_dir).connect() as connection:
        modes = connection.execute(
            "SELECT DISTINCT link_mode FROM imported_files WHERE source_root=?",
            (str(settings.music_dir),),
        )
        assert [row[0] for row in modes] == ["copy"]
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


def test_folder_import_only_visits_selected_source_and_published_targets(settings, monkeypatch):
    settings.music_dir.mkdir()
    (settings.music_dir / "selected").mkdir()
    (settings.music_dir / "other").mkdir()
    source(settings, "selected/new.flac")
    (settings.music_dir / "other/broken.flac").write_bytes(b"invalid")
    shutil.copyfile(FIXTURES / "silence.flac", settings.library_dir / "existing.flac")
    scan_library(settings)
    before = store(settings).tracks()["items"][0]
    walked = []
    walk = importer.os.walk

    def recorded(root, **kwargs):
        walked.append(Path(root))
        yield from walk(root, **kwargs)

    monkeypatch.setattr(importer.os, "walk", recorded)
    report = import_music(settings, relative_root="selected")
    assert report["status"] == "completed"
    assert report["counts"]["copied"] == 1
    assert report["scan"]["counts"]["visited"] == 1
    assert settings.library_dir not in walked
    assert settings.music_dir / "other" not in walked
    assert store(settings).track(before["id"])["status"] == "available"
    assert store(settings).tracks()["total"] == 2


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


def test_hardlink_mode_and_in_place_round_trip(settings, authenticated_client, tmp_path):
    import time

    sources = tmp_path / "hardlink-source"
    sources.mkdir()
    source_file = source(settings)
    source_file = source_file.rename(sources / source_file.name)
    original = source_file.stat()
    with authenticated_client(settings) as client:
        headers = {"X-Wildstring-Client": "web"}
        created = client.post(
            "/api/v1/libraries",
            headers=headers,
            json={
                "name": "Hardlink",
                "source_roots": [str(sources)],
                "managed_root": str(tmp_path / "hardlink-managed"),
                "storage_mode": "copy",
            },
        )
        assert created.status_code == 201, created.text
        library = created.json()
        from wildstring.library.scope import library_context

        with library_context("admin", library["id"]):
            report = import_music(settings)
        assert report["status"] == "completed", report
        root = Path(library["managed_root"])
        audio = next(root.rglob("*.flac"))
        old = audio.stat()
        assert old.st_ino != original.st_ino
        route = f"/api/v1/libraries/{library['id']}/migrations"
        for mode in ("hardlink", "copy"):
            libraries = client.get("/api/v1/libraries").json()
            version = next(row["version"] for row in libraries if row["id"] == library["id"])
            with audio.open("rb") as playback:
                submitted = client.post(
                    route, headers=headers, json={"version": version, "target_storage_mode": mode}
                )
                assert submitted.status_code == 202, submitted.text
                identity = submitted.json()["id"]
                for _ in range(100):
                    job = next(
                        row for row in client.get(route).json()["items"] if row["id"] == identity
                    )
                    if job["status"] in {"completed", "failed"}:
                        break
                    time.sleep(0.05)
                assert job["status"] == "completed", job
                assert playback.read() == source_file.read_bytes()
            assert (audio.stat().st_ino == original.st_ino) == (mode == "hardlink")
            assert source_file.stat().st_mtime_ns == original.st_mtime_ns
            if mode == "hardlink":
                assert job["relinked_files"] == 1 and job["reclaimed_bytes"] == old.st_size
                assert job["sidecars_written"] == 1


def test_relink_retry_finishes_partial_job_without_counting_files_twice(
    settings, authenticated_client, tmp_path, monkeypatch
):
    import time

    from wildstring.library import storage
    from wildstring.library.scope import library_context

    first = source(settings, "first.flac", "First")
    second = source(settings, "second.flac", "Second")
    originals = tmp_path / "relink-source"
    originals.mkdir()
    first = first.rename(originals / first.name)
    second = second.rename(originals / second.name)
    target = tmp_path / "relink-target"
    original_publish = storage.replace_managed_file
    calls = 0

    def fail_second(*args):
        nonlocal calls
        calls += 1
        if calls == 2:
            raise OSError("test migration interruption")
        return original_publish(*args)

    def wait_job(client, path, identity):
        for _ in range(120):
            job = next(row for row in client.get(path).json()["items"] if row["id"] == identity)
            if job["status"] in {"failed", "completed"}:
                return job
            time.sleep(0.05)
        pytest.fail("Migration did not finish")

    headers = {"X-Wildstring-Client": "web"}
    with authenticated_client(settings) as client:
        result = client.post(
            "/api/v1/libraries",
            headers=headers,
            json={"name": "Retry", "source_roots": [str(originals)], "managed_root": str(target)},
        )
        assert result.status_code == 201, result.text
        library = result.json()
        with library_context("admin", library["id"]):
            assert import_music(settings)["status"] == "completed"
        copies = list(target.rglob("*.flac"))
        assert len(copies) == 2
        paths = f"/api/v1/libraries/{library['id']}/migrations"
        monkeypatch.setattr(storage, "replace_managed_file", fail_second)
        response = client.post(
            paths,
            headers=headers,
            json={"version": library["version"], "target_storage_mode": "hardlink"},
        )
        assert response.status_code == 202, response.text
        identity = response.json()["id"]
        stopped = wait_job(client, paths, identity)
        assert stopped["status"] == "failed" and stopped["relinked_files"] == 1
        source_inodes = {first.stat().st_ino, second.stat().st_ino}
        assert len(source_inodes & {path.stat().st_ino for path in copies}) == 1

        monkeypatch.setattr(storage, "replace_managed_file", original_publish)
        assert client.post(f"{paths}/{identity}/retry", headers=headers).status_code == 202
        completed = wait_job(client, paths, identity)
        assert completed["status"] == "completed", completed["error"]
        assert completed["relinked_files"] == 2
        assert completed["reclaimed_bytes"] == first.stat().st_size + second.stat().st_size
        assert {path.stat().st_ino for path in copies} == source_inodes
