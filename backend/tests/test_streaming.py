"""Validate real byte ranges and safe source access, including changed/missing audio."""

import hashlib
import os
import shutil
from contextlib import contextmanager
from pathlib import Path

import anyio
import pytest
from fastapi import Request
from fastapi.testclient import TestClient
from starlette.requests import ClientDisconnect

from wildstring.database import Database
from wildstring.library import streaming
from wildstring.library.repository import LibraryRepository
from wildstring.library.scanner import scan_library
from wildstring.main import create_app

FIXTURES = Path(__file__).resolve().parents[2] / "tests/fixtures/audio"


def prepare(settings, suffix="mp3"):
    path = settings.music_dir / f"測試.{suffix}"
    shutil.copyfile(FIXTURES / f"silence.{suffix}", path)
    scan_library(settings)
    store = LibraryRepository(Database(settings.data_dir), settings.music_dir)
    track = store.tracks()["items"][0]
    return path, f"/api/v1/tracks/{track['id']}/stream", track["id"]


@pytest.mark.parametrize(
    ("suffix", "mime"), [("mp3", "audio/mpeg"), ("flac", "audio/flac"), ("m4a", "audio/mp4")]
)
def test_full_head_ranges_and_readonly(settings, authenticated_client, suffix, mime):
    path, url, _ = prepare(settings, suffix)
    expected = path.read_bytes()
    before = hashlib.sha256(expected).hexdigest()
    with TestClient(create_app(settings)) as anonymous:
        assert anonymous.get(url, headers={"Range": "bytes=0-9"}).status_code == 401
    with authenticated_client(settings) as client:
        full = client.get(url)
        assert full.status_code == 200 and full.content == expected
        assert full.headers["content-type"] == mime
        assert full.headers["accept-ranges"] == "bytes"
        assert full.headers["cache-control"] == "private, no-store"
        head = client.head(url, headers={"Range": "bytes=10-19"})
        assert head.status_code == 200 and head.content == b""
        assert int(head.headers["content-length"]) == len(expected)
        cases = [
            ("bytes=0-9", expected[:10]),
            ("bytes=10-", expected[10:]),
            ("bytes=-10", expected[-10:]),
            ("bytes=5-9999999", expected[5:]),
        ]
        for header, content in cases:
            response = client.get(url, headers={"Range": header})
            assert response.status_code == 206
            assert response.content == content
            assert int(response.headers["content-length"]) == len(content)
            assert response.headers["content-range"].endswith(f"/{len(expected)}")
        for header in (
            "bytes=999999-",
            "bytes=9-1",
            "bytes=-0",
            "bytes=abc-def",
            "bytes=-",
            "bytes=" + "9" * 5000 + "-",
        ):
            response = client.get(url, headers={"Range": header})
            assert response.status_code == 416
            assert response.headers["content-range"] == f"bytes */{len(expected)}"
        assert client.get(url, headers={"Range": "bytes=0-9,20-29"}).content == expected
        assert (
            client.get(url, headers={"Range": "bytes=0-9", "If-Range": '"old-etag"'}).status_code
            == 200
        )
        for validator in (full.headers["etag"], full.headers["last-modified"]):
            assert (
                client.get(url, headers={"Range": "bytes=0-9", "If-Range": validator}).status_code
                == 206
            )
        assert client.get("/api/v1/tracks/missing/stream").status_code == 404
    assert hashlib.sha256(path.read_bytes()).hexdigest() == before


def test_disconnected_client_closes_the_open_audio_descriptor(settings, monkeypatch):
    _, url, track_id = prepare(settings)
    record = LibraryRepository(Database(settings.data_dir), settings.music_dir).source(track_id)
    opened = []
    original = streaming.open_source

    @contextmanager
    def tracked(root, path):
        with original(root, path) as source:
            opened.append(source)
            yield source

    monkeypatch.setattr(streaming, "open_source", tracked)

    async def request():
        scope = {
            "type": "http",
            "method": "GET",
            "path": url,
            "headers": [],
            "asgi": {"spec_version": "2.4"},
        }

        async def send(message):
            if message["type"] == "http.response.body":
                raise OSError("Simulated disconnect")

        async def receive():
            return {"type": "http.disconnect"}

        response = streaming.AudioResponse(settings.music_dir, record, Request(scope))
        with pytest.raises(ClientDisconnect):
            await response(scope, receive, send)

    anyio.run(request)
    assert len(opened) == 1 and opened[0].closed


def test_changed_missing_and_rescanned_audio(settings, authenticated_client):
    path, url, _ = prepare(settings)
    with authenticated_client(settings) as client:
        os.utime(path, ns=(path.stat().st_atime_ns, path.stat().st_mtime_ns + 1_000_000))
        assert client.get(url).status_code == 409
        scan_library(settings)
        assert client.get(url).status_code == 200
        path.unlink()
        assert client.get(url).status_code == 404
        scan_library(settings)
        assert client.get(url).status_code == 409


def test_symlink_substitution_and_invalid_database_path_are_blocked(
    settings, authenticated_client, tmp_path
):
    path, url, track_id = prepare(settings)
    outside = tmp_path / "private.mp3"
    outside.write_bytes(path.read_bytes())
    path.unlink()
    path.symlink_to(outside)
    with authenticated_client(settings) as client:
        assert client.get(url).status_code == 409
        database = Database(settings.data_dir)
        for malicious in (str(outside), "../private.mp3"):
            with database.connect(write=True) as connection:
                connection.execute("UPDATE tracks SET path = ? WHERE id = ?", (malicious, track_id))
            assert client.get(url).status_code == 409
