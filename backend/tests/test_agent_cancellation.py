"""Real task/model-loop checkpoints with controlled external responses; no live API calls."""

import json

from test_agent_platform import agent as agent
from test_agent_platform import post


def pending_ai_task(client, service):
    # Keep this regression focused on cancellation rather than cold library-ID initialization.
    assert service.library_id
    connection = post(
        client,
        "/connections",
        {
            "name": "synthetic cancellation model",
            "base_url": "https://fixture.invalid/v1",
            "model": "synthetic",
            "background_allowed": True,
        },
    )
    task = post(
        client,
        "/tasks",
        {"use_ai": True, "connection_id": connection["id"], "max_calls": 3},
    )
    job = service.claim_task()
    assert job["id"] == task["id"]
    return task, job, service.current_actor("admin")


def message(*, content=None, tools=None):
    return {
        "choices": [
            {
                "message": {
                    "role": "assistant",
                    "content": content,
                    **({"tool_calls": tools} if tools else {}),
                }
            }
        ]
    }


def tool(name, arguments, identity):
    return {
        "id": identity,
        "type": "function",
        "function": {"name": name, "arguments": json.dumps(arguments)},
    }


def test_cancelled_before_first_model_request_does_not_reserve_or_send(agent):
    client, service = agent
    task, job, actor = pending_ai_task(client, service)
    calls = []
    service.transport = lambda *args, **kwargs: calls.append(1)
    service.cancel_task(actor, task["id"])
    service.execute_task(job)
    result = service.task(actor, task["id"])
    assert result["status"] == "cancelled"
    assert result["counts"]["calls"] == 0 and calls == []


def test_cancel_during_model_request_skips_returned_tools_and_next_paid_request(agent):
    client, service = agent
    task, job, actor = pending_ai_task(client, service)
    calls = []

    def transport(*args, **kwargs):
        calls.append(1)
        service.cancel_task(actor, task["id"])
        return message(tools=[tool("search_tracks", {}, "read-after-cancel")])

    service.transport = transport
    service.execute_task(job)
    result = service.task(actor, task["id"])
    assert result["status"] == "cancelled"
    assert len(calls) == result["counts"]["calls"] == 1
    assert service.drafts(actor)["total"] == 0
    assert len(result["results"]) == 1 and "track_id" in result["results"][0]


def test_cancel_after_read_tool_stops_the_next_model_request(agent, monkeypatch):
    client, service = agent
    task, job, actor = pending_ai_task(client, service)
    calls, executed = [], []

    def transport(*args, **kwargs):
        calls.append(1)
        return message(tools=[tool("search_tracks", {}, "first-read")])

    original = service.execute_tool

    def execute(*args, **kwargs):
        result = original(*args, **kwargs)
        executed.append(args[1])
        service.cancel_task(actor, task["id"])
        return result

    monkeypatch.setattr(service, "execute_tool", execute)
    service.transport = transport
    service.execute_task(job)
    result = service.task(actor, task["id"])
    assert result["status"] == "cancelled"
    assert executed == ["search_tracks"] and len(calls) == 1
    assert result["counts"]["calls"] == 1
    assert result["results"][-1]["partial"] is True


def test_cancel_between_tools_preserves_created_draft_and_its_checkpoint(agent, monkeypatch):
    client, service = agent
    task, job, actor = pending_ai_task(client, service)
    payload = {
        "kind": "playlist",
        "title": "retained",
        "payload": {"name": "retained", "track_ids": []},
    }
    calls, executed = [], []

    def transport(*args, **kwargs):
        calls.append(1)
        return message(
            tools=[
                tool("create_draft", payload, "first"),
                tool("create_draft", payload, "never-start"),
            ]
        )

    original = service.execute_tool

    def execute(*args, **kwargs):
        result = original(*args, **kwargs)
        executed.append(args[1])
        service.cancel_task(actor, task["id"])
        return result

    monkeypatch.setattr(service, "execute_tool", execute)
    service.transport = transport
    service.execute_task(job)
    result = service.task(actor, task["id"])
    drafts = service.drafts(actor)
    assert result["status"] == "cancelled"
    assert len(calls) == 1 and executed == ["create_draft"]
    assert drafts["total"] == 1 and drafts["items"][0]["status"] == "pending"
    assert result["results"][-1]["draft_ids"] == [drafts["items"][0]["id"]]
    assert result["results"][-1]["partial"] is True
    with service.database.connect() as connection:
        assert connection.execute("SELECT count(*) FROM agent_audit").fetchone()[0] == 0


def test_server_stopping_between_model_and_tool_marks_interrupted(agent):
    client, service = agent
    task, job, actor = pending_ai_task(client, service)
    calls = []

    def transport(*args, **kwargs):
        calls.append(1)
        service.stop_event.set()
        return message(tools=[tool("search_tracks", {}, "not-started")])

    service.transport = transport
    service.execute_task(job)
    result = service.task(actor, task["id"])
    assert result["status"] == "interrupted"
    assert result["error_code"] == "service_stopping" and len(calls) == 1


def test_success_replaces_partial_tool_checkpoint_without_duplicate_results(agent):
    client, service = agent
    task, job, actor = pending_ai_task(client, service)
    calls = []

    def transport(*args, **kwargs):
        calls.append(1)
        return (
            message(tools=[tool("search_tracks", {}, "first-read")])
            if len(calls) == 1
            else message(content="Finished using actual tool results.")
        )

    service.transport = transport
    service.execute_task(job)
    result = service.task(actor, task["id"])
    assert result["status"] == "succeeded" and len(calls) == 2
    assert len(result["results"]) == 2
    assert result["results"][-1]["analysis"] == "Finished using actual tool results."
    assert "partial" not in result["results"][-1]
