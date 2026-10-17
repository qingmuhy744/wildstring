"""Persistent refresh progress is scoped to immutable batch membership, not recent jobs."""

import json

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from test_personal_library import music
from test_providers import HEADERS, RECORDING, enable
from test_users import login, new_user

from wildstring.database import SCHEMA_VERSION, Database
from wildstring.library.repository import LibraryRepository
from wildstring.library.scanner import scan_library
from wildstring.main import create_app
from wildstring.provider_batches import STATUSES, batch_progress
from wildstring.providers import Providers

BASE = "/api/v1/manage/providers"


def seed(settings, count=3):
    for index in range(count):
        music(
            settings,
            f"batch-{index:02}.flac",
            ["艺人"],
            [],
            album="第一批" if index < 30 else "其他批",
            number=index + 1,
        )
    scan_library(settings)


def stopped(client):
    service = client.app.state.providers
    service.stop()
    service.exit.clear()
    assert enable(client, auto_new=False).status_code == 200
    return service


def refresh(client, **body):
    response = client.post(BASE + "/refresh", headers=HEADERS, json={"scope": "library"} | body)
    assert response.status_code == 200, response.text
    return response.json()


def progress(client, batch):
    response = client.get(BASE + "/refresh/" + batch["batch_id"])
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "private, no-store"
    assert response.headers["vary"] == "Cookie"
    return response.json()


def test_batches_are_isolated_track_all_thirty_members_and_reuse_active_jobs(
    settings, authenticated_client
):
    seed(settings, 36)
    with authenticated_client(settings) as client:
        service = stopped(client)
        tracks = client.get("/api/v1/tracks?limit=100").json()["items"]
        target = tracks[0]
        legacy = client.post(
            BASE + "/query", headers=HEADERS, json={"track_ids": [target["id"]]}
        ).json()
        assert legacy == {"queued": 1, "already_active": 0, "total": 1}
        first = refresh(client, scope="album", id=target["album_id"])
        assert (first["queued"], first["already_active"], first["total"]) == (29, 1, 30)
        other = next(track for track in tracks if track["album_id"] != target["album_id"])
        second = refresh(client, scope="album", id=other["album_id"])
        assert (second["queued"], second["already_active"], second["total"]) == (6, 0, 6)
        shared = refresh(client, scope="track", id=target["id"], force=True)
        assert (shared["queued"], shared["already_active"], shared["total"]) == (0, 1, 1)
        initial = progress(client, first)
        assert initial["total"] == initial["queued"] == 30 and len(initial["items"]) == 30
        assert initial["truncated"] is False
        member = next(item for item in initial["items"] if item["track_id"] == target["id"])
        assert progress(client, shared)["items"][0]["id"] == member["id"]
        with Database(settings.data_dir).connect(write=True) as connection:
            for index, item in enumerate(initial["items"]):
                status = STATUSES[index % len(STATUSES)]
                connection.execute(
                    "UPDATE provider_jobs SET status=?,error=?,warnings=? WHERE id=?",
                    (
                        status,
                        "provider_timeout" if status == "failed" else None,
                        json.dumps(["lastfm_partial"]) if status == "completed" else "[]",
                        item["id"],
                    ),
                )
        first_state = progress(client, first)
        assert first_state["total"] == sum(first_state[status] for status in STATUSES) == 30
        assert all(first_state[status] == 5 for status in STATUSES)
        assert len(first_state["items"]) == 30
        assert {item["track_id"] for item in first_state["items"]} == {
            track["id"] for track in tracks if track["album_id"] == target["album_id"]
        }
        completed = [item for item in first_state["items"] if item["status"] == "completed"]
        assert all(json.loads(item["warnings"]) == ["lastfm_partial"] for item in completed)
        assert all(
            item["error"] == "provider_timeout"
            for item in first_state["items"]
            if item["status"] == "failed"
        )
        assert progress(client, second)["queued"] == 6
        shared_state = progress(client, shared)
        assert shared_state["items"][0] == next(
            item for item in first_state["items"] if item["id"] == member["id"]
        )
        old_jobs = client.get(BASE + "/jobs").json()
        assert len(old_jobs["items"]) == 20
        assert old_jobs["queued"] == 11 and old_jobs["running"] == 5
        # This API must not silently change legacy enqueue return fields.
        assert service.enqueue([]) == {"queued": 0, "already_active": 0, "total": 0}
    with authenticated_client(settings) as client:
        client.app.state.providers.stop()
        assert len(progress(client, first)["items"]) == 30
        assert progress(client, second)["total"] == 6


def test_batch_observes_real_worker_no_match_failure_and_completed_warnings(
    settings, authenticated_client
):
    seed(settings)
    with authenticated_client(settings) as client:
        service = stopped(client)
        batch = refresh(client)

        def suggestions(track, **_kwargs):
            if "00" in track["title"]:
                return [], []
            if "01" in track["title"]:
                return [], ["musicbrainz_http_error"]
            return [
                (
                    "musicbrainz",
                    "https://musicbrainz.org/recording/" + RECORDING,
                    {"lyricists": ["候选"]},
                    None,
                    {},
                )
            ], ["lastfm_partial"]

        service.suggestions = suggestions
        for _ in range(3):
            service.step()
        state = progress(client, batch)
        assert state["total"] == 3 and state["queued"] == state["running"] == 0
        assert state["no_match"] == state["failed"] == state["completed"] == 1
        assert state["stale"] == 0
        assert any(
            item["status"] == "completed" and json.loads(item["warnings"]) == ["lastfm_partial"]
            for item in state["items"]
        )
        assert any(
            item["status"] == "failed"
            and json.loads(item["warnings"]) == ["musicbrainz_http_error"]
            for item in state["items"]
        )


def test_unknown_batch_and_ordinary_accounts_and_other_libraries_are_rejected(
    settings, authenticated_client, tmp_path
):
    seed(settings)
    with authenticated_client(settings) as admin:
        stopped(admin)
        batch = refresh(admin)
        new_user(admin)
        assert admin.get(BASE + "/refresh/unknown").status_code == 404
        with TestClient(create_app(settings)) as user:
            user.app.state.providers.stop()
            assert user.get(BASE + "/refresh/" + batch["batch_id"]).status_code == 401
            assert login(user).status_code == 200
            assert user.get(BASE + "/refresh/" + batch["batch_id"]).status_code == 403
            assert (
                user.post(BASE + "/refresh", headers=HEADERS, json={"scope": "library"}).status_code
                == 403
            )
        other = tmp_path / "other-library"
        other.mkdir()
        repository = LibraryRepository(Database(settings.data_dir), other)
        repository.library_id(create=True)
        with pytest.raises(HTTPException) as error:
            batch_progress(repository, batch["batch_id"])
        assert error.value.status_code == 404


def test_empty_batches_and_bounded_items_keep_full_aggregate(
    settings, authenticated_client, monkeypatch
):
    with authenticated_client(settings) as client:
        stopped(client)
        batch = refresh(client)
        state = progress(client, batch)
        assert state["total"] == 0 and state["items"] == [] and state["truncated"] is False
        assert sum(state[status] for status in STATUSES) == 0
        seed(settings, 25)
        batch = refresh(client)
        monkeypatch.setattr("wildstring.provider_batches.ITEM_LIMIT", 20)
        limited = progress(client, batch)
        assert limited["total"] == limited["queued"] == 25
        assert len(limited["items"]) == 20 and limited["truncated"] is True


def test_removing_job_or_song_keeps_membership_and_becomes_stale(settings, authenticated_client):
    seed(settings)
    with authenticated_client(settings) as client:
        stopped(client)
        batch = refresh(client)
        initial = progress(client, batch)
        first, second = initial["items"][:2]
        with Database(settings.data_dir).connect(write=True) as connection:
            connection.execute("DELETE FROM provider_jobs WHERE id=?", (first["id"],))
            connection.execute("DELETE FROM tracks WHERE id=?", (second["track_id"],))
        state = progress(client, batch)
        assert state["total"] == 3 and len(state["items"]) == 3
        assert state["stale"] == 2 and state["queued"] == 1
        removed = {item["id"]: item for item in state["items"]}
        for prior in (first, second):
            assert removed[prior["id"]]["title"] == prior["title"]
            assert removed[prior["id"]]["status"] == "stale"
            assert removed[prior["id"]]["error"] == "refresh_target_removed"


def test_schema14_upgrade_preserves_existing_jobs_and_repeated_start_keeps_batches(
    settings, authenticated_client
):
    seed(settings, 2)
    with authenticated_client(settings) as client:
        service = stopped(client)
        tracks = client.get("/api/v1/tracks").json()["items"]
        assert service.enqueue([track["id"] for track in tracks])["queued"] == 2
        original_jobs = client.get(BASE + "/jobs").json()["items"]
    database = Database(settings.data_dir)
    with database.connect(write=True) as connection:
        connection.execute("DROP TABLE provider_refresh_members")
        connection.execute("DROP TABLE provider_refresh_batches")
        connection.execute("PRAGMA user_version=14")
    database.initialize()
    database.initialize()
    assert database.check_ready()
    with database.connect() as connection:
        assert connection.execute("PRAGMA user_version").fetchone()[0] == SCHEMA_VERSION
        assert {row[0] for row in connection.execute("SELECT id FROM provider_jobs")} == {
            job["id"] for job in original_jobs
        }
    repository = LibraryRepository(database, settings.library_dir)
    batch = Providers(repository).enqueue(scope="library", track_batch=True)
    assert batch["already_active"] == 2 and batch["queued"] == 0
    database.initialize()
    assert batch_progress(repository, batch["batch_id"])["total"] == 2


def test_concurrent_refreshes_share_one_actual_job_set(settings, authenticated_client):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier

    seed(settings, 4)
    with authenticated_client(settings) as client:
        service = stopped(client)
        barrier = Barrier(2)

        def enqueue():
            barrier.wait(timeout=3)
            return service.enqueue(scope="library", track_batch=True)

        with ThreadPoolExecutor(max_workers=2) as executor:
            futures = [executor.submit(enqueue) for _ in range(2)]
            batches = [future.result(timeout=15) for future in futures]
        assert sorted(batch["queued"] for batch in batches) == [0, 4]
        assert sorted(batch["already_active"] for batch in batches) == [0, 4]
        first, second = [progress(client, batch) for batch in batches]
        assert {item["id"] for item in first["items"]} == {item["id"] for item in second["items"]}
        assert first["total"] == second["total"] == 4


def test_batch_record_failure_rolls_back_queue_and_membership_together(
    settings, authenticated_client, monkeypatch
):
    import wildstring.provider_batches as module

    seed(settings, 2)
    with authenticated_client(settings) as client:
        service = stopped(client)
        original = module.record_batch
        tables = (
            "provider_jobs",
            "provider_seen",
            "provider_refresh_batches",
            "provider_refresh_members",
        )
        with Database(settings.data_dir).connect() as connection:
            before = {
                table: connection.execute(f"SELECT count(*) FROM {table}").fetchone()[0]
                for table in tables
            }

        def fail_after_record(*args):
            original(*args)
            raise RuntimeError("simulated batch failure")

        monkeypatch.setattr(module, "record_batch", fail_after_record)
        with pytest.raises(RuntimeError, match="simulated batch failure"):
            service.enqueue(scope="library", track_batch=True)
        with Database(settings.data_dir).connect() as connection:
            for table in tables:
                assert (
                    connection.execute(f"SELECT count(*) FROM {table}").fetchone()[0]
                    == before[table]
                )
        monkeypatch.setattr(module, "record_batch", original)
        assert service.enqueue(scope="library", track_batch=True)["queued"] == 2
