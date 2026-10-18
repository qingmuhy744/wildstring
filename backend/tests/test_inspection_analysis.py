"""Inspection regressions use local rules and deterministic model fixtures."""

import json

import pytest
from test_agent_platform import agent as agent
from test_agent_platform import post

from wildstring.agent_automation import inspection_evidence
from wildstring.model_protocol import parse
from wildstring.outbound import OutboundError


@pytest.mark.parametrize(
    "reason,code",
    [
        ("length", "ai_output_limit"),
        ("content_filter", "ai_content_filtered"),
        ("aborted", "ai_response_failed"),
        ("insufficient_system_resource", "ai_response_failed"),
    ],
)
def test_chat_finish_reason_is_distinct_and_never_executes_partial_tools(reason, code):
    with pytest.raises(OutboundError, match=code):
        parse({}, {"choices": [{"finish_reason": reason, "message": {"tool_calls": []}}]})


@pytest.mark.parametrize(
    "status,details,code",
    [
        ("incomplete", {"reason": "max_output_tokens"}, "ai_output_limit"),
        ("incomplete", {"reason": "content_filter"}, "ai_content_filtered"),
        ("incomplete", {}, "ai_output_incomplete"),
        ("failed", {}, "ai_response_failed"),
    ],
)
def test_responses_failure_reasons(status, details, code):
    with pytest.raises(OutboundError, match=code):
        parse(
            {"options": {"protocol": "responses"}},
            {"status": status, "incomplete_details": details, "output": []},
        )


def test_evidence_finds_anomaly_after_eighty_clean_tracks_and_stays_bounded():
    clean = [{"track_id": str(i), "issues": []} for i in range(134)]
    clean[-1].update(
        issues=["missing_album"],
        title="尾部异常",
        metadata_version=7,
        path="/private/music",
        lyrics="private lyrics",
    )
    evidence = inspection_evidence(clean, {"processed": 134})
    assert evidence["affected"] == 1 and evidence["items"][0]["track_id"] == "133"
    assert evidence["issue_counts"] == {"missing_album": 1}
    assert "private" not in json.dumps(evidence)
    evidence = inspection_evidence([dict(clean[-1], title="长" * 10000) for _ in range(5000)], {})
    assert evidence["affected"] == 5000 and len(evidence["items"]) <= 20
    assert evidence["issue_counts"] == {"missing_album": 5000}
    assert len(json.dumps(evidence, ensure_ascii=False)) < 18000


def test_clean_inspection_skips_model_without_spending_budget(agent, monkeypatch):
    client, service = agent
    connection = post(
        client,
        "/connections",
        {"name": "unused model", "base_url": "https://fixture.invalid/v1", "model": "fixture"},
    )
    original = service.inspect

    def clean(*args, **kwargs):
        result = original(*args, **kwargs)
        for item in result["items"]:
            item["issues"] = []
        return result

    monkeypatch.setattr(service, "inspect", clean)
    service.transport = lambda *a, **k: pytest.fail("clean inspection must not call the model")
    task = post(
        client, "/tasks", {"use_ai": True, "connection_id": connection["id"], "max_calls": 0}
    )
    service.execute_task(service.claim_task())
    result = service.task(service.current_actor("admin"), task["id"])
    assert result["status"] == "succeeded" and result["stage"] == "completed"
    assert result["counts"]["processed"] == 1 and result["counts"]["calls"] == 0
    assert result["results"][-1]["ai_skipped"] is True
    assert "不能证明" in result["results"][-1]["analysis"]


def test_output_limit_keeps_rule_checkpoint_and_failure_stage_without_retry(agent):
    client, service = agent
    connection = post(
        client,
        "/connections",
        {"name": "limited model", "base_url": "https://fixture.invalid/v1", "model": "fixture"},
    )
    calls = []

    def limited(*args, **kwargs):
        calls.append(kwargs["payload"])
        return {
            "choices": [
                {
                    "finish_reason": "length",
                    "message": {
                        "content": "未完成",
                        "tool_calls": [
                            {
                                "id": "partial",
                                "function": {"name": "create_draft", "arguments": '{"kind":'},
                            }
                        ],
                    },
                }
            ]
        }

    service.transport = limited
    task = post(
        client, "/tasks", {"use_ai": True, "connection_id": connection["id"], "max_calls": 4}
    )
    service.execute_task(service.claim_task())
    actor = service.current_actor("admin")
    result = service.task(actor, task["id"])
    assert result["status"] == "failed" and result["stage"] == "model_call"
    assert result["error_code"] == "ai_output_limit" and result["checkpoint"] == 1
    assert len(result["results"]) == 1 and result["counts"]["failed"] == 0
    assert result["counts"]["calls"] == len(calls) == 1
    assert service.drafts(actor)["total"] == 0
    evidence = json.loads(calls[0]["messages"][1]["content"].split("\n", 1)[1])
    assert evidence["affected"] == 1 and "path" not in evidence["items"][0]


def test_resume_old_clean_failed_inspection_keeps_count_and_skips_paid_retry(agent):
    client, service = agent
    connection = post(
        client,
        "/connections",
        {"name": "unused model", "base_url": "https://fixture.invalid/v1", "model": "fixture"},
    )
    task = post(
        client, "/tasks", {"use_ai": True, "connection_id": connection["id"], "max_calls": 4}
    )
    actor = service.current_actor("admin")
    record = service.inspect(actor, task["parameters"]["track_ids"])["items"][0]
    record["issues"] = []
    with service.database.connect(write=True) as db:
        db.execute(
            "UPDATE agent_tasks SET status='failed',stage='completed',checkpoint=1,results=?,counts=?,error_code='ai_output_incomplete' WHERE id=?",
            (json.dumps([record]), json.dumps({"processed": 1, "calls": 1}), task["id"]),
        )
    service.transport = lambda *a, **k: pytest.fail("do not repeat paid analysis on resume")
    service.resume_task(actor, task["id"])
    service.execute_task(service.claim_task())
    result = service.task(actor, task["id"])
    assert result["status"] == "succeeded" and result["error_code"] is None
    assert result["counts"]["calls"] == 1 and result["counts"]["processed"] == 1
    assert result["results"][-1]["ai_skipped"] is True
