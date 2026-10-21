"""User-selected auto application and single-action review use the same guarded transaction."""

from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi import HTTPException
from test_agent_platform import BASE, first_track, playlist_draft, post
from test_personal_library import HEADERS

from wildstring.agent_models import ApplicationPolicy, Apply, DraftCreate

pytest_plugins = ("test_agent_platform",)


def policy(client, mode="automatic", kinds=None, version=1):
    response = client.put(
        BASE + "/application-policy",
        headers=HEADERS,
        json={"mode": mode, "kinds": kinds or ["playlist"], "version": version},
    )
    assert response.status_code == 200, response.text
    return response.json()


def test_accept_once_is_atomic_and_repeated_requests_are_idempotent(agent, monkeypatch):
    client, service = agent
    assert client.get(BASE + "/application-policy").json()["mode"] == "manual"
    draft = playlist_draft(client, first_track(client))
    actor = service.current_actor("admin")
    body = Apply(version=1, idempotency_key="one-accept-operation")
    original = service.emit
    with monkeypatch.context() as patch:

        def failure(*args, **kwargs):
            raise RuntimeError("transaction rollback")

        patch.setattr(service, "emit", failure)
        with pytest.raises(RuntimeError):
            service.accept_draft(actor, draft["id"], body)
    saved = service.draft(actor, draft["id"])
    assert saved["status"] == "pending" and saved["approved_version"] is None
    assert service.emit == original
    with ThreadPoolExecutor(max_workers=2) as workers:
        results = list(
            workers.map(lambda _: service.accept_draft(actor, draft["id"], body), range(2))
        )
    assert results[0] == results[1] and results[0]["status"] == "applied"
    assert results[0]["result"]["application_mode"] == "manual"
    with service.database.connect() as db:
        assert db.execute("SELECT count(*) FROM playlists WHERE name='新歌单'").fetchone()[0] == 1
        assert db.execute("SELECT count(*) FROM agent_audit").fetchone()[0] == 1
    assert (
        client.post(
            BASE + f"/drafts/{draft['id']}/accept",
            headers=HEADERS,
            json={"version": 2, "idempotency_key": body.idempotency_key},
        ).status_code
        == 409
    )


def test_automatic_creation_scope_gating_and_policy_revocation(agent):
    client, service = agent
    track = first_track(client)
    pending = playlist_draft(client, track)
    saved = policy(client)
    assert saved["version"] == 2
    assert client.get(BASE + "/notification-preferences").json()["timezone"] == "Asia/Shanghai"
    # Opt-in is not a retroactive application of every pending proposal.
    assert client.get(BASE + f"/drafts/{pending['id']}").json()["status"] == "pending"
    credential = post(
        client, "/credentials", {"name": "read and propose", "scopes": ["drafts:write"]}
    )
    bearer = {"Authorization": "Bearer " + credential["token"]}
    payload = {
        "kind": "playlist",
        "title": "Scoped proposal",
        "payload": {"name": "Scoped proposal", "track_ids": [track["id"]]},
    }
    scoped = client.post(BASE + "/tools/create_draft", headers=bearer, json=payload).json()[
        "result"
    ]
    assert scoped["status"] == "pending"
    applied = playlist_draft(client, track)
    assert applied["status"] == "applied" and applied["result"]["application_mode"] == "automatic"
    assert applied["result"]["policy_version"] == 2
    with service.database.connect() as db:
        events = [
            r[0]
            for r in db.execute("SELECT kind FROM agent_events WHERE draft_id=?", (applied["id"],))
        ]
    assert events == [
        "draft.applied"
    ]  # Never sends a misleading 'pending' notice for an applied draft.
    policy(client, "manual", version=2)
    assert playlist_draft(client, track)["status"] == "pending"
    assert (
        client.put(
            BASE + "/application-policy",
            headers=HEADERS,
            json={"mode": "automatic", "kinds": ["playlist"], "version": 2},
        ).status_code
        == 409
    )


def test_credential_cannot_self_authorize_or_accept_and_preserves_other_preferences(agent):
    client, service = agent
    client.put(BASE + "/assistant-preferences", headers=HEADERS, json={"retention_days": 45})
    policy(client)
    assert client.get(BASE + "/assistant-preferences").json()["retention_days"] == 45
    credential = post(
        client, "/credentials", {"name": "MCP", "scopes": ["drafts:write", "drafts:apply"]}
    )
    cookies = dict(client.cookies)
    client.cookies.clear()
    bearer = {"Authorization": "Bearer " + credential["token"]} | HEADERS
    assert (
        client.put(
            BASE + "/application-policy",
            headers=bearer,
            json={"mode": "automatic", "kinds": ["metadata"], "version": 2},
        ).status_code
        == 401
    )
    assert (
        client.post(
            BASE + "/drafts/fake/accept",
            headers=bearer,
            json={"version": 1, "idempotency_key": "fake-accept"},
        ).status_code
        == 401
    )
    read = client.post(BASE + "/tools/get_application_policy", headers=bearer, json={}).json()[
        "result"
    ]
    assert read["mode"] == "automatic"
    assert (
        client.post(
            BASE + "/tools/get_application_policy", headers=bearer, json={"mode": "automatic"}
        ).status_code
        == 422
    )
    client.cookies.update(cookies)
    client.put(BASE + "/assistant-preferences", headers=HEADERS, json={"retention_days": 30})
    assert client.get(BASE + "/application-policy").json()["mode"] == "automatic"


def test_policy_is_account_owned_and_normal_users_cannot_authorize_shared_library(agent):
    client, service = agent
    track = first_track(client)
    user = client.post(
        "/api/v1/manage/users",
        json={"username": "normal", "password": "normal-password-123", "profile": "listener"},
        headers=HEADERS,
    ).json()
    actor = service.current_actor(user["id"])
    assert service.application_policy(actor)["allowed_kinds"] == ["playlist"]
    with pytest.raises(HTTPException) as failure:
        service.save_application_policy(
            actor, ApplicationPolicy(mode="automatic", kinds=["metadata"], version=1)
        )
    assert failure.value.status_code == 403
    service.save_application_policy(
        actor, ApplicationPolicy(mode="automatic", kinds=["playlist"], version=1)
    )
    created = service.create_draft(
        actor,
        DraftCreate(
            kind="playlist",
            title="personal",
            payload={"name": "personal", "track_ids": [track["id"]]},
        ),
    )
    assert created["status"] == "applied"
    assert service.application_policy(service.current_actor("admin"))["mode"] == "manual"
    with pytest.raises(HTTPException):
        service.draft(service.current_actor("admin"), created["id"])


def test_auto_policy_rechecked_at_application_and_failure_preserves_proposal(agent, monkeypatch):
    client, service = agent
    track = first_track(client)
    policy(client)
    original = service.apply_draft

    def revoked(actor, identity, body, **kwargs):
        service.save_application_policy(
            actor, ApplicationPolicy(mode="manual", kinds=["playlist"], version=2)
        )
        return original(actor, identity, body, **kwargs)

    monkeypatch.setattr(service, "apply_draft", revoked)
    result = playlist_draft(client, track)
    assert result["status"] == "pending" and result["approved_version"] is None
    assert result["result"]["automatic_error"] == "draft_approval_required"


def test_manual_mode_can_be_saved_without_any_automatic_kind(agent):
    client, _ = agent
    response = client.put(
        BASE + "/application-policy",
        headers=HEADERS,
        json={"mode": "manual", "kinds": [], "version": 1},
    )
    assert response.status_code == 200
    assert response.json()["kinds"] == []
    assert playlist_draft(client, first_track(client))["status"] == "pending"
