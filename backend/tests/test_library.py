"""Exercise actual tagged audio, incremental scans, failure isolation and read APIs."""

import base64
import errno
import hashlib
import os
import shutil
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from filelock import FileLock
from mutagen.flac import FLAC, Picture
from mutagen.id3 import TIT2, TPE1
from mutagen.mp3 import MP3

from wildstring.config import Settings
from wildstring.database import Database
from wildstring.library import scanner
from wildstring.library.repository import LibraryRepository
from wildstring.library.scanner import ScanBusyError, scan_library
from wildstring.main import create_app

FIXTURES = Path(__file__).resolve().parents[2] / "tests/fixtures/audio"


def audio(settings: Settings, suffix: str = "mp3", name: str | None = None) -> Path:
    target = settings.music_dir / (name or f"繁體測試曲.{suffix}")
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(FIXTURES / f"silence.{suffix}", target)
    return target


def repository(settings: Settings) -> LibraryRepository:
    return LibraryRepository(Database(settings.data_dir), settings.music_dir)


@pytest.mark.parametrize("suffix", ["mp3", "flac", "m4a"])
def test_real_formats_are_scanned_read_only(settings: Settings, suffix: str):
    path = audio(settings, suffix)
    before = hashlib.sha256(path.read_bytes()).hexdigest()
    report = scan_library(settings)
    assert report["status"] == "completed"
    assert report["counts"]["added"] == 1
    track = repository(settings).tracks()["items"][0]
    assert track["title"] == "繁體測試曲"
    assert track["artists"] == ["測試歌手"]
    assert track["album"] == "測試專輯"
    assert track["album_artists"] == ["測試團隊"]
    assert track["track_number"] == 2
    assert track["disc_number"] == 1
    assert track["format"] == suffix
    assert 100 <= track["duration_ms"] <= 500
    assert track["sample_rate"] == 44100
    assert not track["has_cover"]
    assert track["path"] == path.name
    assert hashlib.sha256(path.read_bytes()).hexdigest() == before


def test_rescan_and_tag_refresh_preserve_identity(settings: Settings):
    path = audio(settings)
    scan_library(settings)
    original = repository(settings).tracks()["items"][0]
    second = scan_library(settings)
    assert second["counts"]["unchanged"] == 1
    assert repository(settings).tracks()["items"][0]["id"] == original["id"]
    tags = MP3(path)
    tags["TIT2"] = TIT2(encoding=3, text=["新的測試標題"])
    tags.save()
    refreshed = scan_library(settings)
    assert refreshed["counts"]["updated"] == 1
    current = repository(settings).tracks()["items"][0]
    assert current["id"] == original["id"]
    assert current["title"] == "新的測試標題"
    assert repository(settings).tracks("新的測試")["total"] == 1


def test_full_scan_reads_tags_even_when_fingerprint_matches(settings: Settings):
    path = audio(settings)
    scan_library(settings)
    assert scan_library(settings, full=True)["counts"]["updated"] == 1
    assert path.is_file()


def test_missing_and_restored_files_keep_metadata_and_id(settings: Settings):
    path = audio(settings)
    scan_library(settings)
    store = repository(settings)
    original = store.tracks()["items"][0]
    path.unlink()
    assert scan_library(settings)["counts"]["missing"] == 1
    assert store.tracks()["total"] == 0
    assert store.track(original["id"])["status"] == "missing"
    audio(settings)
    scan_library(settings)
    assert store.tracks()["items"][0]["id"] == original["id"]


def test_bad_file_is_isolated_and_can_recover(settings: Settings):
    audio(settings)
    broken = settings.music_dir / "损坏.flac"
    broken.write_bytes(b"not audio")
    report = scan_library(settings)
    assert report["status"] == "completed_with_errors"
    assert report["counts"]["added"] == 1
    assert report["errors"] == [{"path": "损坏.flac", "code": "metadata_invalid"}]
    audio(settings, "flac", "损坏.flac")
    assert scan_library(settings)["status"] == "completed"
    assert repository(settings).tracks()["total"] == 2


def test_corrupted_existing_track_is_not_returned_as_playable(settings: Settings):
    path = audio(settings)
    scan_library(settings)
    store = repository(settings)
    original = store.tracks()["items"][0]
    path.write_bytes(b"corrupted")
    scan_library(settings)
    assert store.tracks()["total"] == 0
    assert store.track(original["id"])["status"] == "unreadable"
    audio(settings)
    scan_library(settings)
    assert store.tracks()["items"][0]["id"] == original["id"]


def test_unavailable_root_does_not_mark_tracks_missing(settings: Settings):
    audio(settings)
    scan_library(settings)
    settings.music_dir.rename(settings.music_dir.with_name("offline-music"))
    report = scan_library(settings)
    assert report["status"] == "failed"
    assert report["counts"]["missing"] == 0
    assert repository(settings).tracks()["total"] == 1


def test_incomplete_traversal_does_not_mark_tracks_missing(settings: Settings, monkeypatch):
    path = audio(settings)
    scan_library(settings)
    path.unlink()
    walk = scanner.os.walk

    def partial(root, **kwargs):
        kwargs["onerror"](PermissionError(errno.EACCES, "denied", str(root / "blocked")))
        yield from walk(root, **kwargs)

    monkeypatch.setattr(scanner.os, "walk", partial)
    report = scan_library(settings)
    assert report["status"] == "completed_with_errors"
    assert report["counts"]["missing"] == 0
    assert repository(settings).tracks()["total"] == 1


def test_symlinked_files_and_folders_are_not_followed(settings: Settings, tmp_path: Path):
    outside = tmp_path / "outside"
    outside.mkdir()
    shutil.copyfile(FIXTURES / "silence.mp3", outside / "outside.mp3")
    (settings.music_dir / "linked.mp3").symlink_to(outside / "outside.mp3")
    (settings.music_dir / "linked-folder").symlink_to(outside, target_is_directory=True)
    report = scan_library(settings)
    assert report["counts"]["skipped"] == 2
    assert repository(settings).tracks()["total"] == 0


def test_source_changed_during_read_is_reported(settings: Settings, monkeypatch):
    audio(settings)
    read = scanner.read_metadata

    def changing(source, path):
        result = read(source, path)
        current = path.stat()
        os.utime(path, ns=(current.st_atime_ns, current.st_mtime_ns + 1_000_000))
        return result

    monkeypatch.setattr(scanner, "read_metadata", changing)
    report = scan_library(settings)
    assert report["errors"][0]["code"] == "file_changed"
    assert repository(settings).tracks()["total"] == 0


def test_concurrent_scan_is_rejected(settings: Settings):
    settings.data_dir.mkdir()
    with FileLock(settings.data_dir / "library-scan.lock"):
        with pytest.raises(ScanBusyError):
            scan_library(settings)


def test_interrupted_scan_can_be_restarted_incrementally(settings: Settings, monkeypatch):
    audio(settings, "mp3", "a.mp3")
    audio(settings, "flac", "b.flac")
    read = scanner.read_metadata

    def interrupted(source, path):
        if path.name == "b.flac":
            raise KeyboardInterrupt
        return read(source, path)

    monkeypatch.setattr(scanner, "read_metadata", interrupted)
    with pytest.raises(KeyboardInterrupt):
        scan_library(settings)
    store = repository(settings)
    assert store.scans()[0]["status"] == "interrupted"
    first_id = store.tracks()["items"][0]["id"]
    monkeypatch.setattr(scanner, "read_metadata", read)
    report = scan_library(settings)
    assert report["counts"]["unchanged"] == 1
    assert report["counts"]["added"] == 1
    assert store.track(first_id)["status"] == "available"


def test_crashed_running_record_becomes_interrupted_after_lock_acquisition(settings: Settings):
    database = Database(settings.data_dir)
    database.initialize()
    store = LibraryRepository(database, settings.music_dir)
    old_run = store.begin_scan()
    scan_library(settings)
    assert store.scan(old_run)["status"] == "interrupted"


def test_missing_title_uses_filename_without_inventing_artists(settings: Settings):
    path = audio(settings, name="無標題.MP3")
    tags = MP3(path)
    tags.tags.delall("TIT2")
    tags.tags.delall("TPE1")
    tags.save()
    scan_library(settings)
    track = repository(settings).tracks()["items"][0]
    assert track["title"] == "無標題"
    assert track["title_source"] == "filename"
    assert track["artists"] == []


def test_multiple_artists_and_cover_are_preserved(settings: Settings):
    path = audio(settings)
    mp3 = MP3(path)
    mp3["TPE1"] = TPE1(encoding=3, text=["AC/DC", "測試歌手"])
    mp3.save()
    flac_path = audio(settings, "flac")
    flac = FLAC(flac_path)
    cover = Picture()
    cover.type = 3
    cover.mime = "image/png"
    cover.data = base64.b64decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1cAAAAASUVORK5CYII="
    )
    flac.add_picture(cover)
    flac.save()
    scan_library(settings)
    tracks = repository(settings).tracks()["items"]
    assert next(track for track in tracks if track["format"] == "mp3")["artists"] == [
        "AC/DC",
        "測試歌手",
    ]
    assert next(track for track in tracks if track["format"] == "flac")["has_cover"]


def test_api_pagination_search_and_error_isolation(settings: Settings):
    path = audio(settings)
    mp3 = MP3(path)
    mp3["TIT2"] = TIT2(encoding=3, text=["ＬＩＶＥ 100%_测試"])
    mp3.save()
    audio(settings, "flac")
    report = scan_library(settings)
    with TestClient(create_app(settings)) as client:
        page = client.get("/api/v1/tracks", params={"limit": 1}).json()
        assert page["total"] == 2
        assert len(page["items"]) == 1
        second = client.get("/api/v1/tracks", params={"limit": 1, "offset": 1}).json()
        assert second["items"][0]["id"] != page["items"][0]["id"]
        for q in ("live", "%", "_", "测試"):
            assert client.get("/api/v1/tracks", params={"q": q}).json()["total"] == 1
        assert client.get("/api/v1/tracks", params={"q": "%' OR 1=1 --"}).json()["total"] == 0
        assert client.get("/api/v1/tracks", params={"q": "測試歌手"}).json()["total"] == 2
        assert client.get("/api/v1/tracks?limit=201").status_code == 422
        assert client.get("/api/v1/tracks?offset=-1").status_code == 422
        assert client.get("/api/v1/tracks/missing").status_code == 404
        response = client.get(f"/api/v1/tracks/{page['items'][0]['id']}")
        assert response.status_code == 200
        assert str(settings.music_dir) not in response.text
        assert client.get(f"/api/v1/scans/{report['id']}").json()["status"] == "completed"
        assert client.get("/api/v1/scans").json()[0]["id"] == report["id"]


def test_empty_library_and_separate_roots(settings: Settings, tmp_path: Path):
    with TestClient(create_app(settings)) as client:
        assert client.get("/api/v1/tracks").json()["total"] == 0
        assert client.get("/api/v1/scans").json() == []
    audio(settings)
    scan_library(settings)
    other = tmp_path / "other-root"
    other.mkdir()
    settings.music_dir = other
    assert repository(settings).tracks()["total"] == 0
    scan_library(settings)
    assert repository(settings).tracks()["total"] == 0


def test_database_rejects_newer_schema_without_resetting(settings: Settings):
    database = Database(settings.data_dir)
    database.initialize()
    with database.connect(write=True) as connection:
        connection.execute("PRAGMA user_version = 2")
    with pytest.raises(RuntimeError, match="newer"):
        database.initialize()
    with database.connect() as connection:
        assert connection.execute("PRAGMA user_version").fetchone()[0] == 2
