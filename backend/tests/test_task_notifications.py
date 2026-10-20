"""Existing shared-library jobs use the same atomic, administrator-only inbox."""

from uuid import uuid4

import pytest
from test_personal_library import HEADERS, music

from wildstring.library.scanner import scan_library
from wildstring.task_notifications import management_result


def test_refresh_batch_notifies_once_after_all_members_and_keeps_pending(
    settings, authenticated_client, monkeypatch
):
    for name in ("一.flac", "二.flac"):
        music(settings, name, ["合成"], [], album="合成专辑")
    scan_library(settings)
    with authenticated_client(settings) as client:
        providers = client.app.state.providers
        providers.stop()
        providers.exit.clear()
        with providers.database.connect(write=True) as connection:
            connection.execute("UPDATE provider_settings SET enabled=1 WHERE id=1")
        queued = providers.enqueue(scope="library", track_batch=True)
        monkeypatch.setattr(
            providers,
            "suggestions",
            lambda *_args, **_kwargs: (
                [
                    (
                        "musicbrainz",
                        "https://musicbrainz.org/recording/fixture",
                        {"album": "来源候选专辑"},
                        None,
                        {},
                    )
                ],
                [],
            ),
        )
        with providers.database.connect() as connection:
            jobs = connection.execute("SELECT * FROM provider_jobs ORDER BY id").fetchall()
        providers.process_job(jobs[0])
        assert client.get("/api/v1/agent/notifications").json()["total"] == 0
        providers.process_job(jobs[1])
        providers.process_job(jobs[1])
        result = client.get("/api/v1/agent/notifications").json()
        assert result["total"] == 1 and result["unread_count"] == 1
        assert result["items"][0]["trace_id"] == queued["batch_id"]
        assert "确认后应用" in result["items"][0]["summary"]
        assert result["items"][0]["actions"][0]["target"] == "metadata-center"
        assert result["items"][0]["actions"][0]["params"]["batch_id"] == queued["batch_id"]
        assert all(
            track["album"] == "合成专辑" for track in client.get("/api/v1/tracks").json()["items"]
        )


def test_legacy_result_and_event_rollback_together(settings, authenticated_client):
    with authenticated_client(settings) as client:
        platform = client.app.state.agent_platform

        class Service:
            pass

        service = Service()
        service.platform = platform
        job = {"id": uuid4().hex, "kind": "scan"}

        def rollback():
            with platform.database.connect(write=True) as connection:
                connection.execute("BEGIN IMMEDIATE")
                management_result(service, connection, job, "completed")
                raise RuntimeError("rollback fixture")

        pytest.raises(RuntimeError, rollback).match("rollback fixture")
        assert client.get("/api/v1/agent/notifications").json()["total"] == 0


def test_group_telegram_is_cancelled_after_administrator_demotion(settings, authenticated_client):
    with authenticated_client(settings) as client:
        platform = client.app.state.agent_platform
        platform.stop()
        target = client.post(
            "/api/v1/agent/telegram-targets",
            headers=HEADERS,
            json={
                "name": "group",
                "chat_id": "-123",
                "bot_token": "123456789:synthetic-token-only",
            },
        ).json()
        client.put(
            "/api/v1/agent/notification-preferences",
            headers=HEADERS,
            json={"telegram_enabled": True},
        )
        with platform.database.connect(write=True) as connection:
            connection.execute(
                "UPDATE agent_telegram_targets SET verified=1,enabled=1 WHERE id=?", (target["id"],)
            )
            platform.emit(connection, "admin", "task.completed", uuid4().hex, "完成", "合成结果")
            connection.execute("UPDATE users SET role='user',version=version+1 WHERE id='admin'")
        sent = []
        platform.transport = lambda *_args, **_kwargs: sent.append(True)
        assert platform.deliver_one()
        with platform.database.connect() as connection:
            assert (
                connection.execute("SELECT status FROM agent_deliveries").fetchone()[0]
                == "cancelled"
            )
        assert sent == []
