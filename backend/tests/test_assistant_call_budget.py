"""Chat reserves a final answer within the selected budget, without live APIs."""

import json

from test_agent_platform import BASE, HEADERS, post
from test_agent_platform import agent as agent


def setup_chat(client):
    model = post(
        client,
        "/connections",
        {"name": "合成模型", "base_url": "https://model.example/v1", "model": "synthetic"},
    )
    chat = post(client, "/conversations", {"connection_id": model["id"]})
    return chat["id"], model["id"]


def search_message(identity):
    return {
        "choices": [
            {
                "message": {
                    "tool_calls": [
                        {
                            "id": identity,
                            "function": {
                                "name": "search_tracks",
                                "arguments": json.dumps({"q": "真实"}),
                            },
                        }
                    ]
                }
            }
        ]
    }


def test_chat_reserves_last_call_for_answer_without_exceeding_budget(agent):
    client, service = agent
    identity, connection = setup_chat(client)
    requests = []

    def model(*args, **kwargs):
        payload = kwargs["payload"]
        requests.append(payload)
        if payload["tool_choice"] == "auto":
            return search_message(f"search-{len(requests)}")
        assert payload["tool_choice"] == "none"
        assert "最后一次" in payload["messages"][-1]["content"]
        assert len([item for item in payload["messages"] if item["role"] == "tool"]) == 3
        return {"choices": [{"message": {"content": "已查询本地曲库，无法核实库外最新发行。"}}]}

    service.transport = model
    result = post(
        client,
        f"/conversations/{identity}/messages",
        {"content": "有哪些曲库外最新发行？", "max_calls": 4},
    )
    assert result["runs"][0]["status"] == "succeeded"
    assert result["runs"][0]["tool_calls"] == 3
    assert result["messages"][-1]["content"] == "已查询本地曲库，无法核实库外最新发行。"
    assert len(requests) == 4
    assert "没有实时网页搜索" in requests[0]["messages"][0]["content"]
    with service.database.connect() as database:
        assert (
            database.execute(
                "SELECT sum(calls) FROM agent_usage WHERE connection_id=?", (connection,)
            ).fetchone()[0]
            == 4
        )


def test_provider_ignoring_final_tool_choice_does_not_execute_more_tools(agent):
    client, service = agent
    identity, _ = setup_chat(client)
    requests = []

    def model(*args, **kwargs):
        requests.append(kwargs["payload"])
        return search_message("ignored-final-choice")

    service.transport = model
    result = post(
        client, f"/conversations/{identity}/messages", {"content": "找歌", "max_calls": 1}
    )
    run = result["runs"][0]
    assert run["status"] == "failed" and run["error_code"] == "ai_run_budget_exhausted"
    assert run["tool_calls"] == 0 and len(requests) == 1
    assert requests[0]["tool_choice"] == "none"
    assert "模型调用次数上限" in result["messages"][-1]["content"]
    assert "ai_run_budget_exhausted" not in result["messages"][-1]["content"]
    assert client.get(BASE + "/drafts").json()["total"] == 0


def test_saved_chat_max_calls_preference_is_used_when_message_omits_max_calls(agent):
    client, service = agent
    identity, _ = setup_chat(client)
    pref_res = client.put(
        BASE + "/assistant-preferences",
        headers=HEADERS,
        json={"retention_days": 30, "chat_max_calls": 6},
    )
    assert pref_res.status_code == 200
    assert pref_res.json()["chat_max_calls"] == 6
    requests = []

    def model(*args, **kwargs):
        payload = kwargs["payload"]
        requests.append(payload)
        if payload["tool_choice"] == "auto":
            return search_message(f"search-{len(requests)}")
        return {"choices": [{"message": {"content": "已完成 6 轮预算内的多步整理。"}}]}

    service.transport = model
    result = post(
        client,
        f"/conversations/{identity}/messages",
        {"content": "先搜专辑再拉曲目再生成批量风格草案"},
    )
    assert result["runs"][0]["status"] == "succeeded"
    assert result["runs"][0]["tool_calls"] == 5
    assert len(requests) == 6
