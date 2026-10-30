"""Conversation management is account-scoped and leaves independent drafts intact."""

import json

from test_agent_platform import BASE, HEADERS, first_track, playlist_draft, post
from test_agent_platform import agent as agent


def test_rename_history_preserves_messages_and_only_accepts_valid_title(agent):
    client, _ = agent
    conversation = post(client, "/conversations", {"title": "旧标题"})
    path = "/conversations/" + conversation["id"]
    original = post(client, path + "/messages", {"content": "真实"})
    renamed = client.patch(BASE + path, headers=HEADERS, json={"title": "  许嵩收藏  "})
    assert renamed.status_code == 200
    result = renamed.json()
    assert result["title"] == "许嵩收藏"
    assert result["messages"] == original["messages"]
    assert result["runs"] == original["runs"]
    assert result["connection_id"] == original["connection_id"]
    assert client.get(BASE + "/conversations").json()["items"][0]["title"] == "许嵩收藏"
    for invalid in [
        {"title": "   "},
        {"title": "a" * 201},
        {"title": "别名", "connection_id": "legacy"},
    ]:
        assert client.patch(BASE + path, headers=HEADERS, json=invalid).status_code == 422
    assert client.get(BASE + path).json()["title"] == "许嵩收藏"


def test_delete_history_blocks_running_reply_and_keeps_other_history_and_drafts(agent):
    client, service = agent
    draft = playlist_draft(client, first_track(client))
    conversation = post(client, "/conversations", {"title": "待删除"})
    other = post(client, "/conversations", {"title": "保留"})
    path = "/conversations/" + conversation["id"]
    result = post(client, path + "/messages", {"content": "真实"})
    run = result["runs"][0]
    with service.database.connect(write=True) as db:
        db.execute(
            "UPDATE agent_runs SET status='running',draft_ids=? WHERE id=?",
            (json.dumps([draft["id"]]), run["id"]),
        )
    denied = client.delete(BASE + path, headers=HEADERS)
    assert denied.status_code == 409 and denied.json()["detail"] == "conversation_busy"
    assert client.get(BASE + path).json()["messages"] == result["messages"]
    with service.database.connect(write=True) as db:
        db.execute("UPDATE agent_runs SET status='succeeded' WHERE id=?", (run["id"],))
    deletion_response = client.delete(BASE + path, headers=HEADERS)
    assert deletion_response.status_code == 200
    assert client.get(BASE + path).status_code == 404
    assert client.get(BASE + "/conversations/" + other["id"]).status_code == 200
    assert client.get(BASE + "/drafts/" + draft["id"]).json()["status"] == "pending"
    with service.database.connect() as db:
        assert (
            db.execute(
                "SELECT count(*) FROM agent_messages WHERE conversation_id=?", (conversation["id"],)
            ).fetchone()[0]
            == 0
        )
        assert (
            db.execute(
                "SELECT count(*) FROM agent_runs WHERE conversation_id=?", (conversation["id"],)
            ).fetchone()[0]
            == 0
        )


def test_user_cannot_rename_or_delete_another_users_history(agent):
    client, service = agent
    conversation = post(client, "/conversations", {"title": "管理员历史"})
    path = BASE + "/conversations/" + conversation["id"]
    user = client.post(
        "/api/v1/manage/users",
        headers=HEADERS,
        json={"username": "reader", "password": "reader-password-123", "profile": "listener"},
    )
    assert user.status_code == 201
    client.cookies.clear()
    assert (
        client.post(
            "/api/v1/auth/login",
            headers=HEADERS,
            json={"username": "reader", "password": "reader-password-123"},
        ).status_code
        == 200
    )
    assert client.patch(path, headers=HEADERS, json={"title": "不应改名"}).status_code == 404
    client.delete(path, headers=HEADERS)
    assert (
        service.conversation(service.current_actor("admin"), conversation["id"])["title"]
        == "管理员历史"
    )
    own = post(client, "/conversations", {"title": "本人历史"})
    assert (
        client.patch(
            BASE + "/conversations/" + own["id"], headers=HEADERS, json={"title": "本人的新标题"}
        ).status_code
        == 200
    )


def test_first_message_summarizes_title_once_and_preserves_it_until_manual_rename(agent):
    client, _ = agent
    conversation = post(client, "/conversations", {})
    assert conversation["title"] == "新对话"
    path = "/conversations/" + conversation["id"]

    first_turn = post(
        client,
        path + "/messages",
        {"content": "帮我查漏补缺：许嵩全网热门 Top 10 我缺了哪几首？"},
    )
    assert first_turn["title"] == "许嵩全网热门 Top 10 查漏补缺"

    second_turn = post(
        client,
        path + "/messages",
        {"content": "再帮我推荐几首适合夜晚听的摇滚歌曲"},
    )
    assert second_turn["title"] == "许嵩全网热门 Top 10 查漏补缺"

    renamed = client.patch(BASE + path, headers=HEADERS, json={"title": "许嵩与夜晚摇滚"})
    assert renamed.status_code == 200
    assert renamed.json()["title"] == "许嵩与夜晚摇滚"

    third_turn = post(client, path + "/messages", {"content": "继续查找更多专辑"})
    assert third_turn["title"] == "许嵩与夜晚摇滚"
