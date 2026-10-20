"""An empty running queue must not hide suggestions or destroy batch outcomes."""

import time

from fastapi.testclient import TestClient
from test_personal_library import music
from test_providers import HEADERS, RECORDING, enable
from test_users import login, new_user

from wildstring.database import SCHEMA_VERSION, Database
from wildstring.library.repository import LibraryRepository
from wildstring.library.scanner import scan_library
from wildstring.main import create_app
from wildstring.provider_tasks import clear_history, task_page

BASE = "/api/v1/manage/providers"


def seed(settings):
    music(settings, "歌曲.flac", ["艺人"], ["艺人"])
    scan_library(settings)


def setup_service(client):
    service = client.app.state.providers
    service.stop()
    assert enable(client).status_code == 200
    track = client.get("/api/v1/tracks").json()["items"][0]
    return service, track


def page(client, view):
    response = client.get(BASE + "/tasks", params={"view": view})
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "private, no-store"
    return response.json()


def candidate(*_, **__):
    return [
        (
            "musicbrainz",
            "https://musicbrainz.org/recording/" + RECORDING,
            {"composers": ["作曲者"]},
            None,
            {},
        )
    ], []


def refresh(client):
    response = client.post(BASE + "/refresh", headers=HEADERS, json={"scope": "library"})
    assert response.status_code == 200
    return response.json()["batch_id"]


def test_query_completion_preserves_pending_then_apply_archives_without_changing_batch(
    settings, authenticated_client
):
    seed(settings)
    with authenticated_client(settings) as client:
        service, track = setup_service(client)
        service.suggestions = candidate
        batch = refresh(client)
        assert page(client, "active")["total"] == 1
        service.step()
        assert page(client, "active")["total"] == 0
        assert page(client, "history")["total"] == 0
        pending = page(client, "pending")
        assert pending["total"] == 1 and pending["items"][0]["suggestion_count"] == 1
        assert client.post(
            BASE + "/tasks/history/clear", headers=HEADERS, json={"through": time.time()}
        ).json() == {"cleared": 0}
        suggestion = client.get(BASE + f"/tracks/{track['id']}").json()["suggestions"][0]
        assert (
            client.post(
                BASE + f"/suggestions/{suggestion['id']}/apply",
                headers=HEADERS,
                json={"version": suggestion["metadata_version"], "fields": ["composers"]},
            ).status_code
            == 200
        )
        assert page(client, "pending")["total"] == 0
        assert page(client, "history")["total"] == 1
        before = client.get(BASE + f"/refresh/{batch}").json()
        assert client.post(
            BASE + "/tasks/history/clear", headers=HEADERS, json={"through": time.time()}
        ).json() == {"cleared": 1}
        assert page(client, "history")["total"] == 0
        assert client.get(BASE + f"/refresh/{batch}").json() == before
        result = client.get(BASE + f"/tracks/{track['id']}").json()
        assert result["suggestions"][0]["status"] == "applied"
        assert client.get(f"/api/v1/tracks/{track['id']}").json()["composers"] == ["作曲者"]
        assert client.get(BASE + "/jobs").json()["items"][0]["status"] == "completed"


def test_grouped_review_is_durable_and_does_not_ignore_later_results(
    settings, authenticated_client
):
    seed(settings)
    with authenticated_client(settings) as client:
        service, track = setup_service(client)
        service.suggestions = candidate
        for _ in range(2):
            refresh(client)
            service.step()
        pending = page(client, "pending")
        assert pending["total"] == 1
        assert pending["items"][0]["job_count"] == 2
        assert pending["items"][0]["suggestion_count"] == 2
        refresh(client)
        assert page(client, "active")["total"] == 1
        # Complete a new query after the page's snapshot: an old click must not consume it.
        service.step()
        response = client.post(
            BASE + f"/tasks/tracks/{track['id']}/review",
            headers=HEADERS,
            json={"view": "pending", "through": pending["snapshot_at"]},
        )
        assert response.json() == {"reviewed": 2}
        assert page(client, "pending")["items"][0]["suggestion_count"] == 1
        assert page(client, "history")["items"][0]["job_count"] == 2
        suggestions = client.get(BASE + f"/tracks/{track['id']}").json()["suggestions"]
        ignored = next(s for s in suggestions if s["status"] == "ignored")
        assert (
            client.post(
                BASE + f"/suggestions/{ignored['id']}/apply",
                headers=HEADERS,
                json={"version": ignored["metadata_version"], "fields": ["composers"]},
            ).status_code
            == 404
        )
    with authenticated_client(settings) as client:
        client.app.state.providers.stop()
        assert page(client, "pending")["total"] == 1
        assert page(client, "history")["total"] == 1


def test_partial_failure_retry_preserves_suggestions_and_failed_enqueue_keeps_problem(
    settings, authenticated_client
):
    seed(settings)
    with authenticated_client(settings) as client:
        service, track = setup_service(client)
        service.suggestions = lambda *a, **kw: (candidate()[0], ["provider_http_error"])
        refresh(client)
        service.step()
        original = page(client, "pending")["items"][0]
        assert original["status"] == "completed" and original["has_issue"]
        assert (
            client.post(BASE + f"/tasks/{original['id']}/retry", headers=HEADERS).json()["queued"]
            == 1
        )
        assert page(client, "pending")["total"] == 1
        assert page(client, "active")["total"] == 1
        service.suggestions = lambda *_, **__: ([], ["dns_error"])
        service.step()
        failed = page(client, "attention")["items"][0]
        assert failed["status"] == "failed"
        with service.database.connect(write=True) as connection:
            connection.execute("UPDATE provider_settings SET enabled=0")
        assert (
            client.post(BASE + f"/tasks/{failed['id']}/retry", headers=HEADERS).status_code == 409
        )
        assert page(client, "attention")["total"] == 1
        snapshot = page(client, "pending")["snapshot_at"]
        assert (
            client.post(
                BASE + f"/tasks/tracks/{track['id']}/review",
                headers=HEADERS,
                json={"view": "pending", "through": snapshot},
            ).json()["reviewed"]
            == 1
        )
        assert page(client, "pending")["total"] == 0
        # The separate failed query still needs acknowledgement.
        assert page(client, "attention")["total"] == 1
        snapshot = page(client, "attention")["snapshot_at"]
        assert (
            client.post(
                BASE + f"/tasks/tracks/{track['id']}/review",
                headers=HEADERS,
                json={"view": "attention", "through": snapshot},
            ).json()["reviewed"]
            == 1
        )
        assert page(client, "attention")["total"] == 0
        assert page(client, "history")["total"] == 1


def test_retention_skips_pending_and_errors_even_with_providers_disabled(
    settings, authenticated_client
):
    seed(settings)
    with authenticated_client(settings) as client:
        service, _ = setup_service(client)
        for result in (candidate(), ([], ["dns_error"]), ([], [])):
            service.suggestions = lambda *_, result=result, **__: result
            refresh(client)
            service.step()
        with service.database.connect(write=True) as connection:
            connection.execute(
                "UPDATE provider_jobs SET updated_at=?,created_at=?",
                (time.time() - 31 * 86400,) * 2,
            )
            connection.execute("UPDATE provider_settings SET enabled=0")
        service.history_cleaned_at = 0
        service.step()
        assert page(client, "history")["total"] == 0
        assert page(client, "pending")["total"] == 1
        assert page(client, "attention")["total"] == 1
        with service.database.connect() as connection:
            assert connection.execute("SELECT count(*) FROM provider_jobs").fetchone()[0] == 3


def test_grouped_pending_keeps_older_warnings_and_retries_from_latest_representative(
    settings, authenticated_client
):
    seed(settings)
    with authenticated_client(settings) as client:
        service, _ = setup_service(client)
        service.suggestions = lambda *_, **__: (candidate()[0], ["provider_http_error"])
        refresh(client)
        service.step()
        first = page(client, "pending")["items"][0]
        service.suggestions = candidate
        refresh(client)
        service.step()
        grouped = page(client, "pending")["items"][0]
        assert grouped["id"] != first["id"]
        assert grouped["job_count"] == 2
        assert grouped["has_issue"] and grouped["requires_attention"]
        assert "provider_http_error" in grouped["warnings"]
        assert (
            client.post(BASE + f"/tasks/{grouped['id']}/retry", headers=HEADERS).json()["queued"]
            == 1
        )
        assert not page(client, "pending")["items"][0]["requires_attention"]
        assert page(client, "pending")["items"][0]["suggestion_count"] == 2


def test_permissions_pagination_library_scope_and_schema15_upgrade(settings, authenticated_client):
    seed(settings)
    with authenticated_client(settings) as client:
        service, _ = setup_service(client)
        refresh(client)
        assert client.get(BASE + "/tasks?view=invalid").status_code == 422
        assert client.get(BASE + "/tasks?limit=0").status_code == 422
        assert (
            client.post(BASE + "/tasks/history/clear", json={"through": time.time()}).status_code
            == 403
        )
        new_user(client)
        with TestClient(create_app(settings)) as ordinary:
            assert ordinary.get(BASE + "/tasks").status_code == 401
            assert login(ordinary).status_code == 200
            assert ordinary.get(BASE + "/tasks").status_code == 403
            assert (
                ordinary.post(
                    BASE + "/tasks/history/clear", headers=HEADERS, json={"through": time.time()}
                ).status_code
                == 403
            )
        other = settings.library_dir.parent / "other-library"
        other.mkdir()
        repository = LibraryRepository(service.database, other)
        assert task_page(repository, "active")["total"] == 0
        assert clear_history(repository, time.time())["cleared"] == 0
    database = Database(settings.data_dir)
    with database.connect(write=True) as connection:
        from test_agent_platform import drop_agent_tables

        drop_agent_tables(connection)
        connection.execute("DROP TABLE provider_task_reviews")
        from migration_support import pre18

        pre18(connection)
        connection.execute("PRAGMA user_version=15")
    database.initialize()
    database.initialize()
    with database.connect() as connection:
        assert connection.execute("PRAGMA user_version").fetchone()[0] == SCHEMA_VERSION == 23
        assert connection.execute("SELECT count(*) FROM provider_jobs").fetchone()[0] == 1
