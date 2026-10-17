"""Fingerprint identification, explicit refresh, source priority and source preservation."""

import gzip
import hashlib
import json
import shutil
import stat
from threading import Event
from urllib.parse import parse_qs

import pytest
from mutagen.flac import FLAC
from test_assets import FIXTURES
from test_personal_library import music
from test_providers import HEADERS, RECORDING, enable

from wildstring.database import SCHEMA_VERSION, Database
from wildstring.fingerprints import FingerprintError, calculate
from wildstring.library.repository import LibraryRepository
from wildstring.library.scanner import scan_library
from wildstring.providers import ACOUSTID, MB, ProviderError, missing_fields

ACOUSTID_ID = "20e0bf46-e541-4bbc-b349-956f9517110c"
OTHER = "84050a90-c8cc-40d4-809d-c91dbe167805"
KEY = "fixture-acoustid-key"


def test_private_key_compressed_post_and_shared_proxy(settings, authenticated_client, monkeypatch):
    with authenticated_client(settings) as client:
        provider = client.app.state.providers
        provider.stop()
        provider.exit.clear()
        proxy = "http://fixture:proxy-password@127.0.0.1:7890"
        saved = enable(client, acoustid_api_key=KEY, proxy_mode="custom", proxy_url=proxy)
        assert saved.status_code == 200 and saved.json()["acoustid_configured"]
        assert KEY not in saved.text and "acoustid_api_key" not in saved.text
        assert stat.S_IMODE(provider.credentials.stat().st_mode) == 0o600
        seen = []

        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                pass

            def read(self, _limit):
                return b'{"status":"ok","results":[]}'

        class Opener:
            def open(self, request, timeout):
                assert request.full_url == ACOUSTID and request.get_method() == "POST"
                assert KEY not in request.full_url and timeout == 15
                assert request.get_header("Content-encoding") == "gzip"
                data = parse_qs(gzip.decompress(request.data).decode())
                assert data["client"] == [KEY]
                assert set(data) == {"client", "duration", "fingerprint", "meta", "format"}
                seen.append(data)
                return Response()

        def build(handler, *_args):
            assert handler.proxies == {"http": proxy, "https": proxy}
            return Opener()

        monkeypatch.setattr("wildstring.providers.build_opener", build)
        assert (
            provider.request(
                ACOUSTID, {"duration": 180, "fingerprint": "fixture", "meta": "recordingids"}
            )["results"]
            == []
        )
        assert len(seen) == 1
        # Persisting unrelated settings retains the credential, without echoing it.
        assert enable(client, priority=["lastfm", "musicbrainz"]).status_code == 200
        assert provider.secrets()["acoustid_api_key"] == KEY


def test_fingerprint_matches_ignore_wrong_tags_and_keep_provenance(
    settings, authenticated_client, monkeypatch
):
    path = music(settings, "错误歌名.flac", ["错误艺人"], [])
    audio = FLAC(path)
    audio["musicbrainz_trackid"] = OTHER
    audio["musicbrainz_albumid"] = OTHER
    audio.save()
    scan_library(settings)
    original = path.read_bytes()
    with authenticated_client(settings) as client:
        provider = client.app.state.providers
        provider.stop()
        provider.exit.clear()
        monkeypatch.setattr("wildstring.providers.shutil.which", lambda _: "/fixture/fpcalc")
        assert (
            enable(client, acoustid=True, acoustid_api_key=KEY, caa=False, lastfm=False).status_code
            == 200
        )
        track = client.get("/api/v1/tracks").json()["items"][0]
        monkeypatch.setattr(
            "wildstring.providers.calculate",
            lambda repo, identity, event: {"duration": 180, "fingerprint": "fixture-fingerprint"},
        )
        calls = []

        def cached(provider_name, key, url, parameters=None, **kwargs):
            calls.append(url)
            assert kwargs["force"]
            if url == ACOUSTID:
                return {
                    "status": "ok",
                    "results": [
                        {"id": ACOUSTID_ID, "score": 0.99, "recordings": [{"id": RECORDING}]},
                        {"id": ACOUSTID_ID, "score": 0.8, "recordings": [{"id": RECORDING}]},
                        {"id": ACOUSTID_ID, "score": 0.6, "recordings": [{"id": OTHER}]},
                        {"id": "invalid", "score": 1, "recordings": [{"id": OTHER}]},
                    ],
                }
            assert url == MB + "recording/" + RECORDING
            return {
                "id": RECORDING,
                "title": "识别后的歌名",
                "artist-credit": [{"artist": {"name": "正确艺人"}}],
                "releases": [{"id": ACOUSTID_ID, "title": "正确专辑"}],
            }

        provider.cached = cached
        result = client.post(
            "/api/v1/manage/providers/refresh",
            headers=HEADERS,
            json={"scope": "track", "id": track["id"], "mode": "all", "force": True},
        )
        assert result.status_code == 200 and result.json()["queued"] == 1
        provider.step()
        result = client.get(f"/api/v1/manage/providers/tracks/{track['id']}").json()
        assert result["jobs"][0]["status"] == "completed"
        candidate = result["suggestions"][0]
        assert candidate["fields"]["title"] == "识别后的歌名"
        assert candidate["fields"]["album"] == "正确专辑"
        assert candidate["match"] == {
            "method": "acoustid",
            "score": 0.99,
            "acoustid_id": ACOUSTID_ID,
        }
        assert candidate["source_url"].endswith(RECORDING)
        assert calls == [ACOUSTID, MB + "recording/" + RECORDING]
        assert client.get(f"/api/v1/tracks/{track['id']}").json()["title"] == "错误歌名.flac"
    assert path.read_bytes() == original


@pytest.mark.parametrize(
    "error",
    [FingerprintError("fingerprint_tool_missing"), ProviderError("acoustid_rejected", False)],
)
def test_failed_identification_falls_back_to_tags(
    settings, authenticated_client, monkeypatch, error
):
    music(settings, "本地歌名.flac", ["艺人"], [])
    scan_library(settings)
    with authenticated_client(settings) as client:
        provider = client.app.state.providers
        provider.stop()
        provider.exit.clear()
        monkeypatch.setattr("wildstring.providers.shutil.which", lambda _: "/fixture/fpcalc")
        assert (
            enable(client, acoustid=True, acoustid_api_key=KEY, lastfm=False, caa=False).status_code
            == 200
        )

        def fail(*_args, **_kwargs):
            raise error

        provider.identify = fail

        def cached(_provider, _key, url, *_args, **_kwargs):
            return (
                {"recordings": [{"id": RECORDING}]}
                if url == MB + "recording"
                else {"id": RECORDING, "title": "文字查询", "artist-credit": []}
            )

        provider.cached = cached
        suggestions, warnings = provider.suggestions(
            client.get("/api/v1/tracks").json()["items"][0]
        )
        assert suggestions[0][2]["title"] == "文字查询" and suggestions[0][4] == {}
        assert warnings == [error.code]


def test_manual_refresh_scopes_deduplicate_and_missing_mode_preserves_manual_values(
    settings, authenticated_client
):
    paths = [
        music(
            settings, f"歌曲{n}.flac", ["艺人"], [], album="专辑一" if n < 3 else "专辑二", number=n
        )
        for n in (1, 2, 3)
    ]
    scan_library(settings)
    originals = [p.read_bytes() for p in paths]
    with authenticated_client(settings) as client:
        provider = client.app.state.providers
        provider.stop()
        provider.exit.clear()
        assert (
            client.post(
                "/api/v1/manage/providers/refresh", headers=HEADERS, json={"scope": "library"}
            ).status_code
            == 409
        )
        enable(client)
        tracks = client.get("/api/v1/tracks").json()["items"]
        track = tracks[0]
        endpoint = f"/api/v1/manage/tracks/{track['id']}/metadata"
        record = client.get(endpoint).json()
        client.put(
            endpoint,
            headers=HEADERS,
            json={"version": record["version"], "overrides": {"composers": []}},
        )
        provider.suggestions = lambda *_args, **_kwargs: (
            [
                (
                    "musicbrainz",
                    "https://musicbrainz.org/recording/" + RECORDING,
                    {"title": "不能自动覆盖", "composers": ["候选作曲"], "lyricists": ["候选作词"]},
                    None,
                    {},
                )
            ],
            [],
        )
        result = client.post(
            "/api/v1/manage/providers/refresh",
            headers=HEADERS,
            json={"scope": "album", "id": track["album_id"]},
        )
        assert result.json() == {"queued": 2, "already_active": 0, "total": 2}
        assert client.post(
            "/api/v1/manage/providers/refresh", headers=HEADERS, json={"scope": "library"}
        ).json() == {"queued": 1, "already_active": 2, "total": 3}
        provider.step()
        provider.step()
        provider.step()
        result = client.get(f"/api/v1/manage/providers/tracks/{track['id']}").json()
        assert result["suggestions"][0]["fields"] == {"lyricists": ["候选作词"]}
        assert client.get(endpoint).json()["effective"]["composers"] == []
        assert client.get(endpoint).json()["effective"]["lyricists"] == []
        jobs = client.get("/api/v1/manage/providers/jobs").json()
        assert jobs["queued"] == jobs["running"] == 0 and len(jobs["items"]) == 3
        assert (
            client.post(
                "/api/v1/manage/providers/refresh",
                headers=HEADERS,
                json={"scope": "library", "id": "unexpected"},
            ).status_code
            == 422
        )
        assert (
            client.post(
                "/api/v1/manage/providers/refresh",
                headers=HEADERS,
                json={"scope": "album", "id": "missing"},
            ).status_code
            == 404
        )
    assert [p.read_bytes() for p in paths] == originals


def test_priority_changes_existing_candidate_order_and_validates_sources(
    settings, authenticated_client
):
    music(settings, "歌曲.flac", ["艺人"], [])
    scan_library(settings)
    with authenticated_client(settings) as client:
        provider = client.app.state.providers
        provider.stop()
        enable(client)
        track = client.get("/api/v1/tracks").json()["items"][0]
        provider.suggestions = lambda *_args, **_kwargs: (
            [
                (
                    "lastfm",
                    "https://www.last.fm/music/example",
                    {"description": "Last.fm"},
                    None,
                    {},
                ),
                (
                    "musicbrainz",
                    "https://musicbrainz.org/recording/" + RECORDING,
                    {"description": "MusicBrainz"},
                    None,
                    {},
                ),
            ],
            [],
        )
        provider.enqueue([track["id"]])
        provider.step()
        endpoint = f"/api/v1/manage/providers/tracks/{track['id']}"
        assert client.get(endpoint).json()["suggestions"][0]["provider"] == "musicbrainz"
        assert enable(client, priority=["lastfm", "musicbrainz"]).status_code == 200
        assert client.get(endpoint).json()["suggestions"][0]["provider"] == "lastfm"
        assert enable(client, priority=["lastfm", "lastfm"]).status_code == 422
        assert enable(client, priority=["acoustid", "lastfm"]).status_code == 422


def test_missing_external_ids_keep_existing_identity():
    track = {"external_ids": {"recording": RECORDING}}
    assert missing_fields(
        track, {}, {"external_ids": {"recording": RECORDING, "release": OTHER}}
    ) == {"external_ids": {"recording": RECORDING, "release": OTHER}}
    assert missing_fields(track, {}, {"external_ids": {"recording": OTHER, "release": OTHER}}) == {}
    assert missing_fields(track, {"external_ids": {}}, {"external_ids": {"release": OTHER}}) == {}


@pytest.mark.skipif(
    shutil.which("fpcalc") is None,
    reason="Chromaprint is installed in the production container and CI",
)
def test_real_fingerprint_is_read_only_cached_and_rejects_changed_file(settings, monkeypatch):
    path = settings.library_dir / "audio.flac"
    shutil.copyfile(FIXTURES / "lossless.flac", path)
    scan_library(settings)
    repo = LibraryRepository(Database(settings.data_dir), settings.library_dir)
    identity = repo.tracks()["items"][0]["id"]
    original = hashlib.sha256(path.read_bytes()).digest()
    first = calculate(repo, identity, Event())
    assert first["duration"] == 12 and len(first["fingerprint"]) > 10

    def unexpected(*_args, **_kwargs):
        raise AssertionError("Cached fingerprint must not decode the file again")

    monkeypatch.setattr("wildstring.fingerprints.subprocess.Popen", unexpected)
    assert calculate(repo, identity, Event()) == first
    assert hashlib.sha256(path.read_bytes()).digest() == original
    audio = FLAC(path)
    audio["title"] = "changed"
    audio.save()
    with pytest.raises(FingerprintError, match="fingerprint_source_changed"):
        calculate(repo, identity, Event())


def test_v12_upgrade_keeps_provider_settings_and_music(settings):
    music(settings, "持久曲目.flac", ["艺人"], [])
    scan_library(settings)
    database = Database(settings.data_dir)
    repo = LibraryRepository(database, settings.library_dir)
    identity = repo.tracks()["items"][0]["id"]
    with database.connect(write=True) as connection:
        connection.execute(
            "UPDATE provider_settings SET enabled=1,public_url='https://music.example.com'"
        )
        for table, column in (
            ("provider_settings", "acoustid"),
            ("provider_settings", "priority"),
            ("metadata_suggestions", "match"),
            ("provider_jobs", "refresh_mode"),
            ("provider_jobs", "force"),
        ):
            connection.execute(f"ALTER TABLE {table} DROP COLUMN {column}")
        connection.execute("PRAGMA user_version=12")
    database.initialize()
    with database.connect() as connection:
        assert connection.execute("PRAGMA user_version").fetchone()[0] == SCHEMA_VERSION
        config = dict(connection.execute("SELECT * FROM provider_settings").fetchone())
        assert config["enabled"] == 1 and config["public_url"] == "https://music.example.com"
        assert config["acoustid"] == 0 and json.loads(config["priority"]) == [
            "musicbrainz",
            "lastfm",
        ]
    assert repo.tracks()["items"][0]["id"] == identity


def test_refresh_and_provider_configuration_are_admin_only(settings, authenticated_client):
    from test_users import PASSWORD, new_user

    with authenticated_client(settings) as client:
        new_user(client)
        client.post("/api/v1/auth/logout", headers=HEADERS)
        assert (
            client.post(
                "/api/v1/auth/login",
                headers=HEADERS,
                json={"username": "listener", "password": PASSWORD},
            ).status_code
            == 200
        )
        assert client.get("/api/v1/manage/providers").status_code == 403
        assert client.get("/api/v1/manage/providers/jobs").status_code == 403
        assert (
            client.post(
                "/api/v1/manage/providers/refresh", headers=HEADERS, json={"scope": "library"}
            ).status_code
            == 403
        )


def test_fingerprint_timeout_kills_decoder_and_does_not_cache(settings, monkeypatch):
    path = settings.library_dir / "audio.flac"
    shutil.copyfile(FIXTURES / "lossless.flac", path)
    scan_library(settings)
    repo = LibraryRepository(Database(settings.data_dir), settings.library_dir)
    identity = repo.tracks()["items"][0]["id"]

    class Process:
        killed = False

        def poll(self):
            return -9 if self.killed else None

        def kill(self):
            self.killed = True

        def wait(self):
            return -9

    process = Process()
    monkeypatch.setattr("wildstring.fingerprints.shutil.which", lambda _: "/fixture/fpcalc")
    monkeypatch.setattr(
        "wildstring.fingerprints.subprocess.Popen", lambda *_args, **_kwargs: process
    )
    times = iter([0, 100])
    monkeypatch.setattr("wildstring.fingerprints.time.monotonic", lambda: next(times))
    with pytest.raises(FingerprintError, match="fingerprint_timeout"):
        calculate(repo, identity, Event())
    assert process.killed
    with repo.database.connect() as connection:
        assert connection.execute("SELECT count(*) FROM provider_cache").fetchone()[0] == 0


@pytest.mark.parametrize(
    ("code", "diagnostic", "payload", "accepted"),
    [
        (3, b"ERROR: Error decoding audio frame (End of file)\n", True, True),
        (3, b"ERROR: Error decoding audio frame (Invalid data)\n", True, False),
        (3, b"ERROR: Error decoding audio frame (End of file)\n", False, False),
        (2, b"ERROR: Error decoding audio frame (End of file)\n", True, False),
    ],
)
def test_debian_short_audio_eof_requires_exact_diagnostic_and_valid_fingerprint(
    settings, monkeypatch, code, diagnostic, payload, accepted
):
    path = settings.library_dir / "audio.flac"
    shutil.copyfile(FIXTURES / "lossless.flac", path)
    scan_library(settings)
    repo = LibraryRepository(Database(settings.data_dir), settings.library_dir)
    identity = repo.tracks()["items"][0]["id"]

    class Process:
        returncode = code

        def poll(self):
            return self.returncode

    expected = {"duration": 12, "fingerprint": "fixture-fingerprint"}

    def popen(*_args, **kwargs):
        kwargs["stdout"].write(json.dumps(expected if payload else {}).encode())
        kwargs["stderr"].write(diagnostic)
        return Process()

    monkeypatch.setattr("wildstring.fingerprints.shutil.which", lambda _: "/fixture/fpcalc")
    monkeypatch.setattr("wildstring.fingerprints.subprocess.Popen", popen)
    if accepted:
        assert calculate(repo, identity, Event()) == expected
    else:
        with pytest.raises(FingerprintError, match="fingerprint_failed"):
            calculate(repo, identity, Event())
        with repo.database.connect() as connection:
            assert connection.execute("SELECT count(*) FROM provider_cache").fetchone()[0] == 0
