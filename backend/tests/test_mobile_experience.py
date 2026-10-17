"""Cross-device CAS, private daily recommendations and constrained model selection."""

import hashlib
import json
import threading
import time
from contextlib import contextmanager
from datetime import UTC, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from test_personal_library import HEADERS, music
from test_users import login, new_user

from wildstring.database import Database
from wildstring.library.scanner import scan_library
from wildstring.main import create_app
from wildstring.recommendations import Recommendations

BASE = "/api/v1"


def seed(settings, count=12):
    paths = [
        music(settings, f"曲目{i:02}.flac", [f"艺人{i % 4}"], [], album=f"专辑{i % 5}")
        for i in range(count)
    ]
    scan_library(settings)
    return paths


def tracks(client):
    return client.get(BASE + "/tracks?limit=100").json()["items"]


def snapshot(items, **changes):
    return {
        "version": 0,
        "device_id": "phone-one",
        "track_ids": [item["id"] for item in items],
        "index": 0,
        "position_ms": 0,
        "mode": "sequential",
    } | changes


def test_playback_handoff_cas_and_removed_queue_positions(settings, authenticated_client):
    seed(settings, 4)
    with authenticated_client(settings) as client:
        items = tracks(client)
        initial = client.get(BASE + "/playback/state").json()
        assert initial["version"] == 0 and initial["track_ids"] == []
        body = snapshot(items, index=2, position_ms=200)
        assert client.put(BASE + "/playback/state", json=body).status_code == 403
        saved = client.put(BASE + "/playback/state", json=body, headers=HEADERS).json()
        assert saved["version"] == 1 and saved["index"] == 2 and saved["position_ms"] == 200
        assert client.put(BASE + "/playback/state", json=body, headers=HEADERS).status_code == 409
        other = body | {"version": 1, "device_id": "web-two", "mode": "shuffle"}
        assert (
            client.put(BASE + "/playback/state", json=other, headers=HEADERS).json()["version"] == 2
        )
        with Database(settings.data_dir).connect(write=True) as connection:
            connection.execute("UPDATE tracks SET status='missing' WHERE id=?", (items[0]["id"],))
        restored = client.get(BASE + "/playback/state").json()
        assert restored["index"] == 1 and restored["track_ids"][1] == items[2]["id"]
        assert restored["position_ms"] == 200 and restored["device_id"] == "web-two"
        with Database(settings.data_dir).connect(write=True) as connection:
            connection.execute("UPDATE tracks SET status='missing' WHERE id=?", (items[2]["id"],))
        restored = client.get(BASE + "/playback/state").json()
        assert restored["index"] == 1 and restored["position_ms"] == 0
        assert restored["track_ids"][1] == items[3]["id"]
        assert (
            client.put(
                BASE + "/playback/state", json=other | {"version": 2}, headers=HEADERS
            ).status_code
            == 422
        )


@pytest.mark.parametrize(
    "changes",
    [
        {"index": 1},
        {"position_ms": 99_999_999},
        {"version": True},
        {"track_ids": [""]},
        {"device_id": "device\rsecret"},
        {"mode": "invalid"},
        {"track_ids": ["x"] * 10_001},
    ],
)
def test_playback_rejects_invalid_or_oversized_snapshots(settings, authenticated_client, changes):
    with authenticated_client(settings) as client:
        response = client.put(
            BASE + "/playback/state", headers=HEADERS, json=snapshot([], **changes)
        )
        assert response.status_code == 422
        assert client.get(BASE + "/playback/state").json()["version"] == 0


def test_account_isolation_and_authentication(settings, authenticated_client):
    seed(settings, 3)
    with authenticated_client(settings) as admin:
        new_user(admin)
        items = tracks(admin)
        admin.put(BASE + "/playback/state", headers=HEADERS, json=snapshot(items))
        daily_admin = admin.get(BASE + "/recommendations/daily").json()
        event = {"event_id": str(uuid4()), "track_id": items[0]["id"], "action": "dismiss_track"}
        assert (
            admin.post(BASE + "/recommendations/feedback", headers=HEADERS, json=event).status_code
            == 200
        )
        with TestClient(create_app(settings)) as user:
            for path in [
                "/playback/state",
                "/recommendations/daily",
                "/recommendations/preferences",
            ]:
                assert user.get(BASE + path).status_code == 401
            assert (
                user.post(
                    BASE + "/ai/discover", headers=HEADERS, json={"prompt": "找歌"}
                ).status_code
                == 401
            )
            assert login(user).status_code == 200
            assert user.get(BASE + "/playback/state").json()["version"] == 0
            assert user.get(BASE + "/recommendations/preferences").json()["use_ai"] is False
            own = user.get(BASE + "/recommendations/daily").json()
            assert own["id"] != daily_admin["id"]
            assert items[0]["id"] in [item["track"]["id"] for item in own["items"]]
            # Same event UUID belongs to each account independently.
            assert (
                user.post(BASE + "/recommendations/feedback", headers=HEADERS, json=event).json()[
                    "duplicate"
                ]
                is False
            )
            assert (
                user.put(BASE + "/playback/state", headers=HEADERS, json=snapshot(items)).json()[
                    "version"
                ]
                == 1
            )
        assert admin.get(BASE + "/playback/state").json()["device_id"] == "phone-one"


def test_daily_stable_refresh_diverse_and_default_no_network(
    settings, authenticated_client, monkeypatch
):
    paths = seed(settings, 40)
    hashes = {path: hashlib.sha256(path.read_bytes()).hexdigest() for path in paths}

    def forbidden(*_args, **_kwargs):
        pytest.fail("Default recommendations must not contact model or metadata providers")

    monkeypatch.setattr(Recommendations, "model_select", forbidden)
    monkeypatch.setattr(Recommendations, "lastfm", forbidden)
    with authenticated_client(settings) as client:
        first = client.get(BASE + "/recommendations/daily").json()
        assert len(first["items"]) == 20 and first["engine"] == "local"
        ids = [item["track"]["id"] for item in first["items"]]
        assert len(set(ids)) == len(ids)
        assert len({item["track"]["artists"][0] for item in first["items"][:4]}) >= 3
        assert client.get(BASE + "/recommendations/daily").json() == first
        saved = client.put(
            BASE + "/recommendations/preferences",
            headers=HEADERS,
            json={"version": 1, "count": 8, "use_ai": False, "use_lastfm": False},
        ).json()
        assert saved["version"] == 2
        assert client.get(BASE + "/recommendations/daily").json() == first
        assert client.post(BASE + "/recommendations/daily/refresh").status_code == 403
        second = client.post(
            BASE + "/recommendations/daily/refresh", headers=HEADERS, json={}
        ).json()
        assert second["id"] != first["id"] and len(second["items"]) == 8
        assert len(set(ids) & {item["track"]["id"] for item in second["items"]}) < 8
        with Database(settings.data_dir).connect(write=True) as connection:
            connection.execute(
                "UPDATE tracks SET status='missing' WHERE id=?",
                (second["items"][0]["track"]["id"],),
            )
        removed = client.get(BASE + "/recommendations/daily").json()
        assert removed["id"] == second["id"] and removed["items"] == second["items"][1:]
    assert hashes == {path: hashlib.sha256(path.read_bytes()).hexdigest() for path in paths}


def test_empty_and_tiny_libraries_date_boundary_and_preferences_cas(
    settings, authenticated_client, monkeypatch
):
    import wildstring.recommendations as module

    with authenticated_client(settings) as client:
        empty = client.get(BASE + "/recommendations/daily").json()
        assert empty["items"] == [] and client.get(BASE + "/recommendations/daily").json() == empty
        assert (
            client.post(BASE + "/ai/discover", headers=HEADERS, json={"prompt": "来点歌"}).json()[
                "warning"
            ]
            == "empty_library"
        )
        for count in [0, 51, True]:
            assert (
                client.put(
                    BASE + "/recommendations/preferences",
                    headers=HEADERS,
                    json={"version": 1, "count": count},
                ).status_code
                == 422
            )
        preference = {"version": 1, "use_ai": True, "use_lastfm": True, "count": 20}
        assert (
            client.put(
                BASE + "/recommendations/preferences", headers=HEADERS, json=preference
            ).status_code
            == 200
        )
        assert (
            client.put(
                BASE + "/recommendations/preferences", headers=HEADERS, json=preference
            ).status_code
            == 409
        )
        seed(settings, 1)
        tiny = client.post(BASE + "/recommendations/daily/refresh", headers=HEADERS).json()
        assert len(tiny["items"]) == 1 and tiny["engine"] == "local"
        monkeypatch.setattr(module, "today", lambda: "2030-01-02")
        next_day = client.get(BASE + "/recommendations/daily").json()
        assert next_day["date"] == "2030-01-02" and next_day["id"] != tiny["id"]


def test_idempotent_feedback_dismiss_and_foreign_ids(settings, authenticated_client):
    seed(settings, 8)
    with authenticated_client(settings) as client:
        items = tracks(client)
        first = client.get(BASE + "/recommendations/daily").json()
        event = {"event_id": str(uuid4()), "track_id": items[0]["id"], "action": "dismiss_track"}
        assert client.post(BASE + "/recommendations/feedback", json=event).status_code == 403
        response = client.post(BASE + "/recommendations/feedback", json=event, headers=HEADERS)
        assert response.json() == {"ok": True, "duplicate": False}
        assert client.post(BASE + "/recommendations/feedback", json=event, headers=HEADERS).json()[
            "duplicate"
        ]
        assert (
            client.post(
                BASE + "/recommendations/feedback", json=event | {"action": "skip"}, headers=HEADERS
            ).status_code
            == 409
        )
        changed = client.get(BASE + "/recommendations/daily").json()
        assert changed["id"] == first["id"]
        assert items[0]["id"] not in [item["track"]["id"] for item in changed["items"]]
        for action in ("accept", "skip", "complete", "less_artist"):
            assert (
                client.post(
                    BASE + "/recommendations/feedback",
                    json=event | {"event_id": str(uuid4()), "action": action},
                    headers=HEADERS,
                ).status_code
                == 200
            )
        assert (
            client.post(
                BASE + "/recommendations/feedback",
                json=event | {"event_id": str(uuid4()), "track_id": "unknown"},
                headers=HEADERS,
            ).status_code
            == 404
        )
        assert (
            client.post(
                BASE + "/recommendations/feedback",
                json=event | {"action": "network_failure"},
                headers=HEADERS,
            ).status_code
            == 422
        )
        assert client.get(BASE + "/favorites/ids").json()["ids"] == []


@contextmanager
def model_server():
    state = {"requests": [], "status": 200, "content": None, "delay": 0}

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            state["requests"].append((self.path, body, dict(self.headers)))
            candidates = json.loads(body["messages"][1]["content"])["candidates"]
            selection = state["content"] or json.dumps(
                {
                    "title": "今晚的歌",
                    "items": [
                        {"track_id": "hallucinated-id", "reason": "fake"},
                        {"track_id": candidates[-1]["track_id"], "reason": "unsafe invented tempo"},
                        {"track_id": candidates[-1]["track_id"]},
                    ],
                }
            )
            time.sleep(state["delay"])
            self.send_response(state["status"])
            if state["status"] == 302:
                self.send_header("Location", "/should-not-follow")
            self.end_headers()
            try:
                self.wfile.write(
                    json.dumps({"choices": [{"message": {"content": selection}}]}).encode()
                )
            except BrokenPipeError:
                pass

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    try:
        yield state, f"http://127.0.0.1:{server.server_port}/v1"
    finally:
        server.shutdown()
        server.server_close()
        worker.join(timeout=3)


def configure_model(client, address):
    response = client.put(
        BASE + "/manage/ai",
        headers=HEADERS,
        json={
            "version": 1,
            "base_url": address,
            "model": "test-selector",
            "timeout": 2,
            "api_key": "private-test-model-secret",
        },
    )
    assert response.status_code == 200


def test_real_http_model_selects_only_candidates_sanitizes_and_never_creates_playlist(
    settings, authenticated_client
):
    seed(settings, 10)
    with authenticated_client(settings) as client, model_server() as (state, address):
        configure_model(client, address)
        before = client.get(BASE + "/playlists").json()
        assert (
            client.post(
                BASE + "/ai/discover", json={"connection_id": "legacy", "prompt": "找歌"}
            ).status_code
            == 403
        )
        result = client.post(
            BASE + "/ai/discover",
            headers=HEADERS,
            json={"connection_id": "legacy", "prompt": "找几首艺人1的歌", "limit": 3},
        ).json()
        assert result["mode"] == "ai" and len(result["items"]) == 1
        assert result["items"][0]["track"]["id"] in {item["id"] for item in tracks(client)}
        assert "unsafe invented tempo" not in json.dumps(
            result
        ) and "private-test-model-secret" not in json.dumps(result)
        path, body, headers = state["requests"][0]
        assert (
            path == "/v1/chat/completions"
            and headers["Authorization"] == "Bearer private-test-model-secret"
        )
        sent = json.loads(body["messages"][1]["content"])
        assert len(sent["candidates"]) <= 80
        assert all("path" not in item and "external_ids" not in item for item in sent["candidates"])
        assert str(settings.library_dir) not in json.dumps(body)
        assert before == client.get(BASE + "/playlists").json()
        state["content"] = '{"items":[{"track_id":"hallucinated-only"}]}'
        fallback = client.post(
            BASE + "/ai/discover",
            headers=HEADERS,
            json={"connection_id": "legacy", "prompt": "找歌", "limit": 2},
        ).json()
        assert (
            fallback["mode"] == "local" and fallback["warning"] == "ai_unavailable_local_fallback"
        )
        assert len(fallback["items"]) == 2
        state["content"] = json.dumps(
            {
                "title": "private-test-model-secret",
                "items": [{"track_id": result["items"][0]["track"]["id"]}],
            }
        )
        safe = client.post(
            BASE + "/ai/discover",
            headers=HEADERS,
            json={"connection_id": "legacy", "prompt": "找歌"},
        )
        assert "private-test-model-secret" not in safe.text
        state["content"] = '{"title":"没有符合条件的歌曲","items":[]}'
        empty = client.post(
            BASE + "/ai/discover",
            headers=HEADERS,
            json={"connection_id": "legacy", "prompt": "找歌"},
        ).json()
        assert empty["mode"] == "ai" and empty["items"] == []
        state["status"] = 302
        request_count = len(state["requests"])
        failed = client.post(
            BASE + "/ai/discover",
            headers=HEADERS,
            json={"connection_id": "legacy", "prompt": "找歌"},
        )
        assert failed.json()["mode"] == "local" and "private-test-model-secret" not in failed.text
        assert len(state["requests"]) == request_count + 1
        for value in ["x" * 2001, " "]:
            assert (
                client.post(
                    BASE + "/ai/discover",
                    headers=HEADERS,
                    json={"connection_id": "legacy", "prompt": value},
                ).status_code
                == 422
            )


def test_daily_ai_requires_opt_in_and_stays_cached(settings, authenticated_client):
    seed(settings, 5)
    with authenticated_client(settings) as client, model_server() as (state, address):
        configure_model(client, address)
        assert client.get(BASE + "/recommendations/daily").json()["engine"] == "local"
        assert state["requests"] == []
        client.put(
            BASE + "/recommendations/preferences",
            headers=HEADERS,
            json={"version": 1, "use_ai": True},
        )
        first = client.post(BASE + "/recommendations/daily/refresh", headers=HEADERS).json()
        assert first["engine"] == "ai" and len(first["items"]) == 1
        assert len(state["requests"]) == 1
        assert client.get(BASE + "/recommendations/daily").json() == first
        assert len(state["requests"]) == 1
        state["content"] = "x" * 70_000
        assert (
            client.post(BASE + "/recommendations/daily/refresh", headers=HEADERS).json()["engine"]
            == "local"
        )


def test_lastfm_optional_enrichment_uses_existing_cache_and_maps_only_local_tracks(
    settings, authenticated_client, monkeypatch
):
    from wildstring.providers import Providers

    seed(settings, 5)
    calls = []

    def settings_stub(_self):
        return {"enabled": True, "lastfm": True, "lastfm_configured": True}

    def cached(_self, address, parameters, **_kwargs):
        calls.append(("lastfm", address, parameters))
        return {
            "similartracks": {
                "track": [
                    {"name": "曲目04.flac", "artist": {"name": "艺人0"}},
                    {"name": "不在曲库", "artist": {"name": "陌生人"}},
                ]
            }
        }

    monkeypatch.setattr(Providers, "settings", settings_stub)
    monkeypatch.setattr(Providers, "request", cached)
    with authenticated_client(settings) as client:
        items = tracks(client)
        client.put(
            BASE + f"/tracks/{items[0]['id']}/favorite", headers=HEADERS, json={"loved": True}
        )
        client.get(BASE + "/recommendations/daily")
        assert calls == []
        client.put(
            BASE + "/recommendations/preferences",
            headers=HEADERS,
            json={"version": 1, "use_lastfm": True},
        )
        result = client.post(BASE + "/recommendations/daily/refresh", headers=HEADERS).json()
        assert result["engine"] == "local+lastfm" and 0 < len(calls) <= 2
        assert calls[0][2]["method"] == "track.getSimilar"
        assert {item["track"]["id"] for item in result["items"]} <= {item["id"] for item in items}


def test_schema13_migration_preserves_existing_library(settings, authenticated_client):
    seed(settings, 2)
    with authenticated_client(settings) as client:
        before = tracks(client)
    database = Database(settings.data_dir)
    with database.connect(write=True) as connection:
        for table in [
            "playback_states",
            "recommendation_preferences",
            "recommendation_daily",
            "recommendation_feedback",
        ]:
            connection.execute(f"DROP TABLE {table}")
        from migration_support import pre18

        pre18(connection)
        connection.execute("PRAGMA user_version=13")
    database.initialize()
    assert database.check_ready()
    with authenticated_client(settings) as client:
        assert before == tracks(client)
        from wildstring.recommendations import Preferences

        assert (
            client.get(BASE + "/recommendations/preferences").json()
            == Preferences(version=1, connection_id="local").model_dump()
        )


def test_thirty_real_local_queries_obey_artist_song_favorite_and_unplayed_constraints(
    settings, authenticated_client
):
    seed(settings, 12)
    with authenticated_client(settings) as client:
        items = tracks(client)
        for track in items[:2]:
            client.put(
                BASE + f"/tracks/{track['id']}/favorite", headers=HEADERS, json={"loved": True}
            )
        with Database(settings.data_dir).connect(write=True) as connection:
            connection.execute(
                "INSERT OR REPLACE INTO user_track_state(user_id,track_id,loved,play_count,last_played_at) VALUES ('admin',?,1,3,?)",
                (items[0]["id"], datetime.now(UTC).isoformat()),
            )
        queries = (
            [
                (f"{lead}艺人{artist}的歌", {f"艺人{artist}"}, None, None)
                for artist in range(4)
                for lead in ("找三首", "来几首", "我想听")
            ]
            + [
                (f"不要艺人{artist}", {f"艺人{x}" for x in range(4) if x != artist}, None, None)
                for artist in range(4)
            ]
            + [(f"播放{item['title']}", None, item["id"], None) for item in items[:6]]
            + [
                ("播放我的收藏", None, None, True),
                ("来三首喜欢的歌", None, None, True),
                ("不要收藏里的歌曲", None, None, False),
                ("找没听过的歌", None, None, "unplayed"),
                ("找艺人0最近没听的歌", {"艺人0"}, None, "not_recent"),
                ("找艺人1的收藏", {"艺人1"}, None, True),
                ("艺人0和艺人2的歌", {"艺人0", "艺人2"}, None, None),
                ("不要艺人0但想听艺人1", {"艺人1"}, None, None),
            ]
        )
        assert len(queries) == 30
        for prompt, artists, identity, loved in queries:
            response = client.post(BASE + "/ai/discover", headers=HEADERS, json={"prompt": prompt})
            assert response.status_code == 200, prompt
            result = response.json()
            assert result["mode"] == "local", prompt
            actual = [item["track"] for item in result["items"]]
            assert actual, prompt
            if artists:
                assert all(set(track["artists"]) <= artists for track in actual), prompt
            if identity:
                assert [track["id"] for track in actual] == [identity], prompt
            if isinstance(loved, bool):
                assert all(track["loved"] == loved for track in actual), prompt
            if loved in ("unplayed", "not_recent"):
                assert all(not track["last_played_at"] for track in actual), prompt
            if "三首" in prompt:
                assert len(actual) <= 3


def test_simultaneous_snapshot_writers_have_one_cas_winner(settings, authenticated_client):
    from concurrent.futures import ThreadPoolExecutor

    from wildstring.library.repository import LibraryRepository
    from wildstring.playback_state import PlaybackState, put_state

    seed(settings, 1)
    with authenticated_client(settings) as client:
        items = tracks(client)
    barrier = threading.Barrier(2)

    def write(device):
        from fastapi import HTTPException

        repository = LibraryRepository(Database(settings.data_dir), settings.library_dir)
        barrier.wait(timeout=3)
        try:
            result = put_state(
                repository, PlaybackState.model_validate(snapshot(items, device_id=device))
            )
            return result["version"], result["device_id"]
        except HTTPException as error:
            return error.status_code, error.detail

    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = [executor.submit(write, device) for device in ("phone", "desktop")]
        results = [future.result(timeout=15) for future in futures]
    assert sorted(value[0] for value in results) == [1, 409]


def test_cross_library_ids_never_enter_snapshots_feedback_or_daily(
    settings, authenticated_client, tmp_path
):
    from fastapi import HTTPException

    from wildstring.library.repository import LibraryRepository
    from wildstring.playback_state import PlaybackState, put_state
    from wildstring.providers import Providers
    from wildstring.recommendations import Feedback

    seed(settings, 1)
    with authenticated_client(settings) as client:
        identity = tracks(client)[0]["id"]
    other = tmp_path / "separate-library"
    other.mkdir()
    repository = LibraryRepository(Database(settings.data_dir), other)
    repository.library_id(create=True)
    service = Recommendations(repository, Providers(repository))
    with pytest.raises(HTTPException) as conflict:
        put_state(repository, PlaybackState.model_validate(snapshot([{"id": identity}])))
    assert conflict.value.status_code == 422
    with pytest.raises(HTTPException) as conflict:
        service.feedback(
            repository,
            Feedback.model_validate(
                {"event_id": str(uuid4()), "track_id": identity, "action": "accept"}
            ),
        )
    assert conflict.value.status_code == 404
    assert service.daily(repository)["items"] == []


def test_discover_uses_observed_composer_dates_and_never_guesses_missing_years(
    settings, authenticated_client
):
    seed(settings, 6)
    with authenticated_client(settings) as client:
        items = tracks(client)
        with Database(settings.data_dir).connect(write=True) as connection:
            connection.execute(
                "UPDATE tracks SET extra=? WHERE id=?",
                (
                    json.dumps({"composers": ["艺人1"], "release_date": "1994-05-01"}),
                    items[0]["id"],
                ),
            )
            connection.execute(
                "UPDATE tracks SET extra=? WHERE id=?",
                (json.dumps({"release_date": "2004"}), items[1]["id"]),
            )
        for prompt, identity in [
            ("找艺人1作曲的音乐", items[0]["id"]),
            ("找90年代的歌", items[0]["id"]),
            ("找2004年的歌", items[1]["id"]),
        ]:
            result = client.post(
                BASE + "/ai/discover", headers=HEADERS, json={"prompt": prompt}
            ).json()
            assert [item["track"]["id"] for item in result["items"]] == [identity], prompt
        result = client.post(
            BASE + "/ai/discover", headers=HEADERS, json={"prompt": "找1980年的音乐"}
        ).json()
        assert result["items"] == [] and result["warning"] == "no_local_matches"


def test_model_read_timeout_returns_local_results_without_credential_error(
    settings, authenticated_client
):
    seed(settings, 2)
    with authenticated_client(settings) as client, model_server() as (state, address):
        configure_model(client, address)
        state["delay"] = 2.5
        started = time.monotonic()
        response = client.post(
            BASE + "/ai/discover",
            headers=HEADERS,
            json={"connection_id": "legacy", "prompt": "来两首歌"},
        )
        assert 1.5 < time.monotonic() - started < 5
        assert response.status_code == 200 and response.json()["mode"] == "local"
        assert (
            len(response.json()["items"]) == 2 and "private-test-model-secret" not in response.text
        )


def test_simultaneous_daily_requests_generate_once_and_report_busy(
    settings, authenticated_client, monkeypatch
):
    from concurrent.futures import ThreadPoolExecutor

    from fastapi import HTTPException

    from wildstring.library.repository import LibraryRepository
    from wildstring.providers import Providers
    from wildstring.recommendations import Preferences

    seed(settings, 3)
    repository = LibraryRepository(Database(settings.data_dir), settings.library_dir)
    service = Recommendations(repository, Providers(repository))
    service.save_preferences(repository, Preferences(version=1, use_ai=True))
    entered, release = threading.Event(), threading.Event()
    calls = []

    def blocked(_self, candidates, _prompt, _limit, **_kwargs):
        calls.append(1)
        entered.set()
        assert release.wait(timeout=8)
        return {"items": candidates[:2], "mode": "ai"}

    monkeypatch.setattr(Recommendations, "model_select", blocked)
    with ThreadPoolExecutor(max_workers=2) as executor:
        first = executor.submit(service.daily, repository)
        assert entered.wait(timeout=4)
        try:
            with pytest.raises(HTTPException) as error:
                service.daily(repository)
            assert (
                error.value.status_code == 409
                and error.value.detail == "recommendation_generation_in_progress"
            )
        finally:
            release.set()
        result = first.result(timeout=8)
    assert len(calls) == 1 and result["engine"] == "ai"
    assert service.daily(repository) == result


def test_personal_api_results_are_private_and_never_cacheable(settings, authenticated_client):
    with authenticated_client(settings) as client:
        for path in ("/playback/state", "/recommendations/preferences", "/recommendations/daily"):
            response = client.get(BASE + path)
            assert response.status_code == 200
            assert response.headers["cache-control"] == "private, no-store"
            assert response.headers["vary"] == "Cookie"


def test_untrusted_model_json_depth_and_fenced_output_stay_bounded(settings, authenticated_client):
    seed(settings, 2)
    with authenticated_client(settings) as client, model_server() as (state, address):
        configure_model(client, address)
        for text in ("[" * 1500 + "]" * 1500, "x" + " " * 60_000 + "z"):
            state["content"] = text
            started = time.monotonic()
            response = client.post(
                BASE + "/ai/discover",
                headers=HEADERS,
                json={"connection_id": "legacy", "prompt": "来点歌"},
            )
            assert time.monotonic() - started < 3
            assert response.status_code == 200 and response.json()["mode"] == "local"
        identity = tracks(client)[0]["id"]
        state["content"] = "```json\n" + json.dumps({"items": [{"track_id": identity}]}) + "\n```"
        response = client.post(
            BASE + "/ai/discover",
            headers=HEADERS,
            json={"connection_id": "legacy", "prompt": "来点歌"},
        ).json()
        assert response["mode"] == "ai" and response["items"][0]["track"]["id"] == identity


def test_daily_deduplicates_known_recordings_but_keeps_distinct_live_and_unknown_versions(
    settings, authenticated_client
):
    seed(settings, 5)
    shared, live = str(uuid4()), str(uuid4())
    with authenticated_client(settings) as client:
        items = tracks(client)
        recordings = [shared, shared.upper(), live, None, "unverified-recording"]
        with Database(settings.data_dir).connect(write=True) as connection:
            for track, recording in zip(items, recordings, strict=True):
                details = {"external_ids": {"recording": recording}} if recording else {}
                connection.execute(
                    "UPDATE tracks SET title='同名歌曲',extra=? WHERE id=?",
                    (json.dumps(details), track["id"]),
                )
        for result in [
            client.get(BASE + "/recommendations/daily").json(),
            client.post(BASE + "/recommendations/daily/refresh", headers=HEADERS).json(),
        ]:
            ids = {item["track"]["id"] for item in result["items"]}
            assert len(ids) == 4
            assert len(ids & {items[0]["id"], items[1]["id"]}) == 1
            assert {track["id"] for track in items[2:]} <= ids
        # Explicit searches may inspect release variants; recording dedup is a daily-playlist rule.
        discovery = client.post(
            BASE + "/ai/discover",
            headers=HEADERS,
            json={"connection_id": "legacy", "prompt": "同名歌曲"},
        ).json()
        assert len(discovery["items"]) == 5
        # An explicit metadata repair can reveal a duplicate inside a cached daily set.
        with Database(settings.data_dir).connect(write=True) as connection:
            connection.execute(
                "UPDATE tracks SET extra=? WHERE id=?",
                (json.dumps({"external_ids": {"recording": shared}}), items[3]["id"]),
            )
        assert len(client.get(BASE + "/recommendations/daily").json()["items"]) == 3
