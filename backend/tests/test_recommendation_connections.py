"""Real account/connection/budget and evidence regressions for recommendations."""

import json
import time
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from test_mobile_experience import BASE, seed, tracks
from test_personal_library import HEADERS, music
from test_users import login, new_user

from wildstring.database import Database
from wildstring.library.scanner import scan_library
from wildstring.main import create_app
from wildstring.providers import Providers


def save(client, **changes):
    current = client.get(BASE + "/recommendations/preferences").json()
    result = client.put(
        BASE + "/recommendations/preferences",
        headers=HEADERS,
        json={"version": current["version"], **changes},
    )
    assert result.status_code == 200, result.text
    return result.json()


def connection(client, **changes):
    result = client.post(
        BASE + "/agent/connections",
        headers=HEADERS,
        json={
            "name": "synthetic",
            "base_url": "https://synthetic.example/v1",
            "model": "fixture",
            "api_key": "not-a-live-provider-secret",
            **changes,
        },
    )
    assert result.status_code == 200, result.text
    return result.json()


def local_model(calls):
    def model(_url, **kwargs):
        calls.append(kwargs)
        values = json.loads(kwargs["payload"]["messages"][-1]["content"])
        first = values["candidates"][0]
        key = "external_ids" if "external_id" in first else "items"
        selected = (
            [first["external_id"]] if key == "external_ids" else [{"track_id": first["track_id"]}]
        )
        return {
            "choices": [{"message": {"content": json.dumps({key: selected})}}],
            "usage": {"total_tokens": 17},
        }

    return model


def source_provider(monkeypatch, responder):
    monkeypatch.setattr(
        Providers,
        "settings",
        lambda self: {
            "enabled": True,
            "lastfm": True,
            "lastfm_configured": True,
            "proxy_mode": "direct",
        },
    )
    monkeypatch.setattr(
        Providers,
        "request",
        lambda self, address, parameters, **kwargs: responder(parameters, kwargs),
    )


def chart(name="库外真实歌曲", artist="真实歌手"):
    return {
        "tracks": {
            "track": [
                {
                    "name": name,
                    "artist": {"name": artist},
                    "url": "https://www.last.fm/music/a/_/b?tracking=remove",
                }
            ]
        }
    }


def test_default_local_explicit_private_connection_and_shared_atomic_budget(
    settings, authenticated_client
):
    seed(settings, 6)
    with authenticated_client(settings) as admin:
        new_user(admin)
        shared = connection(admin, scope="instance", shared=True, daily_call_budget=1)
        private = connection(admin)
        calls = []
        platform = admin.app.state.agent_platform
        platform.transport = local_model(calls)
        # Merely saving or opening the default page cannot silently pick a paid connection.
        save(admin, count=3)
        assert admin.get(BASE + "/recommendations/daily").json()["engine"] == "local"
        assert (
            admin.post(BASE + "/ai/discover", headers=HEADERS, json={"prompt": "找歌"}).json()[
                "mode"
            ]
            == "local"
        )
        assert calls == []
        with TestClient(create_app(settings)) as user:
            assert login(user).status_code == 200
            user.app.state.agent_platform.transport = local_model(calls)
            denied = user.post(
                BASE + "/ai/discover",
                headers=HEADERS,
                json={"prompt": "找歌", "connection_id": private["id"]},
            )
            assert denied.status_code == 404
            assert (
                user.put(
                    BASE + "/recommendations/preferences",
                    headers=HEADERS,
                    json={"version": 1, "connection_id": private["id"]},
                ).status_code
                == 404
            )
            # Both APIs use one global connection quota, including different users.
            with ThreadPoolExecutor(max_workers=2) as executor:
                futures = [
                    executor.submit(
                        client.post,
                        BASE + "/ai/discover",
                        headers=HEADERS,
                        json={"prompt": "找歌", "connection_id": shared["id"]},
                    )
                    for client in (admin, user)
                ]
                results = [future.result(timeout=10).json() for future in futures]
            assert sorted(result["mode"] for result in results) == ["ai", "local"]
            assert len(calls) == 1
            own = next(
                row
                for row in user.get(BASE + "/agent/connections").json()["items"]
                if row["id"] == shared["id"]
            )
            assert own["daily_calls_remaining"] == 0 and own["daily_calls_used"] == 1
            assert own["my_usage"]["tokens"] in {0, 17}
            admin_usage = next(
                row
                for row in admin.get(BASE + "/agent/connections").json()["items"]
                if row["id"] == shared["id"]
            )
            assert own["my_usage"]["tokens"] + admin_usage["my_usage"]["tokens"] == 17
            assert "listener" not in json.dumps(admin_usage) and "user_id" not in json.dumps(own)
            save(user, connection_id=shared["id"])
            daily = user.post(BASE + "/recommendations/daily/refresh", headers=HEADERS).json()
            assert daily["engine"] == "local" and daily["degraded"]
            assert any(row["code"] == "ai_daily_budget_exhausted" for row in daily["warnings"])
            assert calls and len(calls) == 1


def test_recent_rankings_use_actual_session_window_and_no_account_details(
    settings, authenticated_client
):
    seed(settings, 3)
    with authenticated_client(settings) as admin:
        account = new_user(admin)
        first, second, old = tracks(admin)
        database = Database(settings.data_dir)
        with database.connect(write=True) as db:
            db.execute(
                "INSERT INTO user_track_state(user_id,track_id,play_count,listened_ms) VALUES ('admin',?,900,900000)",
                (old["id"],),
            )
            for user_id, track, ago, count, duration in [
                ("admin", first, 100, 1, 60000),
                (account["id"], second, 200, 1, 90000),
                (account["id"], second, 300, 1, 40000),
                ("admin", old, 40 * 86400, 1, 100000),
            ]:
                db.execute(
                    "INSERT INTO listening_sessions(id,track_id,user_id,started_at,reported_ms,counted) VALUES (?,?,?,?,?,?)",
                    (uuid4().hex, track["id"], user_id, time.time() - ago, duration, count),
                )
        community = admin.get(BASE + "/recommendations/rankings?scope=community&period=7d").json()
        assert [item["track"]["id"] for item in community["items"]] == [second["id"], first["id"]]
        assert community["items"][0]["play_count"] == 2
        assert community["evidence"] == "server_session_start_window"
        assert account["id"] not in json.dumps(community) and "listener" not in json.dumps(
            community
        )
        personal = admin.get(BASE + "/recommendations/rankings?scope=personal&period=7d").json()
        assert [item["track"]["id"] for item in personal["items"]] == [first["id"]]
        cumulative = admin.get(BASE + "/recommendations/rankings?scope=personal&period=all").json()
        assert cumulative["items"][0]["track"]["id"] == old["id"]
        assert cumulative["evidence"] == "all_time_aggregate"


def test_external_optin_manual_cache_feedback_rematching_and_account_isolation(
    settings, authenticated_client, monkeypatch
):
    seed(settings, 2)
    calls = []

    def respond(parameters, kwargs):
        calls.append(parameters)
        assert 0 < kwargs["timeout_limit"] <= 5
        return chart()

    source_provider(monkeypatch, respond)
    with authenticated_client(settings) as admin:
        new_user(admin)
        assert admin.get(BASE + "/recommendations/external").json()["status"] == "disabled"
        assert calls == []
        save(
            admin,
            external_enabled=True,
            external_refresh_days=0,
            external_sources=["lastfm_charts"],
        )
        assert (
            admin.get(BASE + "/recommendations/external").json()["status"] == "manual"
            and calls == []
        )
        result = admin.post(
            BASE + "/recommendations/external/refresh", headers=HEADERS, json={}
        ).json()
        assert len(result["items"]) == 1 and len(calls) == 1
        item = result["items"][0]
        assert item["album"] is None and item["local_track"] is None
        assert item["source_url"] == "https://www.last.fm/music/a/_/b"
        assert "track_id" not in item and "download_url" not in item
        assert result["source_status"][0]["candidate_count"] == 1
        assert result["source_status"][0]["unmatched"] == 1
        admin.post(
            BASE + "/recommendations/external/feedback",
            headers=HEADERS,
            json={"external_id": item["external_id"], "action": "want"},
        )
        assert admin.get(BASE + "/recommendations/external").json()["wanted_items"][0]["wanted"]
        assert len(calls) == 1
        # Source cache can be shared; collections and personal feedback cannot.
        with TestClient(create_app(settings)) as user:
            assert login(user).status_code == 200
            assert (
                user.post(
                    BASE + "/recommendations/external/feedback",
                    headers=HEADERS,
                    json={"external_id": item["external_id"], "action": "want"},
                ).status_code
                == 404
            )
            assert user.get(BASE + "/recommendations/external").json()["status"] == "disabled"
        music(settings, "imported.flac", ["真实歌手"], [], album="正式专辑")
        scan_library(settings)
        db = Database(settings.data_dir)
        with db.connect(write=True) as conn:
            conn.execute("UPDATE tracks SET title='库外真实歌曲' WHERE path LIKE '%imported.flac'")
        refreshed = admin.get(BASE + "/recommendations/external").json()
        assert refreshed["wanted_items"][0]["local_track"]["title"] == "库外真实歌曲"
        assert len(calls) == 1  # Import rematch is local only.


def test_external_round_robin_context_dismiss_before_model_and_wanted_survives_batch(
    settings, authenticated_client, monkeypatch
):
    seed(settings, 3)
    calls = []

    def respond(params, _kwargs):
        method = params["method"]
        if method == "artist.getSimilar":
            return {"similarartists": {"artist": [{"name": "关联艺人"}]}}
        prefix = "全球" if method == "chart.getTopTracks" else "个人"
        return {
            "tracks" if method == "chart.getTopTracks" else "toptracks": {
                "track": [
                    {
                        "name": f"{prefix}{index}",
                        "artist": {"name": params.get("artist", "热门艺人")},
                    }
                    for index in range(50 if prefix == "全球" else 30)
                ]
            }
        }

    source_provider(monkeypatch, respond)
    with authenticated_client(settings) as client:
        track = tracks(client)[0]
        client.put(BASE + f"/tracks/{track['id']}/favorite", headers=HEADERS, json={"loved": True})
        model = connection(client)
        client.app.state.agent_platform.transport = local_model(calls)
        save(
            client,
            count=20,
            connection_id=model["id"],
            external_enabled=True,
            external_use_ai=False,
            external_sources=["lastfm_charts", "lastfm_artists"],
        )
        batch = client.post(
            BASE + "/recommendations/external/refresh", headers=HEADERS, json={}
        ).json()
        assert any(item["name"].startswith("全球") for item in batch["items"])
        assert any(item["name"].startswith("个人") for item in batch["items"])
        wanted, dismissed = batch["items"][:2]
        for item, action in [(wanted, "want"), (dismissed, "dismiss")]:
            assert (
                client.post(
                    BASE + "/recommendations/external/feedback",
                    headers=HEADERS,
                    json={"external_id": item["external_id"], "action": action},
                ).status_code
                == 200
            )
        save(client, external_use_ai=True)
        selected = client.post(
            BASE + "/recommendations/external/refresh", headers=HEADERS, json={}
        ).json()
        sent = json.loads(calls[0]["payload"]["messages"][-1]["content"])
        assert len(sent["candidates"]) == 80
        assert any(item["name"].startswith("个人") for item in sent["candidates"])
        assert dismissed["external_id"] not in {item["external_id"] for item in sent["candidates"]}
        assert track["artists"][0] in sent["preferences"]["personal_artists"]
        assert wanted["external_id"] in {item["external_id"] for item in selected["wanted_items"]}
        assert calls[0]["timeout"] <= 30
        # Even a valid JSON response cannot invent external IDs/facts.
        client.app.state.agent_platform.transport = lambda *_args, **_kwargs: {
            "choices": [{"message": {"content": '{"external_ids":["forged-external-id"]}'}}]
        }
        invalid = client.post(
            BASE + "/recommendations/external/refresh", headers=HEADERS, json={}
        ).json()
        assert invalid["degraded"] and any(
            w["code"] == "ai_invalid_external_selection" for w in invalid["warnings"]
        )
        assert all(item["external_id"].startswith("lastfm:") for item in invalid["items"])


def test_external_stale_source_failure_visible_with_short_retry_and_negative_cache(
    settings, authenticated_client, monkeypatch
):
    seed(settings, 1)
    calls = []

    def respond(params, kwargs):
        calls.append(params)
        if len(calls) > 1:
            from wildstring.providers import ProviderError

            raise ProviderError("connection_timeout")
        return chart()

    source_provider(monkeypatch, respond)
    with authenticated_client(settings) as client:
        save(client, external_enabled=True, external_sources=["lastfm_charts"])
        good = client.get(BASE + "/recommendations/external").json()
        db = Database(settings.data_dir)
        with db.connect(write=True) as conn:
            conn.execute(
                "UPDATE recommendation_external SET next_refresh_at=0.01,last_attempt_at=0"
            )
            conn.execute("DELETE FROM recommendation_source_cache")
        failed = client.get(BASE + "/recommendations/external").json()
        assert failed["id"] == good["id"] and failed["items"] == good["items"]
        assert failed["stale"] and failed["degraded"] and failed["warnings"]
        client.get(BASE + "/recommendations/external")
        assert len(calls) == 2
        with db.connect(write=True) as conn:
            conn.execute("DELETE FROM recommendation_external")
        initial_failure = client.get(BASE + "/recommendations/external").json()
        assert initial_failure["status"] == "unavailable" and initial_failure["items"] == []
        assert len(calls) == 2  # Cached negative result, no immediate repeat network.
        with db.connect() as conn:
            due = conn.execute("SELECT next_refresh_at FROM recommendation_external").fetchone()[0]
        assert 0 < due - time.time() < 901


def test_schema17_to18_is_transactional_and_migrates_only_prior_explicit_ai_optin(
    settings, authenticated_client, monkeypatch
):
    import sqlite3

    from migration_support import pre18

    import wildstring.recommendation_schema as migration

    seed(settings, 2)
    with authenticated_client(settings) as client:
        account = new_user(client)
        library = client.app.state.agent_platform.repository.library_id()
    database = Database(settings.data_dir)
    with database.connect(write=True) as db:
        pre18(db)
        db.execute("PRAGMA user_version=17")
        db.execute(
            "INSERT INTO recommendation_preferences VALUES (?,?,3,1,1,13)", ("admin", library)
        )
        db.execute(
            "INSERT INTO recommendation_preferences VALUES (?,?,1,0,0,20)", (account["id"], library)
        )
        db.execute(
            "INSERT INTO lastfm_users(user_id,username,credential_ref) VALUES ('admin','real-session-name','preserve-private-secret-ref')"
        )
        tracks_before = [tuple(row) for row in db.execute("SELECT * FROM tracks ORDER BY id")]
    original = migration.SCHEMA
    monkeypatch.setattr(
        migration,
        "SCHEMA",
        original.replace("PRAGMA user_version=18;", "INVALID MIGRATION;\nPRAGMA user_version=18;"),
    )
    with pytest.raises(sqlite3.OperationalError):
        database.initialize()
    with database.connect() as db:
        assert db.execute("PRAGMA user_version").fetchone()[0] == 17
        assert "connection_id" not in {
            row[1] for row in db.execute("PRAGMA table_info(recommendation_preferences)")
        }
        assert not db.execute(
            "SELECT 1 FROM sqlite_master WHERE name='recommendation_external'"
        ).fetchone()
    monkeypatch.setattr(migration, "SCHEMA", original)
    database.initialize()
    database.initialize()
    with database.connect() as db:
        prefs = {
            row["user_id"]: dict(row)
            for row in db.execute("SELECT * FROM recommendation_preferences")
        }
        assert prefs["admin"]["connection_id"] == "legacy"
        assert "lastfm_similar" in json.loads(prefs["admin"]["sources"])
        assert prefs[account["id"]]["connection_id"] == "local"
        assert not prefs["admin"]["external_enabled"] and not prefs["admin"]["external_use_ai"]
        assert (
            db.execute("SELECT credential_ref FROM lastfm_users").fetchone()[0]
            == "preserve-private-secret-ref"
        )
        assert tracks_before == [
            tuple(row) for row in db.execute("SELECT * FROM tracks ORDER BY id")
        ]


def test_official_tag_json_root_cache_call_cap_and_ambiguous_local_versions(
    settings, authenticated_client, monkeypatch
):
    from wildstring.recommendation_sources import LastfmSources, SourceUnavailable, local_matches

    seed(settings, 2)
    calls = []

    def respond(params, _kwargs):
        calls.append(params)
        return chart("同名", "艺人0")

    source_provider(monkeypatch, respond)
    with authenticated_client(settings) as client:
        platform = client.app.state.agent_platform
        adapter = LastfmSources(client.app.state.providers)
        adapter.max_calls = 1
        result, hit = adapter.collect("lastfm_tags", tags=["rock"])
        assert len(result) == 1 and not hit and calls[0]["method"] == "tag.getTopTracks"
        result, hit = adapter.collect("lastfm_tags", tags=["rock"])
        assert hit and adapter.calls == 1 and len(calls) == 1
        with pytest.raises(SourceUnavailable) as exhausted:
            adapter.collect("lastfm_charts")
        assert exhausted.value.code == "source_call_budget_exhausted"
        with platform.database.connect(write=True) as db:
            db.execute("UPDATE tracks SET title='同名',artists='[\"艺人0\"]'")
        assert local_matches(platform.repository, result) == {}


@pytest.mark.parametrize(
    "change",
    [
        {"version": True},
        {"count": False},
        {"external_refresh_days": True},
        {"external_call_limit": True},
        {"lastfm_tags": ["bad\ncontrol"]},
    ],
)
def test_preferences_reject_nonliteral_or_unbounded_inputs(settings, authenticated_client, change):
    with authenticated_client(settings) as client:
        response = client.put(
            BASE + "/recommendations/preferences", headers=HEADERS, json={"version": 1, **change}
        )
        assert response.status_code == 422


def test_source_negative_cache_configuration_change_and_deadline_are_bounded(
    settings, authenticated_client, monkeypatch
):
    from wildstring.providers import ProviderError
    from wildstring.recommendation_sources import LastfmSources, SourceUnavailable

    seed(settings, 1)
    config = {"version": 1, "enabled": True, "lastfm": True, "lastfm_configured": True}
    monkeypatch.setattr(Providers, "settings", lambda self: config.copy())
    calls = []

    def request(self, address, parameters, **kwargs):
        calls.append(parameters)
        if config["version"] == 1:
            raise ProviderError("connection_timeout")
        return chart()

    monkeypatch.setattr(Providers, "request", request)
    with authenticated_client(settings) as client:
        provider = client.app.state.providers
        for _ in range(2):
            with pytest.raises(SourceUnavailable):
                LastfmSources(provider).collect("lastfm_charts")
        assert len(calls) == 1
        config["version"] = 2
        assert LastfmSources(provider).collect("lastfm_charts")[0]
        assert len(calls) == 2  # Proxy/credential correction invalidated old failure.
        expired = LastfmSources(provider)
        expired.deadline = time.monotonic() - 1
        with pytest.raises(SourceUnavailable) as failure:
            expired.collect("lastfm_tags", tags=["uncached"])
        assert failure.value.code == "source_call_budget_exhausted"
        assert len(calls) == 2


def test_partial_artist_source_keeps_real_candidates_when_batch_budget_ends(
    settings, authenticated_client, monkeypatch
):
    from wildstring.recommendation_sources import LastfmSources

    seed(settings, 1)

    def respond(params, _kwargs):
        if params["method"] == "artist.getSimilar":
            return {"similarartists": {"artist": [{"name": "相关艺人"}]}}
        return {"toptracks": {"track": [{"name": "真实候选", "artist": {"name": "艺人0"}}]}}

    source_provider(monkeypatch, respond)
    with authenticated_client(settings) as client:
        adapter = LastfmSources(client.app.state.providers)
        adapter.max_calls = 2
        candidates, cached = adapter.collect("lastfm_artists", seeds=tracks(client))
        assert len(candidates) == 1 and not cached and adapter.calls == 2
        assert adapter.warnings == [
            {"source": "lastfm_artists", "code": "source_call_budget_exhausted"}
        ]


@pytest.mark.parametrize("failure", ["deleted", "disabled", "unshared", "endpoint_policy"])
def test_saved_connection_revocation_falls_back_but_explicit_invalid_ids_still_fail(
    settings, authenticated_client, monkeypatch, failure
):
    import socket

    seed(settings, 2)
    model_calls = []
    source_provider(monkeypatch, lambda _params, _kwargs: chart())
    monkeypatch.setattr(
        socket,
        "getaddrinfo",
        lambda *_args, **_kwargs: [
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 443))
        ],
    )
    with authenticated_client(settings) as admin:
        new_user(admin)
        connection(
            admin, scope="instance", shared=True
        )  # An alternate paid connection must stay unused.
        with TestClient(create_app(settings)) as ordinary:
            assert login(ordinary).status_code == 200
            if failure == "endpoint_policy":
                policy = admin.put(
                    BASE + "/agent/endpoint-policy",
                    headers=HEADERS,
                    json={"allowed_hosts": ["synthetic.example"], "allow_private": False},
                )
                assert policy.status_code == 200
                chosen = connection(ordinary)
                client = ordinary
            elif failure == "unshared":
                chosen = connection(admin, scope="instance", shared=True)
                client = ordinary
            else:
                chosen = connection(admin)
                client = admin
            client.app.state.agent_platform.transport = local_model(model_calls)
            cached_day = client.get(BASE + "/recommendations/daily").json()
            save(client, connection_id=chosen["id"])
            if failure == "deleted":
                assert (
                    admin.delete(
                        BASE + "/agent/connections/" + chosen["id"], headers=HEADERS
                    ).status_code
                    == 200
                )
            elif failure == "endpoint_policy":
                assert (
                    admin.put(
                        BASE + "/agent/endpoint-policy",
                        headers=HEADERS,
                        json={"allowed_hosts": [], "allow_private": False},
                    ).status_code
                    == 200
                )
            else:
                patch = {
                    "version": chosen["version"],
                    "name": "synthetic",
                    "base_url": "https://synthetic.example/v1",
                    "model": "fixture",
                }
                patch.update(
                    {"scope": "instance", "shared": False}
                    if failure == "unshared"
                    else {"enabled": False}
                )
                assert (
                    admin.patch(
                        BASE + "/agent/connections/" + chosen["id"], headers=HEADERS, json=patch
                    ).status_code
                    == 200
                )
            warning = {"source": "ai", "code": "saved_ai_connection_unavailable"}
            cached = client.get(BASE + "/recommendations/daily")
            assert cached.status_code == 200 and cached.json()["id"] == cached_day["id"]
            assert warning in cached.json()["warnings"] and cached.json()["degraded"]
            with Database(settings.data_dir).connect(write=True) as db:
                db.execute("UPDATE recommendation_daily SET day='2000-01-01'")
            for method, path, body in [
                ("get", "/recommendations/daily", None),
                ("post", "/recommendations/daily/refresh", {}),
                ("post", "/ai/discover", {"prompt": "找歌"}),
            ]:
                response = getattr(client, method)(
                    BASE + path, headers=HEADERS, **({"json": body} if body is not None else {})
                )
                assert response.status_code == 200, response.text
                payload = response.json()
                assert payload["items"] and payload["connection_id"] == "local"
                assert warning in payload["warnings"] and payload["degraded"]
            disabled = client.get(BASE + "/recommendations/external")
            assert disabled.status_code == 200 and disabled.json()["status"] == "disabled"
            assert warning in disabled.json()["warnings"]
            # Preference is retained for an explicit repair; no silent alternate paid connection.
            assert (
                client.get(BASE + "/recommendations/preferences").json()["connection_id"]
                == chosen["id"]
            )
            explicit = client.post(
                BASE + "/ai/discover",
                headers=HEADERS,
                json={"prompt": "找歌", "connection_id": chosen["id"]},
            )
            assert explicit.status_code in {403, 404}
            assert model_calls == []
            # A previously enabled external page preserves the same warning on new and cached batches.
            with Database(settings.data_dir).connect(write=True) as db:
                db.execute(
                    "UPDATE recommendation_preferences SET external_enabled=1,external_use_ai=1,external_sources='[\"lastfm_charts\"]' WHERE user_id=?",
                    (client.get(BASE + "/auth/status").json()["user"]["id"],),
                )
            for method, path in [
                ("get", "/recommendations/external"),
                ("get", "/recommendations/external"),
                ("post", "/recommendations/external/refresh"),
            ]:
                result = getattr(client, method)(BASE + path, headers=HEADERS).json()
                assert result["items"] and result["connection_id"] == "local"
                assert warning in result["warnings"] and result["degraded"]
            assert model_calls == []
