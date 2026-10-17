"""Real tag reads and user-owned gain adjustments leave source PCM unchanged."""

import hashlib
import math

from mutagen.flac import FLAC
from test_personal_library import music
from test_providers import HEADERS

from wildstring.library.scanner import scan_library
from wildstring.providers import Providers


def test_tag_gain_manual_album_trim_versions_and_user_isolation(
    settings, authenticated_client, monkeypatch
):
    monkeypatch.setattr(Providers, "start", lambda self: None)
    path = music(settings, "响度.flac", ["合成乐队"], ["合成乐队"])
    tags = FLAC(path)
    tags["replaygain_track_gain"] = "-8.00 dB"
    tags["replaygain_album_gain"] = "-5.00 dB"
    tags["replaygain_track_peak"] = "0.95"
    tags["replaygain_album_peak"] = "1.0"
    tags.save()
    original = hashlib.sha256(path.read_bytes()).digest()
    scan_library(settings)
    with authenticated_client(settings) as client:
        track = client.get("/api/v1/tracks").json()["items"][0]
        endpoint = f"/api/v1/tracks/{track['id']}/playback-gain"
        value = client.get(endpoint).json()
        assert value["factor"] == 1 and value["tags"]["track_gain"] == -8
        assert (
            client.put(
                "/api/v1/playback/gain-settings",
                headers=HEADERS,
                json={"version": 0, "mode": "album"},
            ).status_code
            == 200
        )
        assert math.isclose(client.get(endpoint).json()["factor"], 10 ** (-5 / 20))
        value = client.put(
            endpoint, headers=HEADERS, json={"version": 0, "scope": "album", "gain_db": 3}
        )
        assert value.status_code == 200 and math.isclose(value.json()["applied_db"], -2)
        value = client.put(
            endpoint, headers=HEADERS, json={"version": 0, "scope": "track", "gain_db": -1}
        )
        assert value.status_code == 200 and math.isclose(value.json()["applied_db"], -3)
        assert (
            client.put(
                endpoint, headers=HEADERS, json={"version": 0, "scope": "track", "gain_db": 0}
            ).status_code
            == 409
        )
        assert (
            client.put(
                endpoint, headers=HEADERS, json={"version": 1, "scope": "track", "gain_db": 20}
            ).status_code
            == 422
        )
        loudness = client.app.state.providers.loudness
        assert loudness.detail("another-user", track["id"])["factor"] == 1
        assert hashlib.sha256(path.read_bytes()).digest() == original


def test_unknown_peak_does_not_amplify_without_opt_out(settings, authenticated_client, monkeypatch):
    monkeypatch.setattr(Providers, "start", lambda self: None)
    music(settings, "未知峰值.flac", ["合成乐队"], ["合成乐队"])
    scan_library(settings)
    with authenticated_client(settings) as client:
        track = client.get("/api/v1/tracks").json()["items"][0]
        endpoint = f"/api/v1/tracks/{track['id']}/playback-gain"
        value = client.put(
            endpoint, headers=HEADERS, json={"version": 0, "scope": "track", "gain_db": 6}
        ).json()
        assert value["factor"] == 1 and value["limited"] and not value["peak_known"]
        assert (
            client.put(
                "/api/v1/playback/gain-settings",
                headers=HEADERS,
                json={"version": 0, "prevent_clipping": False},
            ).status_code
            == 200
        )
        assert math.isclose(client.get(endpoint).json()["factor"], 10 ** (6 / 20))


def test_explicit_ffmpeg_analysis_is_read_only(settings, authenticated_client, monkeypatch):
    import shutil

    import pytest

    if not shutil.which("ffmpeg"):
        pytest.skip("FFmpeg integration runs in the container test image")
    monkeypatch.setattr(Providers, "start", lambda self: None)
    path = music(settings, "合成响度.flac", ["合成乐队"], ["合成乐队"])
    import subprocess

    # The shared playback fixture is deliberate silence; generate an audible analysis signal.
    subprocess.run(
        [
            shutil.which("ffmpeg"),
            "-nostdin",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=997:duration=3:sample_rate=48000",
            "-af",
            "volume=0.2",
            "-c:a",
            "flac",
            "-y",
            str(path),
        ],
        check=True,
        capture_output=True,
        timeout=15,
    )
    target = path
    original = hashlib.sha256(target.read_bytes()).digest()
    scan_library(settings)
    with authenticated_client(settings) as client:
        track = client.get("/api/v1/tracks").json()["items"][0]
        endpoint = f"/api/v1/manage/tracks/{track['id']}/analyze-loudness"
        assert client.post(endpoint, headers=HEADERS).status_code == 200
        loudness = client.app.state.providers.loudness
        assert loudness.step()
        value = loudness.detail("fixture-user", track["id"])
        assert value["analysis"]["status"] == "completed", value
        assert value["peak_known"] and 0 < value["tags"]["track_peak"] <= 1
        assert 2 <= value["tags"]["track_gain"] <= 30
        assert hashlib.sha256(target.read_bytes()).digest() == original
