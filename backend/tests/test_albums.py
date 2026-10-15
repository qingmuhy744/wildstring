"""Album identity, root isolation, ordering, pagination and upgrade behavior."""

import json
import shutil
import sqlite3
from pathlib import Path

from fastapi.testclient import TestClient
from mutagen.flac import FLAC

from wildstring.database import AUTH_SCHEMA, SCHEMA, Database
from wildstring.library.repository import LibraryRepository
from wildstring.library.scanner import scan_library
from wildstring.main import create_app

FIXTURES = Path(__file__).resolve().parents[2] / "tests/fixtures/audio"


def track(settings, name, album="共同专辑", album_artist=None, disc=1, number=1, title="测试曲"):
    path = settings.library_dir / name
    path.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(FIXTURES / "silence.flac", path)
    tags = FLAC(path)
    tags["album"] = album
    tags["title"] = title
    if "albumartist" in tags:
        del tags["albumartist"]
    if album_artist:
        tags["albumartist"] = album_artist
    tags["discnumber"] = str(disc)
    tags["tracknumber"] = str(number)
    tags.save()
    return path


def test_album_grouping_disc_order_and_literal_search(settings, authenticated_client):
    track(settings, "disc2/a.flac", album_artist="测试乐队", disc=2, number=1)
    track(settings, "disc1/b.flac", album_artist="测试乐队", disc=1, number=2, title="100%_测試")
    track(settings, "disc1/c.flac", album_artist="测试乐队", disc=1, number=1)
    track(settings, "different/a.flac", album_artist="另一乐队")
    scan_library(settings)
    store = LibraryRepository(Database(settings.data_dir), settings.library_dir)
    with authenticated_client(settings) as client:
        response = client.get("/api/v1/albums?limit=1").json()
        assert response["total"] == 2 and len(response["items"]) == 1
        assert len(client.get("/api/v1/albums?offset=1&limit=1").json()["items"]) == 1
        album = client.get("/api/v1/albums", params={"q": "%_"}).json()["items"][0]
        assert album["track_count"] == 3 and album["artists"] == ["测试乐队"]
        assert client.get(f"/api/v1/albums/{album['id']}").json()["id"] == album["id"]
        page = client.get(f"/api/v1/albums/{album['id']}/tracks").json()
        assert [(t["disc_number"], t["track_number"]) for t in page["items"]] == [
            (1, 1),
            (1, 2),
            (2, 1),
        ]
        assert all(t["album_id"] == album["id"] for t in page["items"])
        assert store.track(album["cover_track_id"]) is not None
        assert client.get("/api/v1/albums?limit=101").status_code == 422
        assert client.get("/api/v1/albums?offset=-1").status_code == 422
        assert client.get("/api/v1/albums/missing/tracks").status_code == 404
    with TestClient(create_app(settings)) as client:
        for path in (
            "/api/v1/albums",
            "/api/v1/albums/missing",
            f"/api/v1/tracks/{album['cover_track_id']}/cover",
            f"/api/v1/tracks/{album['cover_track_id']}/lyrics",
        ):
            assert client.get(path).status_code == 401


def test_fallback_folders_empty_titles_missing_files_and_roots(
    settings, authenticated_client, tmp_path
):
    first = track(settings, "album-a/a.flac")
    track(settings, "album-a/b.flac")
    track(settings, "album-b/a.flac")
    track(settings, "unknown/a.flac", album="")
    scan_library(settings)
    store = LibraryRepository(Database(settings.data_dir), settings.library_dir)
    original = store.albums()["items"]
    assert len(original) == 3
    assert any(a["title"] == "未命名专辑" for a in original)
    scan_library(settings)
    assert [a["id"] for a in store.albums()["items"]] == [a["id"] for a in original]
    first.unlink()
    scan_library(settings)
    assert sum(a["track_count"] for a in store.albums()["items"]) == 3
    other = tmp_path / "other"
    other.mkdir()
    assert LibraryRepository(Database(settings.data_dir), other).albums()["total"] == 0


def test_v2_migration_keeps_track_ids_and_auth_data(settings):
    settings.data_dir.mkdir()
    database = Database(settings.data_dir)
    with sqlite3.connect(database.path) as connection:
        connection.executescript(SCHEMA)
        connection.executescript(AUTH_SCHEMA)
        connection.execute("INSERT INTO libraries VALUES ('library', '/music')")
        connection.execute(
            "INSERT INTO scan_runs VALUES ('run', 'library', 'completed', 'now', 'now', '{}')"
        )
        values = (
            "track",
            "library",
            "disc1/a.flac",
            "歌曲",
            "tag",
            json.dumps(["艺人"]),
            "专辑",
            json.dumps(["艺人"]),
            1,
            1,
            1000,
            "flac",
            44100,
            2,
            0,
            100,
            1,
            "available",
            "run",
            "search",
        )
        connection.execute(
            "INSERT INTO tracks VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", values
        )
        connection.execute("INSERT INTO admin VALUES (1, 'existing-hash')")
        connection.execute("INSERT INTO sessions VALUES ('existing-token-hash', 9999999999)")
    database.initialize()
    database.initialize()
    with database.connect() as connection:
        row = connection.execute("SELECT id, album_id FROM tracks").fetchone()
        assert row["id"] == "track" and len(row["album_id"]) == 64
        assert (
            connection.execute("SELECT password_hash FROM users WHERE id='admin'").fetchone()[0]
            == "existing-hash"
        )
        assert (
            connection.execute("SELECT token_hash FROM sessions").fetchone()[0]
            == "existing-token-hash"
        )
