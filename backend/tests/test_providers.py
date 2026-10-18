"""Versioned suggestions, account consent and outbound isolation regressions."""

import hashlib
import json
import logging
import stat
import time
from uuid import uuid4

import pytest
from mutagen.flac import FLAC
from mutagen.id3 import TCOM, TEXT, TIPL, TPE1, TRCK, TXXX
from mutagen.mp3 import MP3
from test_assets import image, put_picture
from test_personal_library import music

from wildstring.database import Database
from wildstring.library.assets import TrackAssets
from wildstring.library.metadata import read_metadata
from wildstring.library.repository import LibraryRepository
from wildstring.library.scanner import scan_library
from wildstring.providers import ProviderError, SafeRedirect, lastfm_signature
from wildstring.request_privacy import RedactLastfmCallback

HEADERS = {"X-Wildstring-Client": "web"}
RECORDING = "12029af2-f6fb-4423-b145-5ee157714ed4"


def enable(client, **changes):
    settings = client.get("/api/v1/manage/providers").json()
    for key in (
        "lastfm_configured",
        "proxy_configured",
        "environment_proxy_configured",
        "acoustid_configured",
        "fingerprint_available",
    ):
        settings.pop(key)
    return client.put(
        "/api/v1/manage/providers", headers=HEADERS, json=settings | {"enabled": True} | changes
    )


def test_multivalue_roles_dates_and_rescan(settings, authenticated_client):
    path = music(settings, "合作.flac", ["甲", "乙"], ["甲"])
    tags = FLAC(path)
    tags["composer"], tags["lyricist"], tags["arranger"] = ["甲", "丙"], ["丁"], ["丙"]
    tags["tracknumber"], tags["disctotal"], tags["date"] = "2/12", "2", "2024-02"
    tags["musicbrainz_trackid"] = RECORDING
    tags.save()
    digest = hashlib.sha256(path.read_bytes()).digest()
    scan_library(settings)
    with authenticated_client(settings) as client:
        track = client.get("/api/v1/tracks").json()["items"][0]
        assert track["artists"] == ["甲", "乙"] and track["vocalists"] == []
        assert track["composers"] == ["甲", "丙"] and track["track_total"] == 12
        assert track["release_date"] == "2024-02" and track["disc_total"] == 2
        assert track["external_ids"]["recording"] == RECORDING
        people = client.get("/api/v1/artists?role=composer").json()["items"]
        assert {p["name"] for p in people} == {"甲", "丙"}
        assert all(p["track_count"] == 1 for p in people)
        assert client.get("/api/v1/artists?role=vocalist").json()["total"] == 0
        endpoint = f"/api/v1/manage/tracks/{track['id']}/metadata"
        record = client.get(endpoint).json()
        assert (
            client.put(
                endpoint,
                headers=HEADERS,
                json={"version": record["version"], "overrides": {"lyricists": ["人工"]}},
            ).status_code
            == 200
        )
        scan_library(settings, full=True)
        assert client.get(f"/api/v1/tracks/{track['id']}").json()["lyricists"] == ["人工"]
        assert client.get(endpoint).json()["origins"]["lyricists"] == "manual"
    assert hashlib.sha256(path.read_bytes()).digest() == digest


def test_picard_id3_arrays_not_arbitrary_slashes(settings):
    import shutil

    from test_assets import FIXTURES

    path = settings.library_dir / "tags.mp3"
    shutil.copyfile(FIXTURES / "silence.mp3", path)
    audio = MP3(path)
    audio.tags.add(TPE1(encoding=3, text=["AC/DC", "甲 feat. 乙"]))
    audio.tags.add(TXXX(encoding=3, desc="Artists", text=["AC/DC", "甲", "乙"]))
    audio.tags.add(TCOM(encoding=3, text=["作曲甲", "作曲乙"]))
    audio.tags.add(TEXT(encoding=3, text=["作词"]))
    audio.tags.add(TIPL(encoding=3, people=[["arranger", "编曲"]]))
    audio.tags.add(TRCK(encoding=3, text=["3/10"]))
    audio.save(v2_version=4)
    with path.open("rb") as stream:
        metadata = read_metadata(stream, path)
    assert metadata.artists == ["AC/DC", "甲", "乙"]
    assert metadata.details["composers"] == ["作曲甲", "作曲乙"]
    assert metadata.details["arrangers"] == ["编曲"]
    assert metadata.details["track_total"] == 10


def test_suggestions_are_explicit_versioned_and_keep_user_data(settings, authenticated_client):
    path = music(settings, "旧名.flac", ["艺人"], ["艺人"])
    scan_library(settings)
    original = path.read_bytes()
    with authenticated_client(settings) as client:
        providers = client.app.state.providers
        providers.stop()
        assert enable(client).status_code == 200
        track = client.get("/api/v1/tracks").json()["items"][0]
        providers.suggestions = lambda _, **_kwargs: (
            [
                (
                    "musicbrainz",
                    "https://musicbrainz.org/recording/" + RECORDING,
                    {"title": "新名", "composers": ["作者"]},
                    None,
                    {},
                )
            ],
            [],
        )
        assert (
            client.post(
                "/api/v1/manage/providers/query", headers=HEADERS, json={"track_ids": [track["id"]]}
            ).status_code
            == 200
        )
        providers.step()
        endpoint = f"/api/v1/manage/providers/tracks/{track['id']}"
        result = client.get(endpoint).json()
        candidate = result["suggestions"][0]
        assert client.get(f"/api/v1/tracks/{track['id']}").json()["title"] == "旧名.flac"
        apply = f"/api/v1/manage/providers/suggestions/{candidate['id']}/apply"
        response = client.post(
            apply,
            headers=HEADERS,
            json={"version": candidate["metadata_version"], "fields": ["composers"]},
        )
        assert response.status_code == 200, response.text
        assert response.json()["effective"]["title"] == "旧名.flac"
        assert response.json()["effective"]["composers"] == ["作者"]
        assert response.json()["origins"]["composers"].startswith("musicbrainz:")
        assert (
            client.post(
                apply,
                headers=HEADERS,
                json={"version": candidate["metadata_version"], "fields": ["title"]},
            ).status_code
            == 404
        )
        providers.enqueue([track["id"]])
        providers.step()
        candidate = client.get(endpoint).json()["suggestions"][0]
        metadata = f"/api/v1/manage/tracks/{track['id']}/metadata"
        version = client.get(metadata).json()["version"]
        client.put(
            metadata, headers=HEADERS, json={"version": version, "overrides": {"title": "手动"}}
        )
        assert (
            client.post(
                f"/api/v1/manage/providers/suggestions/{candidate['id']}/apply",
                headers=HEADERS,
                json={"version": candidate["metadata_version"], "fields": ["title"]},
            ).status_code
            == 409
        )
    assert path.read_bytes() == original


def test_proxy_is_private_optional_and_shared_by_outgoing_requests(
    settings, authenticated_client, monkeypatch
):
    with authenticated_client(settings) as client:
        providers = client.app.state.providers
        providers.stop()
        providers.exit.clear()
        proxy = "http://test-user:test-pass@127.0.0.1:7890"
        result = enable(client, proxy_mode="custom", proxy_url=proxy)
        assert result.status_code == 200, result.text
        assert result.json()["proxy_configured"] and result.json()["proxy_mode"] == "custom"
        assert "test-pass" not in result.text and "proxy_url" not in result.text
        assert stat.S_IMODE(providers.credentials.stat().st_mode) == 0o600
        requests = []

        class Response:
            status = 200

            def __enter__(self):
                return self

            def __exit__(self, *_):
                pass

            def read(self, _):
                return b"{}"

        class Opener:
            def open(self, req, timeout):
                requests.append(req.full_url)
                return Response()

        handlers = []

        def build(*values):
            handlers.append(values[0].proxies)
            return Opener()

        monkeypatch.setattr("wildstring.providers.build_opener", build)
        for address in (
            "https://musicbrainz.org/ws/2/recording",
            "https://coverartarchive.org/release/" + RECORDING,
        ):
            providers.request(address)
        assert handlers == [{"http": proxy, "https": proxy}] * 2
        assert enable(client, proxy_mode="direct").status_code == 200
        providers.request("https://musicbrainz.org/ws/2/recording")
        assert handlers[-1] == {}
        for key in (
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "ALL_PROXY",
            "http_proxy",
            "https_proxy",
            "all_proxy",
        ):
            monkeypatch.delenv(key, raising=False)
        monkeypatch.setenv("ALL_PROXY", proxy)
        assert enable(client, proxy_mode="environment").status_code == 200
        providers.request("https://musicbrainz.org/ws/2/recording")
        assert handlers[-1] == {"http": proxy, "https": proxy}
        result = enable(client, proxy_url="file:///etc/passwd", proxy_mode="custom")
        assert result.status_code == 422 and "passwd" not in result.text


def test_lastfm_auth_once_consent_queue_and_ignored_messages(settings, authenticated_client):
    music(settings, "播放.flac", ["歌手"], ["歌手"])
    scan_library(settings)
    with authenticated_client(settings) as client:
        providers = client.app.state.providers
        providers.stop()
        assert (
            enable(
                client,
                api_key="a" * 32,
                api_secret="b" * 32,
                public_url="https://music.example.com",
            ).status_code
            == 200
        )
        from urllib.parse import parse_qs, urlsplit

        url = client.post("/api/v1/lastfm/authorize", headers=HEADERS).json()["url"]
        state = parse_qs(urlsplit(parse_qs(urlsplit(url).query)["cb"][0]).query)["state"][0]
        providers.request = lambda *_args, **_kwargs: {
            "session": {"key": "c" * 32, "name": "listener"}
        }
        callback = "/api/v1/lastfm/callback?state=" + state + "&token=" + "d" * 32
        assert client.get(callback).status_code == 200
        assert client.get(callback).status_code == 400
        status = client.get("/api/v1/lastfm").json()
        assert status["connected"] and not status["scrobble"] and not status["now_playing"]
        assert "credential_ref" not in status and "c" * 32 not in json.dumps(status)
        assert (
            client.put(
                "/api/v1/lastfm",
                headers=HEADERS,
                json={"version": status["version"], "scrobble": True, "now_playing": True},
            ).status_code
            == 200
        )
        db = Database(settings.data_dir)
        with db.connect(write=True) as connection:
            track = dict(connection.execute("SELECT * FROM tracks").fetchone())
            track["duration_ms"] = 300000
            started = time.time()
            session_id = str(uuid4())
            connection.execute(
                "INSERT INTO listening_sessions(id,track_id,user_id,started_at,client_started_at,playback_state) VALUES (?,?,'admin',?,?,'playing')",
                (session_id, track["id"], started, started),
            )
            session = connection.execute(
                "SELECT * FROM listening_sessions WHERE id=?", (session_id,)
            ).fetchone()
            providers.enqueue_listening(connection, "admin", session, track, 149999, True)
            assert (
                connection.execute(
                    "SELECT count(*) FROM lastfm_outbox WHERE kind='scrobble'"
                ).fetchone()[0]
                == 0
            )
            providers.enqueue_listening(connection, "admin", session, track, 150000, True)
            providers.enqueue_listening(connection, "admin", session, track, 160000, True)
            assert (
                connection.execute(
                    "SELECT count(*) FROM lastfm_outbox WHERE kind='scrobble'"
                ).fetchone()[0]
                == 1
            )
        providers.request = lambda *_args, **_kwargs: {
            "nowplaying": {"ignoredMessage": {"code": "0"}},
            "scrobbles": {"scrobble": {"ignoredMessage": {"code": "1"}}},
        }
        providers.deliver()
        providers.deliver()
        with db.connect() as connection:
            assert (
                connection.execute(
                    "SELECT status FROM lastfm_outbox WHERE kind='now_playing'"
                ).fetchone()[0]
                == "sent"
            )
            assert (
                connection.execute(
                    "SELECT status FROM lastfm_outbox WHERE kind='scrobble'"
                ).fetchone()[0]
                == "failed"
            )
        deletion_response = client.delete("/api/v1/lastfm", headers=HEADERS)
        assert deletion_response.status_code == 200
        assert not client.get("/api/v1/lastfm").json()["connected"]
        assert "c" * 32 not in providers.secrets().values()


def test_local_cover_inheritance_preserves_song_art(settings):
    one = music(settings, "one.flac", ["A"], ["A"])
    two = music(settings, "two.flac", ["A"], ["A"])
    put_picture(one, image("red"))
    scan_library(settings)
    repo = LibraryRepository(Database(settings.data_dir), settings.library_dir)
    tracks = {t["title"]: t for t in repo.tracks()["items"]}
    assets = TrackAssets(repo)
    assert assets.cover(tracks["two.flac"]["id"])[1] == "album"
    put_picture(two, image("blue"))
    scan_library(settings)
    assert assets.cover(tracks["two.flac"]["id"])[1] == "embedded"


def test_signature_redirect_and_callback_logging():
    params = {"method": "auth.getSession", "token": "x", "api_key": "a", "format": "json"}
    assert (
        lastfm_signature(params, "s")
        == hashlib.md5(b"api_keyamethodauth.getSessiontokenxs", usedforsecurity=False).hexdigest()
    )
    with pytest.raises(ProviderError):
        SafeRedirect().redirect_request(None, None, 302, "", {}, "http://127.0.0.1/")
    record = logging.LogRecord(
        "uvicorn.access",
        20,
        "",
        0,
        "%s %s %s %s %s",
        ("client", "GET", "/api/v1/lastfm/callback?token=secret&state=private", "1.1", 200),
        None,
    )
    assert RedactLastfmCallback().filter(record)
    assert "secret" not in record.getMessage()


def test_auto_queries_only_new_tracks_after_enable(settings, authenticated_client):
    music(settings, "existing.flac", ["A"], ["A"])
    scan_library(settings)
    with authenticated_client(settings) as client:
        providers = client.app.state.providers
        providers.stop()
        assert enable(client).status_code == 200
        providers.suggestions = lambda _, **_kwargs: ([], [])
        providers.step()
        with providers.database.connect() as connection:
            assert connection.execute("SELECT count(*) FROM provider_jobs").fetchone()[0] == 0
        music(settings, "new.flac", ["A"], ["A"])
        scan_library(settings)
        providers.step()
        with providers.database.connect() as connection:
            jobs = connection.execute(
                "SELECT j.status,t.title FROM provider_jobs j JOIN tracks t ON t.id=j.track_id"
            ).fetchall()
            assert [(r[0], r[1]) for r in jobs] == [("no_match", "new.flac")]


def test_caa_cover_requires_fresh_confirmation_and_survives_rescan(settings, authenticated_client):
    music(settings, "cover.flac", ["A"], ["A"])
    scan_library(settings)
    with authenticated_client(settings) as client:
        providers = client.app.state.providers
        providers.stop()
        assert enable(client).status_code == 200
        track = client.get("/api/v1/tracks").json()["items"][0]
        url = "https://coverartarchive.org/release/" + RECORDING + "/12345.jpg"
        providers.suggestions = lambda _, **_kwargs: (
            [
                (
                    "musicbrainz",
                    "https://musicbrainz.org/recording/" + RECORDING,
                    {"title": "候选"},
                    url,
                    {},
                )
            ],
            [],
        )
        providers.enqueue([track["id"]])
        providers.step()
        candidate = client.get(f"/api/v1/manage/providers/tracks/{track['id']}").json()[
            "suggestions"
        ][0]
        providers.request = lambda *_args, **_kwargs: image("green")
        endpoint = f"/api/v1/manage/providers/suggestions/{candidate['id']}/cover"
        assert (
            client.post(
                endpoint, headers=HEADERS, json={"version": candidate["metadata_version"]}
            ).status_code
            == 200
        )
        assert (
            client.get(f"/api/v1/tracks/{track['id']}/cover").headers["x-wildstring-cover-source"]
            == "chosen"
        )
        scan_library(settings, full=True)
        assert client.get(f"/api/v1/tracks/{track['id']}").json()["has_cover"]
        assert client.get(f"/api/v1/tracks/{track['id']}/cover").status_code == 200
        assert (
            client.post(
                endpoint, headers=HEADERS, json={"version": candidate["metadata_version"]}
            ).status_code
            == 409
        )


def test_metadata_migration_and_backfill_commit_together(settings, monkeypatch):
    from conftest import restore_v7_account_layout

    import wildstring.library.edits as edits

    music(settings, "migrate.flac", ["A"], ["A"])
    scan_library(settings)
    db = Database(settings.data_dir)
    with db.connect(write=True) as connection:
        identity = connection.execute("SELECT id FROM tracks").fetchone()[0]
        restore_v7_account_layout(connection)
        from migration_support import pre18

        pre18(connection)
        connection.execute("PRAGMA user_version=7")
    original = edits.apply_effective

    def fail(*_args):
        raise RuntimeError("simulated migration interruption")

    monkeypatch.setattr(edits, "apply_effective", fail)
    with pytest.raises(RuntimeError):
        db.initialize()
    with db.connect() as connection:
        assert connection.execute("PRAGMA user_version").fetchone()[0] == 11
        assert "extra" not in {r[1] for r in connection.execute("PRAGMA table_info(tracks)")}
    monkeypatch.setattr(edits, "apply_effective", original)
    db.initialize()
    assert LibraryRepository(db, settings.library_dir).tracks()["items"][0]["id"] == identity


def test_invalid_json_shape_and_nested_relations_are_failures_not_worker_crashes(
    settings, authenticated_client, monkeypatch
):
    music(settings, "invalid.flac", ["A"], ["A"])
    scan_library(settings)
    with authenticated_client(settings) as client:
        providers = client.app.state.providers
        providers.stop()
        providers.exit.clear()
        assert enable(client, proxy_mode="direct").status_code == 200

        class Response:
            status = 200

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                pass

            def read(self, _limit):
                return b"null"

        class Opener:
            def open(self, *_args, **_kwargs):
                return Response()

        monkeypatch.setattr("wildstring.providers.build_opener", lambda *_args: Opener())
        with pytest.raises(ProviderError, match="provider_invalid_response"):
            providers.request("https://musicbrainz.org/ws/2/recording")

        def malformed(_provider, _key, url, *_args, **_kwargs):
            return (
                {"recordings": [{"id": RECORDING}]}
                if url.endswith("recording")
                else {"id": RECORDING, "title": "候选", "artist-credit": [], "relations": [None]}
            )

        providers.cached = malformed
        track = client.get("/api/v1/tracks").json()["items"][0]
        suggestions, warnings = providers.suggestions(track)
        assert suggestions == [] and warnings == ["musicbrainz_invalid_response"]
        assert enable(client, public_url="http://[").status_code == 422
