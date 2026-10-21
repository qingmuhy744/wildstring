"""Music organization through scoped tools and concrete human approvals."""

from test_intake import source
from test_personal_library import HEADERS, music
from test_source_plugins import BASE as PLUGINS
from test_source_plugins import package

from wildstring.agent_models import SearchSettings
from wildstring.library.importer import import_music
from wildstring.library.scanner import scan_library
from wildstring.management import Management
from wildstring.providers import Providers

BASE = "/api/v1/agent"


def create_token(api, scopes):
    result = api.post(
        BASE + "/credentials",
        headers=HEADERS,
        json={"name": "Organization fixture", "scopes": scopes},
    )
    assert result.status_code == 200, result.text
    return {"Authorization": "Bearer " + result.json()["token"]}


def tool(api, headers, name, args=None):
    return api.post(BASE + "/tools/" + name, headers=headers, json=args or {})


def result(api, headers, name, args=None):
    value = tool(api, headers, name, args)
    assert value.status_code == 200, value.text
    return value.json()["result"]


def test_new_permissions_settings_validation_and_read_only_source(
    settings, authenticated_client, monkeypatch
):
    monkeypatch.setattr(Providers, "start", lambda self: None)
    monkeypatch.setattr(Management, "start", lambda self: None)
    path = source(settings)
    before = path.read_bytes()
    music(settings, "gain.flac", ["Artist"], ["Artist"])
    scan_library(settings)
    with authenticated_client(settings) as api:
        old = create_token(api, ["library:read", "personal:read", "tasks:write"])
        token = create_token(
            api, ["library:read", "library:manage", "personal:read", "personal:write"]
        )
        assert tool(api, old, "submit_library_task", {"kind": "import"}).status_code == 403
        assert (
            tool(api, old, "set_gain_settings", {"version": 0, "mode": "album"}).status_code == 403
        )
        config = result(api, token, "get_import_settings")
        assert config["download_policy"]["wait_for_album"] is True
        configured = result(api, token, "set_import_settings", config | {"stable_seconds": 5})
        assert configured["version"] == config["version"] + 1
        observed = result(api, token, "discover_imports")
        assert len(observed["items"]) == 1 and observed["items"][0]["state"] == "waiting"
        for args in [{"limit": 101}, {"limit": True}, {"offset": -1}, {"offset": 1000001}]:
            assert tool(api, token, "list_intake_items", args).status_code == 422
        track = api.get("/api/v1/tracks").json()["items"][0]
        info = result(api, token, "get_lyrics_quality", {"track_id": track["id"]})
        assert info["quality"]["level"] == 0 and info["version"] >= 1
        gain = result(api, token, "get_gain_settings")
        changed = result(
            api, token, "set_gain_settings", gain | {"mode": "album", "preamp_db": -2.0}
        )
        assert changed["mode"] == "album"
        assert tool(api, token, "set_gain_settings", gain).status_code == 409
        assert result(api, token, "get_loudness", {"track_id": track["id"]})["settings"] == changed
        adjustment = result(
            api,
            token,
            "adjust_gain",
            {
                "track_id": track["id"],
                "adjustment": {"scope": "track", "gain_db": -1.0, "version": 0},
            },
        )
        assert adjustment["track"]["gain_db"] == -1.0
        assert path.read_bytes() == before
        assert result(api, token, "list_library_tasks")["total"] == 0
        job = result(api, token, "submit_library_task", {"kind": "import"})
        assert result(api, token, "submit_library_task", {"kind": "import"})["id"] == job["id"]
        management = api.app.state.agent_platform.management
        claimed = management.claim()
        assert claimed["automatic"] == 1
        management.execute(claimed)
        completed = result(api, token, "get_library_task", {"task_id": job["id"]})
        assert completed["counts"]["waiting"] == 1 and completed["counts"]["copied"] == 0
        assert result(api, token, "list_library_tasks")["total"] == 1
        assert path.read_bytes() == before


def test_intake_proposal_requires_human_approval_and_rejects_stale_version(
    settings, authenticated_client, monkeypatch
):
    monkeypatch.setattr(Providers, "start", lambda self: None)
    monkeypatch.setattr(Management, "start", lambda self: None)
    path = source(settings, complete=False)
    original = path.read_bytes()
    import_music(settings)
    with authenticated_client(settings) as api:
        token = create_token(api, ["library:manage", "drafts:write", "drafts:apply"])
        item = result(api, token, "list_intake_items")["items"][0]
        draft = result(
            api,
            token,
            "create_draft",
            {
                "kind": "intake",
                "title": "Complete missing tags",
                "payload": {
                    "item_id": item["id"],
                    "version": item["version"],
                    "overrides": {"title": "Song", "artists": ["Artist"], "album": "Album"},
                },
            },
        )
        assert draft["before"]["source_path"] == path.name
        args = {
            "draft_id": draft["id"],
            "version": draft["version"],
            "idempotency_key": "intake-fixture-key",
        }
        assert tool(api, token, "apply_draft", args).json()["detail"] == "draft_approval_required"
        assert (
            api.post(
                BASE + "/drafts/" + draft["id"] + "/approve",
                headers=HEADERS,
                json={"version": draft["version"]},
            ).status_code
            == 200
        )
        applied = result(api, token, "apply_draft", args)
        assert applied["result"]["state"] == "approved"
        assert result(api, token, "apply_draft", args)["result"] == applied["result"]
        assert path.read_bytes() == original
        report = import_music(settings, automatic=True)
        assert report["counts"]["copied"] == 1
        assert api.get("/api/v1/tracks").json()["items"][0]["title"] == "Song"
        assert result(api, token, "list_drafts", {"status": "applied"})["total"] == 1


def test_exact_lyric_candidate_draft_preserves_bilingual_word_timing(
    settings, authenticated_client, monkeypatch
):
    monkeypatch.setattr(Providers, "start", lambda self: None)
    music(settings, "Rock.flac", ["合成乐队"], ["合成乐队"])
    scan_library(settings)
    with authenticated_client(settings) as api:
        assert api.post(PLUGINS + "/import", headers=HEADERS, content=package()).status_code == 200
        assert (
            api.put(
                PLUGINS + "/fixture-source", headers=HEADERS, json={"version": 1, "enabled": True}
            ).status_code
            == 200
        )
        token = create_token(
            api, ["library:read", "library:manage", "drafts:write", "drafts:apply"]
        )
        track = api.get("/api/v1/tracks").json()["items"][0]
        result(api, token, "request_lyrics_lookup", {"track_id": track["id"]})
        assert api.app.state.providers.sources.step()
        candidate = result(api, token, "get_lyric_candidates", {"track_id": track["id"]})["items"][
            0
        ]
        assert candidate["quality"]["level"] == 5
        assert candidate["preview"][0]["translation"] == "Synthetic translation"
        draft = result(
            api,
            token,
            "create_draft",
            {
                "kind": "lyrics",
                "title": "Word timing and translation",
                "payload": {
                    "candidate_id": candidate["id"],
                    "version": candidate["lyrics_version"],
                    "file_version": candidate["file_version"],
                    "offset_ms": 250,
                },
            },
        )
        assert draft["before"]["candidate_quality"]["bilingual"]
        args = {
            "draft_id": draft["id"],
            "version": draft["version"],
            "idempotency_key": "lyrics-fixture-key",
        }
        assert tool(api, token, "apply_draft", args).status_code == 409
        assert (
            api.post(
                BASE + "/drafts/" + draft["id"] + "/approve",
                headers=HEADERS,
                json={"version": draft["version"]},
            ).status_code
            == 200
        )
        assert result(api, token, "apply_draft", args)["result"]["track_id"] == track["id"]
        playing = api.get("/api/v1/tracks/" + track["id"] + "/lyrics").json()
        assert playing["lines"][0]["translation"] == "Synthetic translation"
        assert playing["lines"][0]["words"][1]["start_ms"] == 1750
        assert (
            result(api, token, "get_lyrics_quality", {"track_id": track["id"]})["quality"]["level"]
            == 5
        )
        stale = tool(
            api,
            token,
            "create_draft",
            {"kind": "lyrics", "title": "Stale", "payload": draft["payload"]},
        )
        assert stale.status_code == 409
        config = result(api, token, "get_lyric_scan_settings")
        assert config["default_profile"] == "low"
        scan = result(api, token, "submit_lyric_scan", {"mode": "upgrade", "goal": 5})
        assert (
            result(api, token, "get_lyric_scan", {"task_id": scan["id"]})["options"]["rate_profile"]
            == "low"
        )
        assert (
            result(api, token, "control_lyric_scan", {"task_id": scan["id"], "action": "pause"})[
                "status"
            ]
            == "paused"
        )


def test_mcp_search_reuses_budgets_caching_and_owner_bound_sources(
    settings, authenticated_client, monkeypatch
):
    monkeypatch.setattr(Providers, "start", lambda self: None)
    with authenticated_client(settings) as api:
        service = api.app.state.agent_platform
        with service.database.connect() as db:
            actor = service.current_actor(
                db.execute("SELECT id FROM users WHERE profile='owner'").fetchone()[0]
            )
        service.save_search_settings(
            actor,
            SearchSettings(
                provider="tavily",
                enabled=True,
                api_key="synthetic-search-key",
                daily_budget=2,
                version=0,
            ),
        )
        calls = []

        def request(url, **kwargs):
            calls.append(kwargs["payload"])
            return (
                {
                    "results": [
                        {
                            "url": "https://example.com/release",
                            "title": "Release",
                            "content": "Untrusted page",
                        }
                    ]
                }
                if url.endswith("/search")
                else {"results": [{"raw_content": "Synthetic release evidence"}]}
            )

        monkeypatch.setattr("wildstring.agent_research.json_request", request)
        token = create_token(api, ["library:read", "web:search"])
        first = result(api, token, "search_web", {"query": "Synthetic release"})
        assert first["untrusted_content"] and len(first["sources"]) == 1
        source_id = first["sources"][0]["id"]
        assert (
            result(api, token, "read_webpage", {"source_id": source_id})["content"]
            == "Synthetic release evidence"
        )
        assert result(api, token, "search_web", {"query": "Synthetic release"})["sources"]
        assert len(calls) == 2
        assert tool(api, token, "search_web", {"query": "Another release"}).status_code == 429
        assert (
            tool(api, token, "read_webpage", {"source_id": "https://example.com/other"}).status_code
            == 404
        )
        assert (
            tool(
                api, token, "read_webpage", {"source_id": source_id, "url": "http://127.0.0.1"}
            ).status_code
            == 422
        )


def test_regular_user_cannot_mint_admin_capability_or_read_other_sources(
    settings, authenticated_client, monkeypatch
):
    import pytest
    from fastapi import HTTPException

    from wildstring.agent_models import CredentialCreate

    monkeypatch.setattr(Providers, "start", lambda self: None)
    with authenticated_client(settings) as api:
        service = api.app.state.agent_platform
        user = api.post(
            "/api/v1/manage/users",
            headers=HEADERS,
            json={
                "username": "listener",
                "password": "listener-password-123",
                "profile": "listener",
            },
        )
        assert user.status_code == 201, user.text
        actor = service.current_actor(user.json()["id"])
        with pytest.raises(HTTPException) as denied:
            service.create_credential(
                actor, CredentialCreate(name="denied", scopes=["library:manage"])
            )
        assert denied.value.status_code == 403
        saved = service.create_credential(
            actor,
            CredentialCreate(
                name="own", scopes=["library:read", "web:search", "personal:read", "personal:write"]
            ),
        )
        headers = {"Authorization": "Bearer " + saved["token"]}
        names = {t["name"] for t in api.get(BASE + "/tools", headers=headers).json()["tools"]}
        assert "set_gain_settings" in names and "search_web" in names
        assert not {"get_metadata_suggestions", "get_intake_item", "get_system_status"} & names
        own = result(api, headers, "get_gain_settings")
        result(api, headers, "set_gain_settings", own | {"mode": "track"})
        with service.database.connect() as db:
            admin_id = db.execute("SELECT id FROM users WHERE profile='owner'").fetchone()[0]
        assert service.providers.loudness.settings(admin_id)["mode"] == "off"
        service.save_search_settings(
            actor,
            SearchSettings(
                provider="tavily",
                enabled=True,
                api_key="synthetic-search-key",
                daily_budget=2,
                version=0,
            ),
        )
        with service.database.connect(write=True) as db:
            from wildstring.library.repository import now

            db.execute(
                "INSERT INTO agent_web_sources VALUES (?,?,NULL,?,?,?,?,?)",
                (
                    "admin-source",
                    admin_id,
                    "Secret fixture title",
                    "https://example.com/release",
                    "Fixture",
                    None,
                    now(),
                ),
            )
        assert tool(api, headers, "read_webpage", {"source_id": "admin-source"}).status_code == 404


def test_mcp_resume_cannot_inherit_one_off_ui_model_authorization(
    settings, authenticated_client, monkeypatch
):
    from wildstring.agent_models import Connection, Inspection
    from wildstring.agent_platform import AgentPlatform

    monkeypatch.setattr(Providers, "start", lambda self: None)
    monkeypatch.setattr(AgentPlatform, "start", lambda self: None)
    music(settings, "Resume.flac", ["Artist"], ["Artist"])
    scan_library(settings)
    with authenticated_client(settings) as api:
        service = api.app.state.agent_platform
        with service.database.connect() as db:
            actor = service.current_actor(
                db.execute("SELECT id FROM users WHERE profile='owner'").fetchone()[0]
            )
        connection = service.save_connection(
            actor,
            Connection(
                name="One-off",
                base_url="https://fixture.example/v1",
                model="fixture",
                background_allowed=False,
            ),
        )
        job = service.submit_task(
            actor,
            Inspection(max_tracks=1, max_calls=1, use_ai=True, connection_id=connection["id"]),
            manual=True,
        )
        with service.database.connect(write=True) as db:
            db.execute("UPDATE agent_tasks SET status='cancelled' WHERE id=?", (job["id"],))
        token = create_token(api, ["library:read", "tasks:write"])
        denied = tool(api, token, "resume_task", {"task_id": job["id"]})
        assert (
            denied.status_code == 403
            and denied.json()["detail"] == "background_authorization_required"
        )
        assert service.task(actor, job["id"])["status"] == "cancelled"
        local = service.submit_task(actor, Inspection(max_tracks=1))
        service.cancel_task(actor, local["id"])
        resumed = result(api, token, "resume_task", {"task_id": local["id"]})
        assert resumed["status"] == "queued" and resumed["checkpoint"] == local["checkpoint"]
