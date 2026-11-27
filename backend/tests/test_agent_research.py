"""Protocol and retrieval contracts use synthetic fixtures, never a private account."""

import json
from uuid import uuid4

import pytest
from fastapi import HTTPException
from test_agent_platform import BASE, post
from test_agent_platform import agent as agent
from test_personal_library import HEADERS

from wildstring.agent_models import Connection, Memory, SearchSettings
from wildstring.database import SCHEMA_VERSION
from wildstring.library.repository import now
from wildstring.model_protocol import parse, request
from wildstring.outbound import OutboundError


def answer(text="已核对来源", calls=None, reasoning=None):
    message = {"role": "assistant", "content": text, "tool_calls": calls or []}
    if reasoning:
        message["reasoning_content"] = reasoning
    return {"choices": [{"message": message}], "usage": {"total_tokens": 20}}


def call(name, args, identity="call-1"):
    return {
        "id": identity,
        "type": "function",
        "function": {"name": name, "arguments": json.dumps(args)},
    }


def connection(client, **options):
    return post(
        client,
        "/connections",
        {"name": "研究夹具", "base_url": "https://model.example/v1", "model": "fixture", **options},
    )


def test_multiple_connections_have_independent_settings_and_recommended_defaults(agent):
    client, service = agent
    first = connection(client, provider="deepseek", api_key="synthetic-first-key")
    second = connection(
        client,
        name="备用连接",
        model="alternate-fixture",
        api_key="synthetic-second-key",
        timeout=45,
        reasoning_effort="none",
        max_output_tokens=4096,
    )
    assert first["id"] != second["id"]
    assert (first["timeout"], first["reasoning_effort"], first["max_output_tokens"]) == (
        90,
        "low",
        8192,
    )
    _, payload = request({"model": first["model"], "options": first}, [])
    assert payload["max_tokens"] == 8192 and payload["reasoning_effort"] == "low"
    assert payload["thinking"] == {"type": "enabled"}
    edited = client.patch(
        BASE + "/connections/" + second["id"],
        headers=HEADERS,
        json={
            "name": "备用已改名",
            "base_url": second["base_url"],
            "model": second["model"],
            "version": second["version"],
        },
    )
    assert edited.status_code == 200
    assert edited.json()["timeout"] == 45
    response = client.delete(BASE + "/connections/" + first["id"], headers=HEADERS)
    assert response.status_code == 200
    remaining = client.get(BASE + "/connections").json()["items"]
    assert [item["id"] for item in remaining] == [second["id"]]
    assert (
        remaining[0]["timeout"],
        remaining[0]["reasoning_effort"],
        remaining[0]["max_output_tokens"],
    ) == (45, "none", 4096)
    assert "synthetic-second-key" not in json.dumps(remaining)


def test_protocol_preserves_reasoning_and_response_items():
    config = {
        "model": "deepseek-flash",
        "options": {"provider": "deepseek", "reasoning_effort": "high"},
    }
    _, body = request(
        config,
        [
            {
                "role": "assistant",
                "content": None,
                "reasoning_content": "synthetic-state",
                "tool_calls": [call("search_tracks", {})],
            }
        ],
    )
    assert body["messages"][0]["reasoning_content"] == "synthetic-state"
    assert body["thinking"] == {"type": "enabled"}
    config["options"] = {"protocol": "responses", "provider": "openai"}
    output = [
        {"type": "reasoning", "encrypted_content": "opaque-fixture"},
        {"type": "function_call", "call_id": "f1", "name": "search_tracks", "arguments": "{}"},
    ]
    message = parse(config, {"status": "completed", "output": output})
    path, body = request(
        config,
        [{"role": "assistant", **message}, {"role": "tool", "tool_call_id": "f1", "content": "[]"}],
    )
    assert path == "/responses" and body["store"] is False
    assert body["include"] == ["reasoning.encrypted_content"]
    assert body["input"][:2] == output
    assert body["input"][-1]["call_id"] == "f1"
    with pytest.raises(OutboundError, match="ai_output_incomplete"):
        parse(config, {"status": "incomplete", "output": []})


def test_native_search_sources_and_optional_annotations_are_preserved():
    config = {
        "model": "fixture",
        "options": {"protocol": "responses", "provider": "openai", "native_search": True},
    }
    output = [
        {
            "type": "web_search_call",
            "action": {
                "sources": [{"url": "https://example.com/official", "title": "官方发行公告"}]
            },
        },
        {
            "type": "message",
            "content": [{"type": "output_text", "text": "已核对", "annotations": None}],
        },
    ]
    message = parse(config, {"status": "completed", "output": output})
    assert message["_sources"][0]["title"] == "官方发行公告"
    assert message["_response_items"] == output
    tools = [
        {
            "type": "function",
            "function": {"name": "probe", "parameters": {"type": "object", "properties": {}}},
        }
    ]
    _, body = request(config, [{"role": "user", "content": "查发行记录"}], tools=tools)
    assert body["tools"][-1] == {"type": "web_search"} and body["tools"][0]["strict"] is False
    assert "web_search_call.action.sources" in body["include"]
    _, final = request(
        config, [{"role": "user", "content": "汇总"}], tools=tools, tool_choice="none"
    )
    assert all(tool["type"] == "function" for tool in final["tools"])
    assert final["include"] == ["reasoning.encrypted_content"]


@pytest.mark.parametrize("provider", ["deepseek", "tavily"])
def test_search_read_and_sources_are_real_tool_results(agent, provider):
    client, service = agent
    c = connection(client, provider="deepseek", reasoning_effort="high", max_output_tokens=8192)
    post_result = client.put(
        BASE + "/search-settings",
        headers=HEADERS,
        json={
            "provider": provider,
            "enabled": True,
            "api_key": "synthetic-search-key-123",
            "version": 0,
        },
    )
    assert post_result.status_code == 200
    seen, network = [], []

    def search(url, **kwargs):
        network.append((url, kwargs))
        if url.endswith("search"):
            return {
                "results": [
                    {
                        "title": "艺人正式发行公告",
                        "url": "https://example.com/release?id=42",
                        "summary": "2026年发行记录",
                    }
                ]
            }
        return {
            "content": "正式发行日期为2026年10月18日",
            "results": [{"raw_content": "正式发行日期为2026年10月18日"}],
        }

    def model(url, **kwargs):
        body = kwargs["payload"]
        seen.append(body)
        assert body["max_tokens"] == 8192
        if len(seen) == 1:
            return answer(
                "", [call("search_web", {"query": "艺人 最新发行 2026年10月"})], "state-one"
            )
        assert any(m.get("reasoning_content") == "state-one" for m in body["messages"])
        if len(seen) == 2:
            source = json.loads(body["messages"][-1]["content"])["sources"][0]
            return answer(
                "", [call("read_webpage", {"source_id": source["id"]}, "call-2")], "state-two"
            )
        assert "2026年10月18日" in body["messages"][-1]["content"]
        return answer("根据正式发行公告，日期为2026年10月18日。")

    service.transport, service.search_transport = model, search
    conversation = post(client, "/conversations", {"connection_id": c["id"]})
    result = post(
        client,
        f"/conversations/{conversation['id']}/messages",
        {"content": "最近发行了什么？", "max_calls": 4},
    )
    message = result["messages"][-1]
    assert message["sources"][0]["url"].endswith("?id=42")
    assert len(network) == 2 and len(seen) == 3
    assert result["runs"][0]["status"] == "succeeded"
    assert service.search_settings(service.current_actor("admin"))["requests_today"] == 2
    assert "synthetic-search-key-123" not in json.dumps(result)


def test_search_disabled_budget_version_and_arbitrary_url_guard(agent):
    client, service = agent
    actor = service.current_actor("admin")
    service.save_search_settings(
        actor, SearchSettings(enabled=True, daily_budget=1, api_key="synthetic-key", version=0)
    )
    settings = service.search_settings(actor)
    service.search_transport = lambda *a, **k: {"results": []}
    assert (
        service.research_tool(actor, settings, "search_web", {"query": "空结果"}, {}, None)[
            "sources"
        ]
        == []
    )
    assert (
        service.research_tool(actor, settings, "search_web", {"query": "空结果"}, {}, None)[
            "sources"
        ]
        == []
    )
    assert service.search_settings(actor)["requests_today"] == 1
    with pytest.raises(HTTPException, match="search_daily_budget_exhausted"):
        service.research_tool(actor, settings, "search_web", {"query": "again"}, {}, None)
    with pytest.raises(HTTPException, match="web_source_not_in_current_run"):
        service.research_tool(
            actor, settings, "read_webpage", {"source_id": "https://127.0.0.1/secret"}, {}, None
        )
    service.save_search_settings(actor, SearchSettings(enabled=False, version=1))
    with pytest.raises(HTTPException, match="search_settings_changed"):
        service.web_request(actor, settings, "search", {"query": "revoked"})


def test_memory_is_explicit_versioned_private_and_compaction_is_budgeted(agent):
    client, service = agent
    actor = service.current_actor("admin")
    memory = post(client, "/memories", {"content": "喜欢摇滚原版，优先录音室版本"})
    other = type(actor)("unrelated-user", "user", 1)
    assert service.memories(other) == []
    with pytest.raises(HTTPException, match="memory_version_conflict"):
        service.save_memory(other, Memory(content="不能修改他人记忆", version=1), memory["id"])
    c = connection(client)
    conversation = post(client, "/conversations", {"connection_id": c["id"]})
    with service.database.connect(write=True) as db:
        for index in range(24):
            db.execute(
                "INSERT INTO agent_messages VALUES (?,?,?,?,?,?)",
                (
                    uuid4().hex,
                    conversation["id"],
                    "user" if index % 2 == 0 else "assistant",
                    f"第{index}条：最早约定只考虑录音室版本",
                    now(),
                    None,
                ),
            )
    seen = []

    def model(url, **kwargs):
        seen.append(kwargs["payload"])
        if "压缩" in seen[-1]["messages"][0]["content"]:
            return answer("用户希望只考虑录音室版本，尚未更改音乐资料。")
        text = json.dumps(seen[-1]["messages"], ensure_ascii=False)
        assert "历史摘要" in text and "喜欢摇滚原版" in text
        return answer("会优先录音室版本。")

    service.transport = model
    result = post(
        client,
        f"/conversations/{conversation['id']}/messages",
        {"content": "继续推荐", "max_calls": 2},
    )
    assert len(seen) == 2 and result["context_summary"]["summary"]
    assert len(service.memories(actor)) == 1
    service.delete_memory(actor, memory["id"])
    assert (
        service.memories(actor) == []
        and service.conversation(actor, conversation["id"])["context_summary"] is None
    )


def test_new_options_preserved_when_old_client_edits_and_native_search_guard(agent):
    client, service = agent
    c = connection(
        client,
        protocol="responses",
        provider="deepseek",
        model="deepseek-v4-pro",
        max_output_tokens=8192,
    )
    result = client.patch(
        BASE + "/connections/" + c["id"],
        headers=HEADERS,
        json={"name": "旧客户端改名", "base_url": c["base_url"], "model": c["model"], "version": 1},
    )
    assert result.status_code == 200
    assert result.json()["protocol"] == "responses" and result.json()["max_output_tokens"] == 8192
    actor = service.current_actor("admin")
    with pytest.raises(HTTPException, match="native_search_requires_deepseek_pro"):
        service.save_connection(
            actor,
            Connection(
                name="不支持",
                base_url="https://model.example",
                model="deepseek-flash",
                protocol="responses",
                provider="deepseek",
                native_search=True,
            ),
        )


def test_v18_migration_is_atomic_and_preserves_existing_connection(agent, monkeypatch):
    from migration_support import pre19

    import wildstring.research_schema as migration

    client, service = agent
    c = connection(client, api_key="synthetic-preserved-model-secret")
    with service.database.connect(write=True) as db:
        original = dict(
            db.execute("SELECT * FROM agent_connections WHERE id=?", (c["id"],)).fetchone()
        )
        pre19(db)
        db.execute("PRAGMA user_version=18")
    schema = migration.SCHEMA
    monkeypatch.setattr(
        migration,
        "SCHEMA",
        schema.replace("PRAGMA user_version=19;", "INVALID MIGRATION;\nPRAGMA user_version=19;"),
    )
    import sqlite3

    with pytest.raises(sqlite3.OperationalError):
        service.database.initialize()
    with service.database.connect() as db:
        assert db.execute("PRAGMA user_version").fetchone()[0] == 18
        assert "options" not in {
            row[1] for row in db.execute("PRAGMA table_info(agent_connections)")
        }
    monkeypatch.setattr(migration, "SCHEMA", schema)
    service.database.initialize()
    with service.database.connect() as db:
        current = dict(
            db.execute("SELECT * FROM agent_connections WHERE id=?", (c["id"],)).fetchone()
        )
        assert db.execute("PRAGMA user_version").fetchone()[0] == SCHEMA_VERSION
    assert {k: v for k, v in current.items() if k != "options"} == {
        k: v for k, v in original.items() if k != "options"
    }
    assert current["options"] == "{}"
    assert service.read_secret(current["secret_ref"]) == "synthetic-preserved-model-secret"


def test_gemini_native_protocol_payload_continuation_grounding_and_validation(agent):
    client, service = agent
    actor = service.current_actor("admin")

    # Gemini 2.5 maps reasoning_effort to thinkingBudget; Gemini 3/4 maps to thinkingLevel.
    path25, body25 = request(
        {
            "model": "models/gemini-2.5-pro",
            "options": {
                "protocol": "gemini",
                "provider": "gemini",
                "reasoning_effort": "medium",
                "max_output_tokens": 4096,
                "native_search": True,
            },
        },
        [
            {"role": "system", "content": "你是音乐助手。"},
            {"role": "user", "content": "查一下最近发行"},
        ],
        tools=[
            {
                "type": "function",
                "function": {
                    "name": "search_tracks",
                    "description": "Search tracks",
                    "parameters": {
                        "type": "object",
                        "properties": {"q": {"type": "string"}},
                        "additionalProperties": False,
                    },
                },
            }
        ],
    )
    assert path25 == "/models/gemini-2.5-pro:generateContent"
    assert body25["systemInstruction"] == {"parts": [{"text": "你是音乐助手。"}]}
    assert body25["generationConfig"] == {
        "maxOutputTokens": 4096,
        "thinkingConfig": {"thinkingBudget": 8192},
    }
    assert body25["tools"][0]["functionDeclarations"][0]["parametersJsonSchema"] == {
        "type": "object",
        "properties": {"q": {"type": "string"}},
        "additionalProperties": False,
    }
    assert body25["tools"][1] == {"googleSearch": {}}

    _, body3 = request(
        {
            "model": "gemini-3-pro",
            "options": {
                "protocol": "gemini",
                "provider": "gemini",
                "reasoning_effort": "high",
                "max_output_tokens": 2048,
            },
        },
        [{"role": "user", "content": "hello"}],
    )
    assert body3["generationConfig"]["thinkingConfig"] == {"thinkingLevel": "high"}

    # Parse response with thought part (filtered from text), thoughtSignature, multi-calls, grounding.
    raw_parts = [
        {"text": "hidden chain of thought", "thought": True, "thoughtSignature": "sig-t"},
        {
            "functionCall": {"id": "fc-1", "name": "search_tracks", "args": {"q": "许巍"}},
            "thoughtSignature": "sig-fc1",
        },
        {"functionCall": {"name": "get_track", "args": {"track_id": "t1"}}},
    ]
    parsed = parse(
        {"options": {"protocol": "gemini"}},
        {
            "candidates": [
                {
                    "content": {"role": "model", "parts": raw_parts},
                    "finishReason": "STOP",
                    "groundingMetadata": {
                        "groundingChunks": [
                            {"web": {"uri": "https://example.org/album", "title": "官方发行页"}}
                        ]
                    },
                }
            ]
        },
    )
    assert parsed["content"] == ""
    assert len(parsed["tool_calls"]) == 2
    assert parsed["tool_calls"][0]["id"] == "fc-1"
    assert parsed["tool_calls"][1]["id"] == "gemini-call-2"
    assert parsed["_gemini_parts"] == raw_parts
    assert parsed["_sources"] == [{"url": "https://example.org/album", "title": "官方发行页"}]

    # Consecutive tool messages must be grouped into a single Gemini user turn.
    _, next_body = request(
        {
            "model": "gemini-2.5-flash",
            "options": {"protocol": "gemini", "reasoning_effort": "auto"},
        },
        [
            {"role": "user", "content": "查一下"},
            {"role": "assistant", "content": None, "tool_calls": parsed["tool_calls"], **parsed},
            {"role": "tool", "tool_call_id": "fc-1", "content": '{"items":[]}'},
            {"role": "tool", "tool_call_id": "gemini-call-2", "content": "[1,2]"},
        ],
        tools=[{"type": "function", "function": {"name": "search_tracks", "description": "d"}}],
        tool_choice="none",
    )
    assert "thinkingConfig" not in next_body["generationConfig"]
    assert next_body["toolConfig"] == {"functionCallingConfig": {"mode": "NONE"}}
    assert next_body["contents"][1] == {"role": "model", "parts": raw_parts}
    assert next_body["contents"][2] == {
        "role": "user",
        "parts": [
            {
                "functionResponse": {
                    "id": "fc-1",
                    "name": "search_tracks",
                    "response": {"items": []},
                }
            },
            {"functionResponse": {"name": "get_track", "response": {"result": [1, 2]}}},
        ],
    }

    for reason, expected_code in (
        ("MAX_TOKENS", "ai_output_limit"),
        ("SAFETY", "ai_content_filtered"),
        ("MALFORMED_FUNCTION_CALL", "ai_response_failed"),
    ):
        with pytest.raises(OutboundError, match=expected_code):
            parse(
                {"options": {"protocol": "gemini"}},
                {"candidates": [{"content": {"parts": []}, "finishReason": reason}]},
            )
    with pytest.raises(OutboundError, match="ai_content_filtered"):
        parse(
            {"options": {"protocol": "gemini"}},
            {"promptFeedback": {"blockReason": "SAFETY"}},
        )

    # Save connection validation + x-goog-api-key header + usageMetadata token accounting.
    saved = connection(
        client,
        name="Gemini 原生测试",
        base_url="https://generativelanguage.googleapis.com/v1beta",
        model="gemini-2.5-flash",
        api_key="synthetic-gemini-api-key",
        protocol="gemini",
        native_search=True,
        reasoning_effort="low",
        background_allowed=True,
    )
    assert saved["protocol"] == "gemini" and saved["provider"] == "gemini"
    assert saved["native_search"] is True

    captured = []

    def fake_transport(url, *, payload, headers, **kwargs):
        captured.append((url, payload, headers))
        return {
            "candidates": [
                {
                    "content": {"role": "model", "parts": [{"text": "已通过原生接口回答"}]},
                    "finishReason": "STOP",
                }
            ],
            "usageMetadata": {
                "promptTokenCount": 11,
                "candidatesTokenCount": 7,
                "totalTokenCount": 18,
            },
        }

    service.transport = fake_transport
    cfg = service.connection_for(actor, saved["id"])
    reply = service.model_request(actor, cfg, [{"role": "user", "content": "hi"}], background=True)
    assert reply["content"] == "已通过原生接口回答"
    assert (
        captured[0][0]
        == "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent"
    )
    assert captured[0][2] == {"x-goog-api-key": "synthetic-gemini-api-key"}
    assert "tools" not in captured[0][1]  # background=True suppresses native_search
    assert (
        service.usage_summary(actor, saved["id"], saved["daily_call_budget"])["my_usage"]["tokens"]
        == 18
    )

    with pytest.raises(HTTPException, match="reasoning_effort_not_supported"):
        service.save_connection(
            actor,
            Connection(
                name="不支持max",
                base_url="https://generativelanguage.googleapis.com/v1beta",
                model="gemini-2.5-flash",
                protocol="gemini",
                provider="gemini",
                reasoning_effort="max",
            ),
        )
    with pytest.raises(HTTPException, match="invalid_protocol_provider"):
        service.save_connection(
            actor,
            Connection(
                name="协议不匹配",
                base_url="https://generativelanguage.googleapis.com/v1beta",
                model="gemini-2.5-flash",
                protocol="gemini",
                provider="openai",
            ),
        )
    with pytest.raises(HTTPException, match="invalid_ai_model"):
        service.save_connection(
            actor,
            Connection(
                name="非法模型名",
                base_url="https://generativelanguage.googleapis.com/v1beta",
                model="../evil?key=1",
                protocol="gemini",
                provider="gemini",
            ),
        )
