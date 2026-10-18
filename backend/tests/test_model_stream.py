"""Streaming protocol and durable, permission-checked answer previews."""

import io
import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import pytest
from test_agent_platform import BASE, post
from test_agent_platform import agent as agent
from test_assistant_call_budget import setup_chat

from wildstring.model_protocol import parse
from wildstring.model_stream import collect
from wildstring.outbound import OutboundError


class Events(io.BytesIO):
    headers = {"Content-Type": "text/event-stream; charset=utf-8"}


def stream(*events):
    return Events(
        "".join(
            "data: " + (e if isinstance(e, str) else json.dumps(e)) + "\r\n\r\n" for e in events
        ).encode()
    )


def collect_events(events, protocol="chat_completions", limit=65536):
    previews = []
    value = collect(events, limit, protocol, previews.append, time.monotonic() + 10)
    return value, previews


def chunk(delta, finish=None, **extra):
    return {"choices": [{"index": 0, "delta": delta, "finish_reason": finish}], **extra}


def test_chat_deltas_join_tools_and_reasoning_without_disclosing_reasoning():
    result, previews = collect_events(
        stream(
            chunk({"reasoning_content": "private continuation"}),
            chunk({"content": "找到"}),
            chunk({"content": "歌曲"}),
            chunk(
                {
                    "tool_calls": [
                        {
                            "index": 0,
                            "id": "call-1",
                            "extra_content": {"google": {"thought_signature": "opaque"}},
                            "function": {"name": "search_tracks", "arguments": '{"q":'},
                        }
                    ]
                }
            ),
            chunk(
                {"tool_calls": [{"index": 0, "function": {"arguments": '"许巍"}'}}]},
                "tool_calls",
                usage={"total_tokens": 42},
            ),
            "[DONE]",
        )
    )
    message = parse({}, result)
    assert previews == ["找到", "找到歌曲"]
    assert message["reasoning_content"] == "private continuation"
    assert json.loads(message["tool_calls"][0]["function"]["arguments"]) == {"q": "许巍"}
    assert message["tool_calls"][0]["extra_content"] == {"google": {"thought_signature": "opaque"}}
    assert result["usage"]["total_tokens"] == 42


def test_responses_keeps_completed_items_sources_and_usage():
    final = {
        "status": "completed",
        "output": [
            {
                "type": "message",
                "content": [
                    {
                        "type": "output_text",
                        "text": "完整回答",
                        "annotations": [
                            {"type": "url_citation", "url": "https://example.org", "title": "来源"}
                        ],
                    }
                ],
            }
        ],
        "usage": {"input_tokens": 12, "output_tokens": 3},
    }
    result, previews = collect_events(
        stream(
            {"type": "response.reasoning_text.delta", "delta": "private reasoning"},
            {"type": "response.output_text.delta", "delta": "完整"},
            {"type": "response.output_text.delta", "delta": "回答"},
            {"type": "response.completed", "response": final},
        ),
        "responses",
    )
    assert result == final and previews == ["完整", "完整回答"]
    assert parse({"options": {"protocol": "responses"}}, result)["_sources"][0]["title"] == "来源"


@pytest.mark.parametrize("protocol", ["chat_completions", "responses"])
def test_disconnected_stream_is_incomplete(protocol):
    with pytest.raises(OutboundError, match="ai_output_incomplete"):
        collect_events(
            stream({"type": "response.output_text.delta", "delta": "partial"})
            if protocol == "responses"
            else stream(chunk({"content": "partial"})),
            protocol,
        )


def test_stream_bounds_and_terminal_limit_are_preserved():
    with pytest.raises(OutboundError, match="response_too_large"):
        collect_events(stream(chunk({"content": "x" * 1000})), limit=100)
    value, _ = collect_events(stream(chunk({"content": "截断"}, "length"), "[DONE]"))
    with pytest.raises(OutboundError, match="ai_output_limit"):
        parse({}, value)


def test_answer_preview_visible_before_completion_and_saved_once(agent, monkeypatch):
    client, service = agent
    identity, _ = setup_chat(client)
    ready, release = threading.Event(), threading.Event()

    def transport(*args, on_text, **kwargs):
        on_text("## 正在生成\n\n**已经收到的回答**")
        ready.set()
        assert release.wait(10)
        return {
            "choices": [
                {"message": {"content": "## 完整回答\n\n已经结束"}, "finish_reason": "stop"}
            ]
        }

    monkeypatch.setattr("wildstring.model_stream.stream_request", transport)
    with ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(
            post,
            client,
            f"/conversations/{identity}/messages",
            {"content": "测试流式回答", "max_calls": 1},
        )
        try:
            assert ready.wait(10)
            preview = client.get(BASE + f"/conversations/{identity}").json()
            assert preview["runs"][0]["status"] == "running"
            assert preview["runs"][0]["stage"] == "writing"
            assert preview["messages"][-1]["partial"]
            assert "已经收到" in preview["messages"][-1]["content"]
        finally:
            release.set()
        final = future.result(timeout=10)
    assert len(final["messages"]) == 2
    assert not final["messages"][-1]["partial"]
    assert final["messages"][-1]["content"].startswith("## 完整回答")
    assert final["runs"][0]["stage"] is None
    assert not service.chat_progress


def test_stream_failure_retains_partial_answer_and_error(agent, monkeypatch):
    client, _ = agent
    identity, _ = setup_chat(client)
    requests = []

    def transport(*args, on_text, **kwargs):
        requests.append(kwargs)
        on_text("已经取得的部分答案")
        raise OutboundError("ai_output_incomplete")

    monkeypatch.setattr("wildstring.model_stream.stream_request", transport)
    final = post(client, f"/conversations/{identity}/messages", {"content": "测试", "max_calls": 1})
    assert final["runs"][0]["status"] == "failed"
    assert "已经取得的部分答案" in final["messages"][-1]["content"]
    assert "ai_output_incomplete" in final["messages"][-1]["content"]
    assert len(requests) == 1


def test_secret_split_between_deltas_never_enters_preview(agent, monkeypatch):
    client, _ = agent
    key = "synthetic-secret-do-not-disclose"
    connection = post(
        client,
        "/connections",
        {
            "name": "secret fixture",
            "base_url": "https://model.example",
            "model": "synthetic",
            "api_key": key,
        },
    )
    chat = post(client, "/conversations", {"connection_id": connection["id"]})
    captured = []

    def transport(*args, on_text, **kwargs):
        text = "普通回答开头，提供有用的信息。" * 4
        on_text(text + key[:12])
        captured.append(
            client.get(BASE + f"/conversations/{chat['id']}").json()["messages"][-1]["content"]
        )
        on_text(text + key)
        raise AssertionError("Sensitive output must be rejected")

    monkeypatch.setattr("wildstring.model_stream.stream_request", transport)
    final = post(
        client, f"/conversations/{chat['id']}/messages", {"content": "测试", "max_calls": 1}
    )
    assert final["runs"][0]["error_code"] == "ai_sensitive_response"
    assert all(key[:12] not in value for value in captured)
    assert key not in json.dumps(final)
