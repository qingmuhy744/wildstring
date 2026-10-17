"""Manual consent is scoped to one UI task; automation still needs explicit permission."""

import json

import pytest
from test_agent_platform import BASE, HEADERS, post
from test_agent_platform import agent as agent

from wildstring.ai_config import AIService, AIUpdate


def legacy_connection(service):
    ai = AIService(service.database.path.parent)
    ai.save(AIUpdate(version=1, base_url="https://fixture.invalid/v1", model="synthetic"))
    return "legacy"


def manual_parameters(identity):
    return {"use_ai": True, "connection_id": identity, "max_calls": 1, "max_tracks": 5}


def fake_model(calls):
    def respond(*args, **kwargs):
        calls.append(kwargs["payload"])
        return {"choices": [{"message": {"content": "已检查实际字段，建议待用户确认。"}}]}

    return respond


@pytest.mark.parametrize("legacy", [True, False])
def test_manual_ui_inspection_uses_connection_without_background_permission(agent, legacy):
    client, service = agent
    identity = (
        legacy_connection(service)
        if legacy
        else post(
            client,
            "/connections",
            {"name": "手动模型", "base_url": "https://fixture.invalid/v1", "model": "synthetic"},
        )["id"]
    )
    calls = []
    service.transport = fake_model(calls)
    task = post(client, "/tasks", manual_parameters(identity))
    assert "_manual_ai_authorized" not in task["parameters"]
    job = service.claim_task()
    service.execute_task(job)
    result = client.get(BASE + "/tasks/" + task["id"]).json()
    assert result["status"] == "succeeded"
    assert result["counts"]["calls"] == 1
    assert result["counts"]["processed"] == 1
    assert len(calls) == 1
    assert result["results"][-1]["analysis"]
    connections = client.get(BASE + "/connections").json()["items"]
    selected = next(c for c in connections if c["id"] == identity)
    assert selected["background_allowed"] is False
    assert selected["my_usage"]["calls"] == 1


def test_legacy_manual_consent_does_not_authorize_schedule_tools_or_forged_fields(agent):
    client, service = agent
    parameters = manual_parameters(legacy_connection(service))
    denied = client.post(
        BASE + "/schedules",
        json={"name": "定时任务", "parameters": parameters},
        headers=HEADERS,
    )
    assert denied.status_code == 403
    assert denied.json()["detail"] == "background_authorization_required"
    token = post(client, "/credentials", {"name": "MCP", "scopes": ["tasks:write", "library:read"]})
    cookies = dict(client.cookies)
    client.cookies.clear()
    denied = client.post(
        BASE + "/tasks",
        json=parameters,
        headers=HEADERS | {"Authorization": "Bearer " + token["token"]},
    )
    assert denied.status_code == 401
    client.cookies.update(cookies)
    for headers in [HEADERS, {"Authorization": "Bearer " + token["token"]}]:
        denied = client.post(BASE + "/tools/submit_inspection", json=parameters, headers=headers)
        assert denied.status_code == 403
        forged = client.post(
            BASE + "/tools/submit_inspection",
            json=parameters | {"_manual_ai_authorized": True},
            headers=headers,
        )
        assert forged.status_code == 422
    forged = client.post(
        BASE + "/tasks", json=parameters | {"_manual_ai_authorized": True}, headers=HEADERS
    )
    assert forged.status_code == 422
    assert client.get(BASE + "/tasks").json()["total"] == 0


@pytest.mark.parametrize("revoke", [False, True])
def test_scheduled_task_requires_automatic_permission_at_execution(agent, revoke):
    client, service = agent
    connection = post(
        client,
        "/connections",
        {
            "name": "定时模型",
            "base_url": "https://fixture.invalid/v1",
            "model": "synthetic",
            "background_allowed": True,
        },
    )
    schedule = post(
        client,
        "/schedules",
        {"name": "定时巡检", "enabled": True, "parameters": manual_parameters(connection["id"])},
    )
    with service.database.connect(write=True) as db:
        db.execute(
            "UPDATE agent_schedules SET next_run_at='2000-01-01T00:00:00+00:00' WHERE id=?",
            (schedule["id"],),
        )
    service.schedule_due()
    job = service.claim_task()
    assert job is not None and job["schedule_key"] is not None
    assert json.loads(job["parameters"])["_manual_ai_authorized"] is False
    if revoke:
        with service.database.connect(write=True) as db:
            db.execute(
                "UPDATE agent_connections SET background_allowed=0,version=version+1 WHERE id=?",
                (connection["id"],),
            )
    calls = []
    service.transport = fake_model(calls)
    service.execute_task(job)
    result = service.task(service.current_actor("admin"), job["id"])
    assert result["status"] == ("paused_authorization" if revoke else "succeeded")
    assert len(calls) == (0 if revoke else 1)


@pytest.mark.parametrize("change", ["old_task", "configuration", "account"])
def test_manual_task_requires_recorded_consent_and_current_authority(agent, change):
    client, service = agent
    task = post(client, "/tasks", manual_parameters(legacy_connection(service)))
    with service.database.connect(write=True) as connection:
        if change == "old_task":
            # A task queued by an older version has no explicit single-task consent.
            connection.execute(
                "UPDATE agent_tasks SET parameters=? WHERE id=?",
                (json.dumps(task["parameters"]), task["id"]),
            )
        elif change == "account":
            connection.execute("UPDATE users SET version=version+1 WHERE id='admin'")
    if change == "configuration":
        AIService(service.database.path.parent).save(
            AIUpdate(version=2, base_url="https://fixture.invalid/v1", model="changed")
        )
    calls = []
    service.transport = fake_model(calls)
    service.execute_task(service.claim_task())
    result = service.task(service.current_actor("admin"), task["id"])
    assert result["status"] == "paused_authorization"
    assert calls == []
    if change == "old_task":
        service.resume_task(service.current_actor("admin"), task["id"])
        service.execute_task(service.claim_task())
        assert (
            service.task(service.current_actor("admin"), task["id"])["status"]
            == "paused_authorization"
        )
        assert calls == []


def test_manual_task_keeps_daily_budget_and_rejects_missing_connection(agent):
    client, service = agent
    identity = post(
        client,
        "/connections",
        {
            "name": "限额模型",
            "base_url": "https://fixture.invalid/v1",
            "model": "synthetic",
            "daily_call_budget": 1,
        },
    )["id"]
    calls = []
    service.transport = fake_model(calls)
    for status in ["succeeded", "paused_budget"]:
        task = post(client, "/tasks", manual_parameters(identity))
        service.execute_task(service.claim_task())
        assert client.get(BASE + "/tasks/" + task["id"]).json()["status"] == status
    assert len(calls) == 1
    missing = client.post(BASE + "/tasks", json={"use_ai": True}, headers=HEADERS)
    assert missing.status_code == 422
    assert missing.json()["detail"] == "ai_connection_required"
