"""Real AAC encoding, passthrough, seek offsets and protected reusable caches."""

import hashlib
import json
import os
import shutil
import subprocess
import threading
import time
from pathlib import Path

import anyio
import pytest
from fastapi import HTTPException, Request
from starlette.requests import ClientDisconnect

from wildstring.database import Database
from wildstring.library.scanner import scan_library
from wildstring.library.transcoding import MIB

FIXTURES = Path(__file__).resolve().parents[2] / "tests/fixtures/audio"
HEADERS = {"X-Wildstring-Client": "web"}
HAS_FFMPEG = bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))
real_audio = pytest.mark.skipif(not HAS_FFMPEG, reason="FFmpeg available in make docker-test")


def prepare(settings, suffix="flac"):
    path = settings.library_dir / f"test.{suffix}"
    shutil.copyfile(FIXTURES / f"silence.{suffix}", path)
    scan_library(settings)
    with Database(settings.data_dir).connect() as connection:
        track = connection.execute("SELECT id FROM tracks WHERE path=?", (path.name,)).fetchone()[0]
    return path, f"/api/v1/tracks/{track}", track


def tone(settings, codec="flac", channels=2):
    path = settings.library_dir / ("tone.flac" if codec == "flac" else "tone.m4a")
    subprocess.run(
        [
            shutil.which("ffmpeg"),
            "-nostdin",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=6:sample_rate=96000",
            "-ac",
            str(channels),
            "-c:a",
            codec,
            "-y",
            str(path),
        ],
        check=True,
        capture_output=True,
        timeout=15,
    )
    scan_library(settings)
    with Database(settings.data_dir).connect() as connection:
        track = connection.execute("SELECT id FROM tracks WHERE path=?", (path.name,)).fetchone()[0]
    return path, f"/api/v1/tracks/{track}", track


def probe(path):
    result = subprocess.run(
        [
            shutil.which("ffprobe"),
            "-v",
            "error",
            "-select_streams",
            "a:0",
            "-show_entries",
            "stream=codec_name,sample_rate,channels,duration",
            "-of",
            "json",
            str(path),
        ],
        check=True,
        capture_output=True,
        timeout=15,
    )
    return json.loads(result.stdout)["streams"][0]


def wait(entry):
    assert entry.done.wait(15), "encoder did not stop"
    assert entry.error is None


def test_opt_in_validation_authentication_and_unavailable_encoder(
    settings, authenticated_client, monkeypatch
):
    path, url, _ = prepare(settings)
    with authenticated_client(settings) as client:
        assert client.get(url + "/stream").content == path.read_bytes()
        for query in (
            "format=aac",
            "bitrate_kbps=320",
            "start_ms=1",
            "format=mp3&bitrate_kbps=320",
            "format=aac&bitrate_kbps=64",
            "format=aac&bitrate_kbps=320&start_ms=-1",
        ):
            assert client.get(url + "/playback?" + query).status_code == 422
        plan = client.get(url + "/playback?format=aac&bitrate_kbps=320").json()
        assert plan["mode"] == "transcode" and plan["source"]["codec"] == "flac"
        assert not list(client.app.state.transcoding.root.glob("*.part"))
        monkeypatch.setattr("wildstring.library.transcoding.shutil.which", lambda _: None)
        head = client.head(plan["stream_url"])
        assert head.status_code == 200 and "content-length" not in head.headers  # no encoding
        response = client.get(plan["stream_url"])
        assert response.status_code == 503 and response.json()["detail"] == "ffmpeg_unavailable"
        client.cookies.clear()
        assert client.get(plan["stream_url"]).status_code == 401


@pytest.mark.parametrize("suffix", ["mp3", "m4a"])
def test_lossy_never_reencoded_or_upscaled(settings, authenticated_client, monkeypatch, suffix):
    path, url, _ = prepare(settings, suffix)
    with authenticated_client(settings) as client:
        monkeypatch.setattr(
            "wildstring.library.transcoding.subprocess.Popen",
            lambda *a, **k: pytest.fail("lossy encoded"),
        )
        for rate in (128, 192, 256, 320):
            plan = client.get(url + f"/playback?format=aac&bitrate_kbps={rate}&start_ms=100").json()
            assert plan["mode"] == "original" and plan["reason"] == "lossy_passthrough"
            assert plan["source"]["codec"] == ("aac" if suffix == "m4a" else "mp3")
            assert plan["start_ms"] == 0 and plan["cache_state"] == "none"
            response = client.get(
                url + f"/stream?format=aac&bitrate_kbps={rate}", headers={"Range": "bytes=0-99"}
            )
            assert response.status_code == 206 and response.content == path.read_bytes()[:100]
            assert response.headers["x-wildstring-playback"] == "original"


@real_audio
@pytest.mark.parametrize("rate", [128, 192, 256, 320])
def test_actual_aac_rates_cache_ranges_and_source_change(
    settings, authenticated_client, tmp_path, rate
):
    path, url, track = tone(settings)
    original = hashlib.sha256(path.read_bytes()).hexdigest()
    with authenticated_client(settings) as client:
        service = client.app.state.transcoding
        query = f"?format=aac&bitrate_kbps={rate}"
        planned = client.get(url + "/playback" + query).json()
        assert planned["output"]["bitrate_kbps"] == rate
        response = client.get(url + "/stream" + query)
        assert response.status_code == 200 and response.headers["content-type"] == "audio/mp4"
        output = tmp_path / "out.m4a"
        output.write_bytes(response.content)
        encoded = probe(output)
        assert encoded["codec_name"] == "aac" and encoded["sample_rate"] == "48000"
        assert encoded["channels"] == 2 and abs(float(encoded["duration"]) - 6) < 0.1
        wait(service.entries[service.plan(track, "aac", rate).key])
        hit = client.get(url + "/stream" + query, headers={"Range": "bytes=20-99"})
        assert hit.status_code == 206 and hit.content == response.content[20:100]
        assert hit.headers["x-wildstring-cache"] == "hit"
        assert hit.headers["accept-ranges"] == "bytes"
        assert client.head(url + "/stream" + query).headers["accept-ranges"] == "bytes"
        first = service.plan(track, "aac", rate).key
        os.utime(path, ns=(path.stat().st_atime_ns, path.stat().st_mtime_ns + 1000000))
        assert client.get(url + "/stream" + query).status_code == 409
        scan_library(settings)
        assert service.plan(track, "aac", rate).key != first
    assert hashlib.sha256(path.read_bytes()).hexdigest() == original


@real_audio
@pytest.mark.parametrize(("codec", "channels", "rate"), [("alac", 2, 320), ("flac", 1, 256)])
def test_actual_codec_and_seek_tail(
    settings, authenticated_client, tmp_path, codec, channels, rate
):
    _, url, _ = tone(settings, codec, channels)
    with authenticated_client(settings) as client:
        query = "?format=aac&bitrate_kbps=320&start_ms=3000"
        planned = client.get(url + "/playback" + query).json()
        assert planned["source"]["codec"] == codec and planned["source"]["lossless"]
        assert planned["output"]["bitrate_kbps"] == rate
        assert planned["start_ms"] == 3000 and planned["duration_ms"] == 6000
        response = client.get(planned["stream_url"])
        assert response.status_code == 200
        output = tmp_path / "tail.m4a"
        output.write_bytes(response.content)
        encoded = probe(output)
        assert abs(float(encoded["duration"]) - 3) < 0.1
        assert encoded["channels"] == channels
        assert (
            client.get(url + "/playback?format=aac&bitrate_kbps=320&start_ms=6000").status_code
            == 416
        )


@real_audio
def test_cold_stream_disconnect_releases_reader_and_finishes_cache(
    settings, authenticated_client, monkeypatch
):
    _, url, track = tone(settings)
    with authenticated_client(settings) as client:
        service = client.app.state.transcoding
        gate = threading.Event()
        verify = service.verify

        def gated(entry):
            assert gate.wait(10)
            verify(entry)

        monkeypatch.setattr(service, "verify", gated)
        plan = service.plan(track, "aac", 192)
        scope = {
            "type": "http",
            "method": "GET",
            "path": url + "/stream",
            "headers": [(b"range", b"bytes=0-99")],
            "asgi": {"spec_version": "2.4"},
        }
        messages = []

        async def run():
            async def send(message):
                messages.append(message)
                if message["type"] == "http.response.body":
                    raise OSError("disconnected")

            async def receive():
                return {"type": "http.disconnect"}

            with pytest.raises(ClientDisconnect):
                await service.response(plan, Request(scope))(scope, receive, send)

        try:
            anyio.run(run)
            assert messages[0]["status"] == 200
            headers = dict(messages[0]["headers"])
            assert headers[b"accept-ranges"] == b"none" and b"content-range" not in headers
            entry = service.entries[plan.key]
            assert entry.readers == 0 and not entry.complete
        finally:
            gate.set()
        wait(entry)
        assert (
            client.get(url + "/playback?format=aac&bitrate_kbps=192").json()["cache_state"] == "hit"
        )


@real_audio
def test_concurrency_dedup_and_clear_defers_active_readers(
    settings, authenticated_client, monkeypatch
):
    _, url, track = tone(settings)
    with authenticated_client(settings) as client:
        service = client.app.state.transcoding
        gate = threading.Event()
        verify = service.verify

        def gated(entry):
            assert gate.wait(10)
            verify(entry)

        monkeypatch.setattr(service, "verify", gated)
        settings_body = client.get("/api/v1/manage/transcoding").json()
        body = {
            key: settings_body[key]
            for key in ("version", "retention_days", "max_size_mb", "max_concurrent")
        }
        body["max_concurrent"] = 1
        assert (
            client.put("/api/v1/manage/transcoding", json=body, headers=HEADERS).status_code == 200
        )
        plan = service.plan(track, "aac", 128)
        entry = service.acquire(plan)
        same = service.acquire(plan)
        assert same is entry and entry.readers == 2
        try:
            with pytest.raises(HTTPException) as error:
                service.acquire(service.plan(track, "aac", 320))
            assert error.value.status_code == 429
            monkeypatch.setattr("wildstring.library.transcoding.SLOT_WAIT_SECONDS", 0.01)
            assert client.get(url + "/stream?format=aac&bitrate_kbps=320").status_code == 429
            clear = client.delete("/api/v1/manage/transcoding/cache", headers=HEADERS).json()
            assert clear["deferred"] == 1 and entry.purge
            assert service.plan(track, "aac", 128).key != plan.key
            assert entry not in service.entries.values()
        finally:
            gate.set()
        wait(entry)
        assert entry.path.exists()
        service.release(entry)
        assert entry.path.exists()
        service.release(entry)
        assert not entry.path.exists() and service.overview()["cache_bytes"] == 0
        assert client.get(url + "/stream?format=aac&bitrate_kbps=128").status_code == 200


@real_audio
def test_expiry_lru_disk_limit_restart_and_permission(settings, authenticated_client, monkeypatch):
    _, url, track = tone(settings)
    with authenticated_client(settings) as client:
        service = client.app.state.transcoding
        assert client.get(url + "/stream?format=aac&bitrate_kbps=128").status_code == 200
        plan = service.plan(track, "aac", 128)
        wait(service.entries[plan.key])
        cache_path = service.entries[plan.key].path
    # Persistent completed cache survives restart without an encoder process.
    with authenticated_client(settings) as client:
        service = client.app.state.transcoding
        assert (
            client.get(
                url + "/stream?format=aac&bitrate_kbps=128", headers={"Range": "bytes=-20"}
            ).status_code
            == 206
        )
        assert service.overview()["active_jobs"] == 0
        with service.database.connect(write=True) as connection:
            connection.execute(
                "UPDATE transcoding_cache SET accessed_at=?", (time.time() - 8 * 86400,)
            )
        service.cleanup()
        assert not cache_path.exists() and service.overview()["cache_entries"] == 0
        # Simulate LRU pressure with inert cache files; no source/library file is touched.
        for index in range(2):
            path = service.root / f"inert-{index}.m4a"
            path.write_bytes(b"x")
            with service.database.connect(write=True) as connection:
                connection.execute(
                    "INSERT INTO transcoding_cache VALUES (?,?,?,?,?)",
                    (f"key-{index}", path.name, track, 10 * MIB, time.time() + index),
                )
        with service.database.connect(write=True) as connection:
            connection.execute("UPDATE transcoding_settings SET max_size_mb=16")
        assert service.cleanup()["removed"] == 1
        assert (
            not (service.root / "inert-0.m4a").exists() and (service.root / "inert-1.m4a").exists()
        )
        service.cleanup(clear=True)
        monkeypatch.setattr(
            "wildstring.library.transcoding.shutil.disk_usage",
            lambda _: type("Disk", (), {"free": 0})(),
        )
        assert client.get(url + "/stream?format=aac&bitrate_kbps=128").status_code == 503
        assert not list(service.root.glob("*.part"))
        assert (
            client.post(
                "/api/v1/manage/users",
                json={"username": "listener", "password": "a-disposable-password", "role": "user"},
                headers=HEADERS,
            ).status_code
            == 201
        )
        client.post("/api/v1/auth/logout", headers=HEADERS)
        client.post(
            "/api/v1/auth/login",
            json={"username": "listener", "password": "a-disposable-password"},
            headers=HEADERS,
        )
        assert client.get("/api/v1/manage/transcoding").status_code == 403
        assert client.delete("/api/v1/manage/transcoding/cache", headers=HEADERS).status_code == 403


def test_progressive_reader_does_not_drop_final_write_after_temporary_eof(
    settings, authenticated_client, monkeypatch
):
    from wildstring.library.transcoding import AACResponse, Entry

    prepare(settings)
    with authenticated_client(settings) as client:
        service = client.app.state.transcoding
        path = service.root / "race.part"
        path.write_bytes(b"first")
        entry = Entry("race", path, service.root / "race.m4a", readers=1)
        entry.ready.set()
        real_run = anyio.to_thread.run_sync

        async def race(function, *args, **kwargs):
            result = await real_run(function, *args, **kwargs)
            if (
                getattr(function, "__name__", "") == "read"
                and result == b""
                and not entry.done.is_set()
            ):
                with path.open("ab") as output:
                    output.write(b"last")
                entry.done.set()
            return result

        monkeypatch.setattr(anyio.to_thread, "run_sync", race)
        scope = {
            "type": "http",
            "method": "GET",
            "path": "/audio",
            "headers": [],
            "asgi": {"spec_version": "2.4"},
        }
        bodies = []

        async def run():
            async def send(message):
                if message["type"] == "http.response.body":
                    bodies.append(message["body"])

            async def receive():
                return {"type": "http.disconnect"}

            await AACResponse(service, entry, Request(scope), {})(scope, receive, send)

        anyio.run(run)
        assert b"".join(bodies) == b"firstlast" and entry.readers == 0
