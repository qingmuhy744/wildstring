"""Synthetic API and persistence tests for the user-owned Agent platform."""

import json
import sqlite3
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from test_personal_library import HEADERS, music

from wildstring.agent_platform import AgentPlatform, digest
from wildstring.auth import Auth
from wildstring.database import Database
from wildstring.library.repository import LibraryRepository
from wildstring.library.scanner import scan_library

BASE = "/api/v1/agent"


@pytest.fixture
def agent(settings):
    music(settings, "real.flac", ["真实艺人"], ["真实艺人"])
    scan_library(settings)
    database = Database(settings.data_dir)
    auth = Auth(database, settings)
    auth.set_password("correct-test-password-123")
    service = AgentPlatform(LibraryRepository(database, settings.library_dir), auth)
    app = FastAPI()
    app.include_router(auth.router())
    app.include_router(auth.users_router())
    app.include_router(service.router())
    with TestClient(app) as client:
        assert (
            client.post(
                "/api/v1/auth/login",
                json={"username": "admin", "password": "correct-test-password-123"},
                headers=HEADERS,
            ).status_code
            == 200
        )
        yield client, service


def post(client, path, body):
    result = client.post(BASE + path, json=body, headers=HEADERS)
    assert result.status_code == 200, result.text
    return result.json()


def first_track(client):
    return post(client, "/tools/search_tracks", {})["result"]["items"][0]


def playlist_draft(client, track):
    return post(
        client,
        "/drafts",
        {
            "kind": "playlist",
            "title": "真实歌单草案",
            "payload": {"name": "新歌单", "track_ids": [track["id"]]},
        },
    )


def test_credential_scopes_cookie_approval_revocation_and_projection(agent):
    client, service = agent
    track = first_track(client)
    assert "path" not in track and "library_id" not in track
    credential = post(
        client,
        "/credentials",
        {"name": "MCP", "scopes": ["library:read", "drafts:write", "drafts:apply"]},
    )
    assert credential["token"].startswith("ws_")
    assert "token" not in client.get(BASE + "/credentials").text
    token_headers = {"Authorization": "Bearer " + credential["token"]}
    assert (
        client.post(BASE + "/tools/search_tracks", headers=token_headers, json={}).status_code
        == 200
    )
    assert (
        client.post(
            BASE + "/tools/search_tracks", headers=token_headers, json={"q": {}, "user_id": "admin"}
        ).status_code
        == 422
    )
    assert (
        client.post(BASE + "/tools/list_notifications", headers=token_headers, json={}).status_code
        == 403
    )
    draft = playlist_draft(client, track)
    applied = client.post(
        BASE + "/tools/apply_draft",
        headers=token_headers,
        json={
            "draft_id": draft["id"],
            "version": draft["version"],
            "idempotency_key": "test-key-1",
        },
    )
    assert applied.status_code == 409 and applied.json()["detail"] == "draft_approval_required"
    # A token cannot approve, even if it fabricates the client header.
    cookies = dict(client.cookies)
    client.cookies.clear()
    assert (
        client.post(
            BASE + f"/drafts/{draft['id']}/approve",
            headers=token_headers | HEADERS,
            json={"version": 1},
        ).status_code
        == 401
    )
    client.cookies.update(cookies)
    assert (
        client.delete(BASE + "/credentials/" + credential["id"], headers=HEADERS).status_code == 200
    )
    assert (
        client.post(BASE + "/tools/search_tracks", headers=token_headers, json={}).status_code
        == 401
    )
    with service.database.connect() as connection:
        saved = connection.execute(
            "SELECT token_hash FROM agent_credentials WHERE id=?", (credential["id"],)
        ).fetchone()[0]
    assert saved == digest(credential["token"]) and credential["token"] not in saved


def test_draft_approval_invalidation_exactly_once_and_transaction_rollback(agent, monkeypatch):
    client, service = agent
    draft = playlist_draft(client, first_track(client))
    post(client, f"/drafts/{draft['id']}/approve", {"version": 1})
    edited = client.patch(
        BASE + f"/drafts/{draft['id']}",
        headers=HEADERS,
        json={"version": 1, "title": "修改后的具体差异"},
    ).json()
    assert (
        edited["version"] == 2
        and edited["status"] == "pending"
        and edited["approved_version"] is None
    )
    post(client, f"/drafts/{draft['id']}/approve", {"version": 2})
    before = service.notifications(service.current_actor("admin"))["total"]
    emit = service.emit

    def failed_emit(*args, **kwargs):
        raise RuntimeError("synthetic rollback")

    monkeypatch.setattr(service, "emit", failed_emit)
    actor = service.current_actor("admin")
    from wildstring.agent_models import Apply

    body = Apply(version=2, idempotency_key="repeat-key-123")
    with pytest.raises(RuntimeError):
        service.apply_draft(actor, draft["id"], body)
    assert service.draft(actor, draft["id"])["status"] == "approved"
    with service.database.connect() as connection:
        assert (
            connection.execute("SELECT count(*) FROM playlists WHERE name='新歌单'").fetchone()[0]
            == 0
        )
        assert connection.execute("SELECT count(*) FROM agent_audit").fetchone()[0] == 0
    monkeypatch.setattr(service, "emit", emit)
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: service.apply_draft(actor, draft["id"], body), range(2)))
    assert results[0]["result"] == results[1]["result"]
    assert service.notifications(actor)["total"] == before + 1
    with service.database.connect() as connection:
        assert (
            connection.execute("SELECT count(*) FROM playlists WHERE name='新歌单'").fetchone()[0]
            == 1
        )
        assert connection.execute("SELECT count(*) FROM agent_audit").fetchone()[0] == 1


def test_metadata_preserves_unrelated_overrides_and_rejects_stale_versions(agent):
    client, service = agent
    track = first_track(client)
    identity = track["id"]
    detail = post(client, "/tools/get_track", {"track_id": identity})["result"]
    draft = post(
        client,
        "/drafts",
        {
            "kind": "metadata",
            "title": "补全专辑",
            "payload": {
                "track_id": identity,
                "metadata_version": detail["metadata_version"],
                "overrides": {"album": "核对专辑"},
            },
        },
    )
    assert "title" in draft["before"]
    post(client, f"/drafts/{draft['id']}/approve", {"version": 1})
    result = post(
        client,
        f"/drafts/{draft['id']}/apply",
        {"version": 1, "idempotency_key": "metadata-test-key"},
    )
    assert result["result"]["track_id"] == identity
    assert post(client, "/tools/get_track", {"track_id": identity})["result"]["album"] == "核对专辑"
    assert (
        client.post(
            BASE + "/drafts",
            headers=HEADERS,
            json={
                "kind": "metadata",
                "title": "失效",
                "payload": {
                    "track_id": identity,
                    "metadata_version": detail["metadata_version"],
                    "overrides": {"album": "旧值"},
                },
            },
        ).status_code
        == 409
    )


def test_inbox_cursor_paging_read_sync_and_snapshot_read_all(agent):
    client, service = agent
    actor = service.current_actor("admin")
    with service.database.connect(write=True) as connection:
        for index in range(8):
            service.emit(
                connection, "admin", "task.completed", f"event-{index}", "完成", str(index)
            )
    first = client.get(BASE + "/notifications?limit=3").json()
    assert len(first["items"]) == 3 and first["unread_count"] == 8
    assert client.get(BASE + "/notifications").json()["unread_count"] == 8
    with service.database.connect(write=True) as connection:
        service.emit(connection, "admin", "task.completed", "later", "后来", "新消息")
    post(client, "/notifications/read-all", {"high_watermark": first["high_watermark"]})
    assert client.get(BASE + "/notifications").json()["unread_count"] == 1
    changed = []
    cursor = first["next_cursor"]
    for _ in range(10):
        result = client.get(BASE + "/notifications", params={"cursor": cursor, "limit": 3}).json()
        changed.extend(result["items"])
        cursor = result["next_cursor"]
        if len(result["items"]) < 3:
            break
    assert len({item["id"] for item in changed}) == 9
    assert client.get(BASE + "/notifications?cursor=bad").status_code == 410
    # Duplicate business events do not create additional notifications.
    with service.database.connect(write=True) as connection:
        service.emit(connection, "admin", "task.completed", "later", "重复", "重复")
    assert service.notifications(actor)["total"] == 9


def test_jobs_checkpoint_competing_claimants_revocation_resume_and_scheduling(agent):
    client, service = agent
    actor = service.current_actor("admin")
    job = post(client, "/tasks", {"max_tracks": 20})
    with ThreadPoolExecutor(max_workers=2) as pool:
        claims = list(pool.map(lambda _: service.claim_task(), range(2)))
    assert sum(claim is not None for claim in claims) == 1
    claimed = next(claim for claim in claims if claim)
    service.execute_task(claimed)
    result = service.task(actor, job["id"])
    assert result["status"] == "succeeded" and result["checkpoint"] == 1
    assert result["results"][0]["track_id"] == first_track(client)["id"]
    assert "missing_lyrics" in result["results"][0]["issues"]
    cancelled = post(client, "/tasks", {})
    assert post(client, f"/tasks/{cancelled['id']}/cancel", {})["status"] == "cancelled"
    assert post(client, f"/tasks/{cancelled['id']}/resume", {})["status"] == "queued"
    claimed = service.claim_task()
    with service.database.connect(write=True) as connection:
        connection.execute("UPDATE users SET version=version+1 WHERE id='admin'")
    service.execute_task(claimed)
    assert service.task(actor, cancelled["id"])["status"] == "paused_authorization"
    post(client, f"/tasks/{cancelled['id']}/resume", {})
    service.execute_task(service.claim_task())
    assert service.task(actor, cancelled["id"])["status"] == "succeeded"
    schedule = post(
        client, "/schedules", {"name": "每日检查", "enabled": True, "interval_hours": 24}
    )
    with service.database.connect(write=True) as connection:
        connection.execute(
            "UPDATE agent_schedules SET next_run_at='2000-01-01T00:00:00+00:00' WHERE id=?",
            (schedule["id"],),
        )
    with ThreadPoolExecutor(max_workers=2) as pool:
        list(pool.map(lambda _: service.schedule_due(), range(2)))
    with service.database.connect() as connection:
        assert (
            connection.execute(
                "SELECT count(*) FROM agent_tasks WHERE schedule_key IS NOT NULL"
            ).fetchone()[0]
            == 1
        )


def test_telegram_verification_outbox_unknown_and_no_secret_response(agent):
    client, service = agent
    captured = []

    def transport(url, **kwargs):
        captured.append(kwargs["payload"]["text"])
        return {"ok": True, "result": {"message_id": 123}}

    service.transport = transport
    secret = "123456789:abcdefghijklmnopqrstuvxyz1234"
    target = post(
        client, "/telegram-targets", {"name": "私人目标", "bot_token": secret, "chat_id": "123456"}
    )
    assert secret not in json.dumps(target) and "chat_id" not in target
    assert (
        client.post(
            BASE + f"/telegram-targets/{target['id']}/test", headers=HEADERS, json={}
        ).status_code
        == 409
    )
    post(client, f"/telegram-targets/{target['id']}/verify-send", {})
    code = captured[-1].split("：")[1].split("\n")[0]
    verified = post(client, f"/telegram-targets/{target['id']}/verify", {"code": code})
    assert verified["verified"] and verified["enabled"]
    post(client, "/notification-preferences", {}) if False else None
    response = client.put(
        BASE + "/notification-preferences", json={"telegram_enabled": True}, headers=HEADERS
    )
    assert response.status_code == 200
    with service.database.connect(write=True) as connection:
        service.emit(connection, "admin", "task.completed", "external-1", "完成", "真实结果")
    assert service.deliver_one()
    deliveries = client.get(BASE + "/deliveries").json()["items"]
    assert deliveries[0]["status"] == "sent" and deliveries[0]["message_id"] == "123"
    assert not service.deliver_one()
    with service.database.connect(write=True) as connection:
        service.emit(connection, "admin", "task.completed", "external-2", "完成", "超时结果")

    def ambiguous(*args, **kwargs):
        raise TimeoutError("secret must never be returned")

    service.transport = ambiguous
    assert service.deliver_one()
    delivery = client.get(BASE + "/deliveries").json()["items"][0]
    assert delivery["status"] == "unknown"
    assert (
        client.post(
            BASE + f"/deliveries/{delivery['id']}/retry", json={}, headers=HEADERS
        ).status_code
        == 409
    )
    assert post(client, f"/deliveries/{delivery['id']}/retry", {"acknowledge_unknown": True})["ok"]


def test_connections_tool_loop_budget_scope_and_local_fallback(agent):
    client, service = agent
    track = first_track(client)
    connection = post(
        client,
        "/connections",
        {
            "name": "合成模型",
            "base_url": "https://model.example/v1",
            "model": "test-model",
            "api_key": "fake-synthetic-private-key",
            "daily_call_budget": 10,
        },
    )
    assert "api_key" not in connection and connection["has_api_key"]
    assert "fake-synthetic-private-key" not in client.get(BASE + "/connections").text
    requests = []

    def model(url, **kwargs):
        requests.append(kwargs["payload"])
        if len(requests) == 1:
            return {
                "choices": [
                    {
                        "message": {
                            "role": "assistant",
                            "content": None,
                            "tool_calls": [
                                {
                                    "id": "lookup-1",
                                    "type": "function",
                                    "function": {
                                        "name": "get_track",
                                        "arguments": json.dumps({"track_id": track["id"]}),
                                    },
                                }
                            ],
                        }
                    }
                ]
            }
        if len(requests) == 2:
            return {
                "choices": [
                    {
                        "message": {
                            "role": "assistant",
                            "content": None,
                            "tool_calls": [
                                {
                                    "id": "draft-1",
                                    "type": "function",
                                    "function": {
                                        "name": "create_draft",
                                        "arguments": json.dumps(
                                            {
                                                "kind": "playlist",
                                                "title": "已验证候选",
                                                "payload": {
                                                    "name": "实际歌单",
                                                    "track_ids": [track["id"]],
                                                },
                                            }
                                        ),
                                    },
                                }
                            ],
                        }
                    }
                ]
            }
        return {
            "choices": [{"message": {"content": "已生成草案，请在站内确认后保存。"}}],
            "usage": {"total_tokens": 100},
        }

    service.transport = model
    conversation = post(client, "/conversations", {"connection_id": connection["id"]})
    result = post(
        client,
        f"/conversations/{conversation['id']}/messages",
        {"content": "用刚才的歌曲建个歌单", "max_calls": 4},
    )
    assert result["runs"][0]["status"] == "succeeded" and result["runs"][0]["tool_calls"] == 2
    assert len(result["runs"][0]["draft_ids"]) == 1
    assert requests[1]["messages"][-1]["role"] == "tool"
    with service.database.connect() as database:
        assert (
            database.execute("SELECT count(*) FROM playlists WHERE name='实际歌单'").fetchone()[0]
            == 0
        )

    # Model cannot turn a message into automatic approval/application.
    def forbidden(*args, **kwargs):
        return {
            "choices": [
                {
                    "message": {
                        "tool_calls": [
                            {"id": "bad", "function": {"name": "apply_draft", "arguments": "{}"}}
                        ]
                    }
                }
            ]
        }

    service.transport = forbidden
    result = post(
        client, f"/conversations/{conversation['id']}/messages", {"content": "请越权应用"}
    )
    assert result["runs"][0]["error_code"] == "ai_tool_not_allowed"
    empty = post(client, "/conversations", {})
    client.delete(BASE + "/connections/" + connection["id"], headers=HEADERS)
    result = post(client, f"/conversations/{empty['id']}/messages", {"content": "真实"})
    assert result["runs"][0]["status"] == "local_fallback"


def test_user_isolation_role_demote_and_personal_endpoint_policy(agent):
    client, service = agent
    track = first_track(client)
    draft = playlist_draft(client, track)
    user = client.post(
        "/api/v1/manage/users",
        json={"username": "normal", "password": "normal-password-123", "role": "user"},
        headers=HEADERS,
    ).json()
    user_id = user["id"]
    actor = service.current_actor(user_id)
    with pytest.raises(HTTPException) as failure:
        service.draft(actor, draft["id"])
    assert failure.value.status_code == 404
    from wildstring.agent_models import Connection

    with pytest.raises(HTTPException) as failure:
        service.save_connection(
            actor, Connection(name="内网探测", base_url="http://127.0.0.1:9999", model="test")
        )
    assert failure.value.detail == "ai_endpoint_not_allowed"
    with pytest.raises(HTTPException):
        service.create_draft(
            actor,
            __import__("wildstring.agent_models", fromlist=["DraftCreate"]).DraftCreate(
                kind="metadata", title="不允许", payload={}
            ),
        )


def test_background_credential_scopes_budget_pause_and_revoke(agent):
    client, service = agent
    connection = post(
        client,
        "/connections",
        {
            "name": "后台模型",
            "base_url": "https://fixture.example/v1",
            "model": "fixture",
            "background_allowed": True,
            "daily_call_budget": 10,
        },
    )
    credential = post(
        client, "/credentials", {"name": "limited", "scopes": ["tasks:write", "library:read"]}
    )
    headers = {"Authorization": "Bearer " + credential["token"]}
    submitted = client.post(
        BASE + "/tools/submit_inspection",
        headers=headers,
        json={"use_ai": True, "connection_id": connection["id"], "max_calls": 1},
    ).json()["result"]
    job = service.claim_task()
    actor = service.validate_task_actor(job)
    assert actor.scopes == frozenset({"tasks:write", "library:read"})
    assert "drafts:write" not in actor.scopes and "personal:read" not in actor.scopes
    captured = []

    def restricted_model(*args, **kwargs):
        names = {tool["function"]["name"] for tool in kwargs["payload"]["tools"]}
        captured.append(names)
        assert "create_draft" not in names and "get_personal_library" not in names
        return {"choices": [{"message": {"content": "仅根据实际缺失字段给出只读解释。"}}]}

    service.transport = restricted_model
    service.execute_task(job)
    assert service.task(service.current_actor("admin"), submitted["id"])["status"] == "succeeded"
    assert captured
    second = client.post(BASE + "/tools/submit_inspection", headers=headers, json={}).json()[
        "result"
    ]
    job = service.claim_task()
    client.delete(BASE + "/credentials/" + credential["id"], headers=HEADERS)
    service.execute_task(job)
    assert (
        service.task(service.current_actor("admin"), second["id"])["status"]
        == "paused_authorization"
    )
    paused = post(
        client, "/tasks", {"use_ai": True, "connection_id": connection["id"], "max_calls": 0}
    )
    service.execute_task(service.claim_task())
    assert service.task(service.current_actor("admin"), paused["id"])["status"] == "paused_budget"


def test_restart_leases_preserve_checkpoint_and_model_unknown_is_not_retried(agent):
    client, service = agent
    actor = service.current_actor("admin")
    job = post(client, "/tasks", {})
    claimed = service.claim_task()
    inspected = service.inspect(actor, job["parameters"]["track_ids"])["items"]
    service.checkpoint_task(claimed, 1, inspected, {"processed": 1, "issues": 2})
    with service.database.connect(write=True) as connection:
        connection.execute(
            "UPDATE agent_tasks SET lease_until='2000-01-01' WHERE id=?", (job["id"],)
        )
    recovered = service.claim_task()
    assert recovered["checkpoint"] == 1
    service.execute_task(recovered)
    result = service.task(actor, job["id"])
    assert len(result["results"]) == 1 and result["counts"]["processed"] == 1
    unknown = post(client, "/tasks", {})
    claimed = service.claim_task()
    service.checkpoint_task(claimed, 0, [], {}, stage="model_call")
    with service.database.connect(write=True) as connection:
        connection.execute(
            "UPDATE agent_tasks SET lease_until='2000-01-01' WHERE id=?", (unknown["id"],)
        )
    assert service.claim_task() is None
    result = service.task(actor, unknown["id"])
    assert result["status"] == "paused_budget" and result["error_code"] == "model_outcome_unknown"


def test_notification_retention_expires_cursor_and_preserves_pending(agent):
    client, service = agent
    draft = playlist_draft(client, first_track(client))
    actor = service.current_actor("admin")
    with service.database.connect(write=True) as connection:
        service.emit(connection, "admin", "task.completed", "expire-notice", "旧通知", "过期")
    before = service.notifications(actor)
    pending = next(item for item in before["items"] if item["draft_id"] == draft["id"])
    with service.database.connect(write=True) as connection:
        connection.execute("UPDATE agent_notifications SET created_at='2000-01-01'")
    service.cleanup_notifications()
    after = service.notifications(actor)
    assert len(after["items"]) == 1 and after["items"][0]["id"] == pending["id"]
    assert (
        client.get(
            BASE + "/notifications", params={"cursor": before["next_cursor"].split(":")[0] + ":0"}
        ).status_code
        == 410
    )


@pytest.mark.parametrize(
    "error_code,expected",
    [(429, "retry_wait"), (503, "retry_wait"), (401, "failed"), (403, "failed")],
)
def test_telegram_error_classification_and_subscription_revocation(agent, error_code, expected):
    client, service = agent
    secret = "123456789:abcdefghijklmnopqrstuvxyz1234"
    target = post(
        client, "/telegram-targets", {"name": "target", "bot_token": secret, "chat_id": "123456"}
    )
    with service.database.connect(write=True) as connection:
        connection.execute(
            "UPDATE agent_telegram_targets SET verified=1,enabled=1 WHERE id=?", (target["id"],)
        )
    assert (
        client.put(
            BASE + "/notification-preferences", json={"telegram_enabled": True}, headers=HEADERS
        ).status_code
        == 200
    )
    with service.database.connect(write=True) as connection:
        service.emit(connection, "admin", "task.completed", "rate-test", "摘要", "结果")
    service.transport = lambda *_args, **_kwargs: {
        "ok": False,
        "error_code": error_code,
        "parameters": {"retry_after": 5},
    }
    assert service.deliver_one()
    delivery = client.get(BASE + "/deliveries").json()["items"][0]
    assert delivery["status"] == expected
    if expected == "retry_wait":
        client.put(
            BASE + "/notification-preferences", json={"telegram_enabled": False}, headers=HEADERS
        )
        assert client.get(BASE + "/deliveries").json()["items"][0]["status"] == "cancelled"
    assert client.get(BASE + "/notifications").json()["unread_count"] == 1


def test_connection_scope_and_secret_rotation_are_versioned(agent):
    client, service = agent
    connection = post(
        client,
        "/connections",
        {
            "name": "versioned",
            "base_url": "https://fixture.example/v1",
            "model": "fixture",
            "api_key": "first-synthetic-secret",
            "daily_call_budget": 0,
        },
    )
    actor = service.current_actor("admin")
    configuration = service.connection_for(actor, connection["id"])
    service.transport = lambda *_args, **_kwargs: {"choices": [{"message": {"content": "ok"}}]}
    with pytest.raises(HTTPException) as failure:
        service.model_request(actor, configuration, [{"role": "user", "content": "test"}])
    assert failure.value.detail == "ai_daily_budget_exhausted"
    updated = client.patch(
        BASE + "/connections/" + connection["id"],
        headers=HEADERS,
        json={
            "name": "versioned",
            "base_url": "https://fixture.example/v1",
            "model": "fixture",
            "api_key": "second-synthetic-secret",
            "version": connection["version"],
        },
    ).json()
    assert updated["version"] == 2
    with pytest.raises(HTTPException) as failure:
        service.model_request(actor, configuration, [{"role": "user", "content": "test"}])
    assert failure.value.detail == "ai_connection_version_changed"
    secret_dir = service.database.path.parent / "agent-secrets"
    assert len(list(secret_dir.iterdir())) == 1
    assert secret_dir.stat().st_mode & 0o777 == 0o700
    assert next(secret_dir.iterdir()).stat().st_mode & 0o777 == 0o600


def test_suggestion_tools_use_existing_provider_pipeline_and_strip_urls(agent):
    client, service = agent
    track = first_track(client)
    with service.database.connect(write=True) as connection:
        connection.execute("UPDATE provider_settings SET enabled=1 WHERE id=1")
    queued = post(client, "/tools/request_metadata_refresh", {"track_ids": [track["id"]]})["result"]
    assert queued["queued"] == 1 and queued["batch_id"]
    with service.database.connect(write=True) as connection:
        job = connection.execute(
            "SELECT id,metadata_version FROM provider_jobs WHERE track_id=?", (track["id"],)
        ).fetchone()
        connection.execute(
            "INSERT INTO metadata_suggestions(id,job_id,track_id,metadata_version,provider,source_url,fields,created_at) VALUES (?,?,?,?,?,?,?,0)",
            (
                "synthetic-candidate",
                job["id"],
                track["id"],
                job["metadata_version"],
                "musicbrainz",
                "https://musicbrainz.org/recording/fake?secret=hidden",
                json.dumps({"album": "可核对专辑", "private_path": "/do/not/expose"}),
            ),
        )
    result = post(client, "/tools/get_metadata_suggestions", {"track_id": track["id"]})["result"]
    assert result["items"][0]["fields"] == {"album": "可核对专辑"}
    assert result["items"][0]["source_url"] == "https://musicbrainz.org/recording/fake"


def drop_agent_tables(connection):
    """Reconstruct the actual pre-17 layout, rather than changing only its marker."""
    from migration_support import pre19

    pre19(connection)
    for name in (
        "agent_messages",
        "agent_runs",
        "agent_conversations",
        "agent_deliveries",
        "agent_notifications",
        "agent_notification_changes",
        "agent_inbox_state",
        "agent_events",
        "agent_audit",
        "agent_drafts",
        "agent_credentials",
        "agent_tasks",
        "agent_schedules",
        "agent_connections",
        "agent_usage",
        "agent_preferences",
        "agent_telegram_targets",
        "agent_policy",
    ):
        connection.execute("DROP TABLE " + name)


def test_real_v16_migration_preserves_library_people_accounts_and_credentials(agent, monkeypatch):
    client, service = agent
    from wildstring.agent_models import Apply
    from wildstring.database import SCHEMA_VERSION
    from wildstring.library.edits import MetadataEditor, MetadataUpdate

    track = first_track(client)
    actor = service.current_actor("admin")
    draft = playlist_draft(client, track)
    service.approve_draft(actor, draft["id"], 1)
    service.apply_draft(
        actor, draft["id"], Apply(version=1, idempotency_key="migration-playlist-key")
    )
    editor = MetadataEditor(service.repository)
    metadata = editor.read(track["id"])
    editor.save(
        track["id"],
        MetadataUpdate(
            version=metadata["version"],
            overrides={"title": "人工修正保留", "composers": ["真实作者"]},
        ),
    )
    legacy_secret = service.database.path.parent / "legacy-secret-fixture"
    legacy_secret.write_text("synthetic-original-private-secret")
    with service.database.connect(write=True) as connection:
        connection.execute(
            "INSERT INTO lastfm_users(user_id,username,credential_ref) VALUES ('admin','fixture-listener','legacy-secret-fixture')"
        )
        connection.execute(
            "INSERT INTO user_track_state(user_id,track_id,loved,play_count,listened_ms) VALUES (?,?,1,4,120000)",
            ("admin", track["id"]),
        )
    preserved = (
        "tracks",
        "track_metadata",
        "metadata_history",
        "track_credits",
        "people",
        "users",
        "playlists",
        "playlist_tracks",
        "user_track_state",
        "lastfm_users",
        "provider_settings",
        "provider_jobs",
        "provider_refresh_batches",
        "provider_task_reviews",
    )

    def snapshot():
        with service.database.connect() as connection:
            return {
                table: [tuple(row) for row in connection.execute("SELECT * FROM " + table)]
                for table in preserved
            }

    original = snapshot()
    with service.database.connect(write=True) as connection:
        drop_agent_tables(connection)
        from migration_support import pre18

        pre18(connection)
        connection.execute("PRAGMA user_version=16")
    import wildstring.agent_schema

    schema = wildstring.agent_schema.SCHEMA
    monkeypatch.setattr(
        wildstring.agent_schema,
        "SCHEMA",
        schema.replace(
            "PRAGMA user_version = 17;", "INVALID MIGRATION STATEMENT;\nPRAGMA user_version = 17;"
        ),
    )
    with pytest.raises(sqlite3.OperationalError):
        service.database.initialize()
    with service.database.connect() as connection:
        assert connection.execute("PRAGMA user_version").fetchone()[0] == 16
        assert not connection.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='agent_tasks'"
        ).fetchone()
    assert snapshot() == original
    monkeypatch.setattr(wildstring.agent_schema, "SCHEMA", schema)
    service.database.initialize()
    service.database.initialize()
    assert snapshot() == original and SCHEMA_VERSION == 19
    assert legacy_secret.read_text() == "synthetic-original-private-secret"
    assert service.database.check_ready()


def test_telegram_real_http_error_json_retry_after_uses_shared_client(agent, monkeypatch):
    from io import BytesIO
    from urllib.error import HTTPError

    import wildstring.outbound

    client, service = agent
    target = post(
        client,
        "/telegram-targets",
        {
            "name": "target",
            "bot_token": "123456789:abcdefghijklmnopqrstuvxyz1234",
            "chat_id": "123456",
        },
    )
    with service.database.connect(write=True) as connection:
        connection.execute(
            "UPDATE agent_telegram_targets SET verified=1,enabled=1 WHERE id=?", (target["id"],)
        )
    client.put(BASE + "/notification-preferences", json={"telegram_enabled": True}, headers=HEADERS)
    with service.database.connect(write=True) as connection:
        service.emit(
            connection, "admin", "task.completed", "real-http-429", "测试", "真实HTTPError正文限流"
        )

    class ErrorOpener:
        def open(self, request, timeout=None):
            assert request.host == "api.telegram.org"
            raise HTTPError(
                request.full_url,
                429,
                "rate limited",
                {},
                BytesIO(b'{"ok":false,"error_code":429,"parameters":{"retry_after":123}}'),
            )

    monkeypatch.setattr(wildstring.outbound, "build_opener", lambda *_args: ErrorOpener())
    assert service.deliver_one()
    delivery = client.get(BASE + "/deliveries").json()["items"][0]
    assert delivery["status"] == "retry_wait" and delivery["error_code"] == "telegram_http_429"
    from datetime import UTC, datetime

    delay = (
        datetime.fromisoformat(delivery["next_attempt_at"]) - datetime.now(UTC)
    ).total_seconds()
    assert 120 < delay <= 123


def test_sensitive_model_echo_rejected_without_persisting_secret(agent):
    client, service = agent
    secret = "private-synthetic-echo-key"
    connection = post(
        client,
        "/connections",
        {
            "name": "echo",
            "base_url": "https://fixture.example/v1",
            "model": "fixture",
            "api_key": secret,
        },
    )
    service.transport = lambda *_args, **_kwargs: {"choices": [{"message": {"content": secret}}]}
    conversation = post(client, "/conversations", {"connection_id": connection["id"]})
    result = post(
        client, f"/conversations/{conversation['id']}/messages", {"content": "测试模型错误回显"}
    )
    assert result["runs"][0]["error_code"] == "ai_sensitive_response"
    assert secret not in json.dumps(result)
    with service.database.connect() as database:
        assert not database.execute(
            "SELECT 1 FROM agent_messages WHERE content LIKE ?", ("%" + secret + "%",)
        ).fetchone()


def test_assistant_never_silently_chooses_paid_connection_and_can_switch_local(agent):
    client, service = agent
    connection = post(
        client,
        "/connections",
        {"name": "付费路径", "base_url": "https://fixture.example/v1", "model": "fixture"},
    )
    calls = []

    def model(*args, **kwargs):
        calls.append(kwargs)
        return {"choices": [{"message": {"content": "来自明确选择的模型。"}}]}

    service.transport = model
    local = post(client, "/conversations", {})
    result = post(client, f"/conversations/{local['id']}/messages", {"content": "查歌"})
    assert result["runs"][0]["status"] == "local_fallback" and not calls
    assert "本次使用本地关键词检索，未调用模型。" in result["messages"][-1]["content"]
    assert "AI 未配置" not in result["messages"][-1]["content"]
    result = post(
        client,
        f"/conversations/{local['id']}/messages",
        {"content": "这次使用模型", "connection_id": connection["id"]},
    )
    assert len(calls) == 1 and result["runs"][0]["status"] == "succeeded"
    result = post(
        client,
        f"/conversations/{local['id']}/messages",
        {"content": "回到本地", "connection_id": "local"},
    )
    assert (
        len(calls) == 1
        and result["runs"][0]["status"] == "local_fallback"
        and result["connection_id"] is None
    )


def test_connection_capabilities_are_independently_verified_with_synthetic_inputs(agent):
    client, service = agent
    connection = post(
        client,
        "/connections",
        {"name": "验证能力", "base_url": "https://fixture.example/v1", "model": "fixture"},
    )
    seen = []

    def model(*args, **kwargs):
        body = kwargs["payload"]
        seen.append(body)
        if body.get("tools"):
            return {
                "choices": [
                    {
                        "message": {
                            "tool_calls": [
                                {
                                    "id": "probe",
                                    "function": {
                                        "name": "probe_connection",
                                        "arguments": '{"marker":"wildstring-probe"}',
                                    },
                                }
                            ]
                        }
                    }
                ]
            }
        if "synthetic candidate" in body["messages"][0]["content"]:
            return {"choices": [{"message": {"content": '{"track_ids":["fixture-track-1"]}'}}]}
        return {"choices": [{"message": {"content": "OK"}}]}

    service.transport = model
    tested = post(client, f"/connections/{connection['id']}/test", {})
    assert tested["text"] and tested["tools"] and tested["structured"] and tested["tested_at"]
    assert len(seen) == 4 and "真实艺人" not in json.dumps(seen, ensure_ascii=False)
    saved = client.get(BASE + "/connections").json()["items"][0]
    assert saved["capabilities"] == tested


def test_empty_inbox_after_retention_has_usable_new_cursor(agent):
    client, service = agent
    actor = service.current_actor("admin")
    with service.database.connect(write=True) as connection:
        service.emit(connection, "admin", "task.completed", "only-old", "旧", "过期")
        connection.execute("UPDATE agent_notifications SET created_at='2000-01-01'")
    old = service.notifications(actor)
    service.cleanup_notifications()
    assert (
        client.get(BASE + "/notifications", params={"cursor": old["next_cursor"]}).status_code
        == 410
    )
    fresh = service.notifications(actor)
    assert fresh["items"] == []
    assert (
        client.get(BASE + "/notifications", params={"cursor": fresh["next_cursor"]}).status_code
        == 200
    )
    with service.database.connect(write=True) as connection:
        service.emit(connection, "admin", "task.completed", "new-after-empty", "新", "不丢消息")
    incremental = client.get(
        BASE + "/notifications", params={"cursor": fresh["next_cursor"]}
    ).json()
    assert len(incremental["items"]) == 1 and incremental["items"][0]["title"] == "新"


def test_task_model_unknown_counts_reserved_call_and_retains_rule_checkpoint(agent):
    client, service = agent
    connection = post(
        client,
        "/connections",
        {
            "name": "超时夹具",
            "base_url": "https://fixture.example/v1",
            "model": "fixture",
            "background_allowed": True,
        },
    )
    task = post(
        client, "/tasks", {"use_ai": True, "connection_id": connection["id"], "max_calls": 2}
    )

    def timeout(*args, **kwargs):
        raise TimeoutError("unknown remote outcome")

    service.transport = timeout
    service.execute_task(service.claim_task())
    result = service.task(service.current_actor("admin"), task["id"])
    assert result["status"] == "failed" and result["counts"]["calls"] == 1
    assert result["checkpoint"] == 1 and len(result["results"]) == 1
    with service.database.connect() as connection:
        usage = connection.execute("SELECT calls,unknown_calls FROM agent_usage").fetchone()
    assert usage["calls"] == 1 and usage["unknown_calls"] == 1


@pytest.mark.parametrize(
    "base,expected",
    [
        ("https://music.example", "https://music.example/#agent/drafts/proposal-id"),
        ("http://music.example", None),
        ("https://localhost", None),
        ("https://127.0.0.1", None),
        ("https://192.168.1.1", None),
        ("https://music.example?token=private", None),
        ("https://user:secret@music.example", None),
        ("", None),
    ],
)
def test_external_detail_links_use_only_configured_public_https(base, expected):
    from wildstring.agent_notifications import Notifications

    assert Notifications.public_detail_url(base, "proposal-id") == expected
