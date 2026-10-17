"""Every settings list must honor paging, including clients reading beyond 100."""

import pytest
from fastapi import HTTPException

HEADERS = {"X-Wildstring-Client": "web"}


def test_cold_library_identity_does_not_open_a_second_writer(settings, authenticated_client):
    with authenticated_client(settings) as client:
        service = client.app.state.agent_platform
        service.repository._library_id = None
        draft = client.post(
            "/api/v1/agent/drafts",
            headers=HEADERS,
            json={
                "kind": "playlist",
                "title": "空歌单草案",
                "payload": {"name": "空歌单", "track_ids": []},
            },
        )
        assert draft.status_code == 200
        identity = draft.json()["id"]
        version = draft.json()["version"]
        service.repository._library_id = None
        assert (
            client.post(
                f"/api/v1/agent/drafts/{identity}/approve",
                headers=HEADERS,
                json={"version": version},
            ).status_code
            == 200
        )

        service.repository._library_id = None
        assert (
            client.post(
                f"/api/v1/agent/drafts/{identity}/apply",
                headers=HEADERS,
                json={"version": version, "idempotency_key": "cold-fixture-key"},
            ).status_code
            == 200
        )


def test_admin_shared_endpoint_is_available_without_per_user_host_policy(
    settings, authenticated_client
):
    from test_users import new_user

    from wildstring.agent_models import Connection

    with authenticated_client(settings) as client:
        service = client.app.state.agent_platform
        actor = service.current_actor("admin")
        connection = service.save_connection(
            actor,
            Connection(
                name="共享局域网模型",
                scope="instance",
                shared=True,
                base_url="http://127.0.0.1:19999/v1",
                model="synthetic",
            ),
        )
        account = new_user(client)
        ordinary = service.current_actor(account["id"])
        result = service.connection_for(ordinary, connection["id"])
        assert result["id"] == connection["id"]
        with pytest.raises(HTTPException) as denied:
            service.save_connection(
                ordinary,
                Connection(
                    name="个人内网", base_url="http://127.0.0.1:19999/v1", model="synthetic"
                ),
            )
        assert denied.value.detail == "ai_endpoint_not_allowed"


def test_conversation_pages_reach_real_database_history_beyond_100(settings, authenticated_client):
    with authenticated_client(settings) as client:
        service = client.app.state.agent_platform
        actor = service.current_actor("admin")
        with service.database.connect(write=True) as database:
            database.executemany(
                "INSERT INTO agent_conversations VALUES (?,?,?,?,?,?)",
                [
                    (
                        f"history-{i:03}",
                        actor.user_id,
                        f"会话 {i}",
                        None,
                        "2026-01-01",
                        "2026-01-01",
                    )
                    for i in range(205)
                ],
            )
        collected = []
        for offset in (0, 100, 200):
            response = client.get(
                "/api/v1/agent/conversations", params={"limit": 100, "offset": offset}
            )
            assert response.status_code == 200
            result = response.json()
            assert result["total"] == 205
            collected.extend(item["id"] for item in result["items"])
        assert collected == [f"history-{i:03}" for i in range(204, -1, -1)]


@pytest.mark.parametrize(
    ("route", "method"),
    [
        ("credentials", "credentials"),
        ("telegram-targets", "targets"),
        ("schedules", "schedules"),
        ("connections", "connections"),
        ("conversations", "conversations"),
    ],
)
def test_settings_pages_honor_limits_offsets_and_reject_invalid_values(
    settings, authenticated_client, monkeypatch, route, method
):
    with authenticated_client(settings) as client:
        service = client.app.state.agent_platform
        records = [{"id": f"record-{i}"} for i in range(205)]
        monkeypatch.setattr(service, method, lambda _actor: records)
        url = "/api/v1/agent/" + route
        page = client.get(url, params={"limit": 1, "offset": 100}).json()
        assert page["limit"] == 1 and page["offset"] == 100 and page["total"] == 205
        assert page["items"] == [{"id": "record-100"}]
        collected = []
        offset = 0
        while True:
            result = client.get(url, params={"limit": 100, "offset": offset}).json()
            collected.extend(item["id"] for item in result["items"])
            if offset + len(result["items"]) >= result["total"]:
                break
            offset += len(result["items"])
        assert collected == [item["id"] for item in records]
        assert client.get(url, params={"limit": 0}).status_code == 422
        assert client.get(url, params={"offset": -1}).status_code == 422
