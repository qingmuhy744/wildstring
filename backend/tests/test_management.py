"""Management edits, real jobs, recovery and authorization on an isolated library."""

import hashlib
import shutil
import time
from concurrent.futures import ThreadPoolExecutor

import pytest
from conftest import restore_v7_account_layout
from fastapi import HTTPException
from fastapi.testclient import TestClient
from filelock import FileLock
from mutagen.flac import FLAC
from test_personal_library import FIXTURE, HEADERS, create_playlist, music

from wildstring.database import Database
from wildstring.library.repository import LibraryRepository
from wildstring.library.scanner import scan_library
from wildstring.main import create_app
from wildstring.management import JobRequest, Management


def wait_for(callback, predicate, timeout=5):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = callback()
        if predicate(result):
            return result
        time.sleep(0.02)
    pytest.fail(f"Condition did not become true: {result}")


def metadata_url(track):
    return f"/api/v1/manage/tracks/{track['id']}/metadata"


def test_edit_rescan_restore_and_all_views(settings, authenticated_client):
    path = music(settings, "旧歌.flac", ["旧艺人"], ["旧艺人"])
    scan_library(settings)
    before = hashlib.sha256(path.read_bytes()).hexdigest()
    with authenticated_client(settings) as client:
        track = client.get("/api/v1/tracks").json()["items"][0]
        endpoint = metadata_url(track)
        observed = client.get(endpoint).json()
        loved = client.put(
            f"/api/v1/tracks/{track['id']}/favorite", headers=HEADERS, json={"loved": True}
        )
        assert loved.status_code == 200
        playlist = create_playlist(client, definition={"all": [{"is": {"artist": "新艺人"}}]})
        body = {
            "version": observed["version"],
            "overrides": {
                "title": "新歌",
                "artists": ["新艺人", "AC/DC"],
                "album": "新专辑",
                "album_artists": ["新艺人"],
                "track_number": 8,
                "disc_number": 2,
            },
        }
        saved = client.put(endpoint, headers=HEADERS, json=body)
        assert saved.status_code == 200, saved.text
        assert saved.json()["observed"] == observed["observed"]
        updated = client.get(f"/api/v1/tracks/{track['id']}").json()
        assert updated["title"] == "新歌" and updated["title_source"] == "user"
        assert updated["id"] == track["id"] and updated["loved"]
        assert client.get("/api/v1/tracks?q=新艺人").json()["total"] == 1
        assert client.get("/api/v1/tracks?q=旧艺人").json()["total"] == 0
        assert client.get("/api/v1/albums").json()["items"][0]["title"] == "新专辑"
        assert client.get("/api/v1/artists?q=新艺人").json()["total"] == 1
        assert client.get(f"/api/v1/playlists/{playlist['id']}/tracks").json()["total"] == 1
        assert client.put(endpoint, headers=HEADERS, json=body).status_code == 409
        scan_library(settings, full=True)
        same = client.get(endpoint).json()
        assert same == saved.json()
        assert hashlib.sha256(path.read_bytes()).hexdigest() == before
        # An external file change updates observations, but keeps independent overrides.
        tags = FLAC(path)
        tags["title"], tags["artist"] = "文件更新", ["文件艺人"]
        tags.save()
        new_hash = hashlib.sha256(path.read_bytes()).hexdigest()
        scan_library(settings, full=True)
        latest = client.get(endpoint).json()
        assert latest["observed"]["title"] == "文件更新"
        assert latest["effective"]["title"] == "新歌"
        assert latest["version"] == same["version"] + 1
        assert (
            client.put(
                endpoint, headers=HEADERS, json={"version": same["version"], "overrides": {}}
            ).status_code
            == 409
        )
        restored = client.put(
            endpoint, headers=HEADERS, json={"version": latest["version"], "overrides": {}}
        )
        assert restored.status_code == 200
        final = client.get(f"/api/v1/tracks/{track['id']}").json()
        assert final["title"] == "文件更新" and final["artists"] == ["文件艺人"]
        assert final["title_source"] == "tag" and final["loved"]
        assert hashlib.sha256(path.read_bytes()).hexdigest() == new_hash


def test_metadata_validation_permissions_and_library_isolation(settings, authenticated_client):
    music(settings, "歌.flac", ["甲"], ["甲"])
    scan_library(settings)
    with TestClient(create_app(settings)) as anonymous:
        assert anonymous.get("/api/v1/manage/overview").status_code == 401
        assert (
            anonymous.post(
                "/api/v1/manage/jobs", headers=HEADERS, json={"kind": "scan"}
            ).status_code
            == 401
        )
    with authenticated_client(settings) as client:
        track = client.get("/api/v1/tracks").json()["items"][0]
        endpoint = metadata_url(track)
        assert client.put(endpoint, json={"version": 1, "overrides": {}}).status_code == 403
        for overrides in [
            {"path": "../x"},
            {"title": None},
            {"title": "  "},
            {"artists": None},
            {"artists": [""]},
            {"artists": [123]},
            {"track_number": True},
            {"track_number": "1"},
            {"disc_number": 0},
            {"title": "a" * 1001},
            {"album": "\x00"},
        ]:
            assert (
                client.put(
                    endpoint, headers=HEADERS, json={"version": 1, "overrides": overrides}
                ).status_code
                == 422
            )
        assert client.get("/api/v1/manage/tracks/unknown/metadata").status_code == 404
        assert (
            client.put(
                endpoint,
                headers=HEADERS,
                json={
                    "version": 1,
                    "overrides": {"artists": [], "album": None, "disc_number": None},
                },
            ).status_code
            == 200
        )
    other = settings.model_copy(update={"library_dir": settings.data_dir / "another-library"})
    with authenticated_client(other) as client:
        assert client.get(endpoint).status_code == 404
        assert (
            client.put(endpoint, headers=HEADERS, json={"version": 2, "overrides": {}}).status_code
            == 404
        )
        assert client.get("/api/v1/manage/overview").json()["counts"]["tracks"] == 0


def test_v5_migration_preserves_identity_and_personal_data(settings, authenticated_client):
    music(settings, "旧版本.flac", ["甲"], ["甲"])
    scan_library(settings)
    db = Database(settings.data_dir)
    with db.connect(write=True) as connection:
        track = dict(connection.execute("SELECT * FROM tracks").fetchone())
        restore_v7_account_layout(connection)
        connection.execute("UPDATE tracks SET loved=1, play_count=7, listened_ms=1234")
        connection.execute("DROP TABLE track_metadata")
        connection.execute("DROP TABLE admin_jobs")
        connection.execute("DROP TABLE library_preferences")
        connection.execute("DROP TABLE intake_settings")
        connection.execute("DROP TABLE intake_items")
        connection.execute("PRAGMA user_version=5")
    db.initialize()
    with authenticated_client(settings) as client:
        detail = client.get(f"/api/v1/tracks/{track['id']}").json()
        assert detail["loved"] and detail["play_count"] == 7 and detail["listened_ms"] == 1234
        record = client.get(metadata_url(track)).json()
        assert record["effective"]["title"] == track["title"] and record["overrides"] == {}
        assert record["version"] == 1
        scan_library(settings, full=True)
        # The first full scan observes the newly supported tag fields.
        assert client.get(metadata_url(track)).json()["version"] == 2
        assert client.get("/api/v1/manage/overview").json()["schema_version"] == 13


def test_real_import_scan_progress_and_bytes_unchanged(settings, authenticated_client):
    settings.music_dir.mkdir()
    source = settings.music_dir / "source.flac"
    shutil.copyfile(FIXTURE, source)
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    (settings.music_dir / "broken.flac").write_bytes(b"bad audio")
    with authenticated_client(settings) as client:
        response = client.post("/api/v1/manage/jobs", headers=HEADERS, json={"kind": "import"})
        assert response.status_code == 202
        endpoint = "/api/v1/manage/jobs/" + response.json()["id"]
        result = wait_for(lambda: client.get(endpoint).json(), lambda job: job["finished_at"])
        assert result["status"] == "completed_with_errors"
        assert result["import"]["counts"]["copied"] == 1
        assert result["import"]["counts"]["errors"] == 1
        assert result["import"]["errors"][0]["path"] == "broken.flac"
        assert result["scan"]["counts"]["added"] == 1
        assert hashlib.sha256(source.read_bytes()).hexdigest() == digest
        managed = next(settings.library_dir.rglob("*.flac"))
        assert hashlib.sha256(managed.read_bytes()).hexdigest() == digest
        scan = client.post(
            "/api/v1/manage/jobs", headers=HEADERS, json={"kind": "scan", "full": True}
        ).json()
        final = wait_for(
            lambda: client.get("/api/v1/manage/jobs/" + scan["id"]).json(),
            lambda job: job["finished_at"],
        )
        assert final["status"] == "completed" and final["scan"]["counts"]["updated"] == 1
        assert client.get("/api/v1/manage/jobs?limit=1").json()["total"] == 2
        assert len(client.get("/api/v1/manage/jobs?limit=1&offset=1").json()["items"]) == 1
        overview = client.get("/api/v1/manage/overview").json()
        assert overview["counts"]["tracks"] == 1 and overview["source"]["available"]
        assert overview["active_job"] is None
        assert "admin_password" not in str(overview)
        assert overview["deployment"]["metadata_writeback"] is False


def test_queue_deduplicates_waits_for_cli_and_survives_restart(settings, authenticated_client):
    scan_library(settings)
    with FileLock(settings.data_dir / "admin-worker.lock", timeout=0):
        with authenticated_client(settings) as client:
            endpoint = "/api/v1/manage/jobs"
            first = client.post(endpoint, headers=HEADERS, json={"kind": "scan"}).json()
            assert (
                client.post(endpoint, headers=HEADERS, json={"kind": "scan"}).json()["id"]
                == first["id"]
            )
            assert (
                client.post(endpoint, headers=HEADERS, json={"kind": "import"}).status_code == 409
            )
            assert client.get("/api/v1/manage/overview").json()["active_job"] == first["id"]
    with FileLock(settings.data_dir / "library-scan.lock", timeout=0):
        with authenticated_client(settings) as client:
            wait_for(
                lambda: client.get(endpoint + "/" + first["id"]).json(),
                lambda job: job["error"] == "waiting_for_library",
            )
            assert client.get(endpoint).json()["total"] == 1
    with authenticated_client(settings) as client:
        done = wait_for(
            lambda: client.get(endpoint + "/" + first["id"]).json(), lambda job: job["finished_at"]
        )
        assert done["status"] == "completed"
        assert done["scan"]["counts"]["visited"] == 0


def test_recover_running_jobs_and_keep_history(settings, authenticated_client):
    scan_library(settings)
    db = Database(settings.data_dir)
    repo = LibraryRepository(db, settings.library_dir)
    manager = Management(settings, repo)
    queued = manager.submit(JobRequest(kind="scan"))
    job = manager.claim()
    run_id = repo.begin_scan()
    manager.link(job["id"], scan_id=run_id)
    with authenticated_client(settings) as client:
        recovered = wait_for(
            lambda: client.get("/api/v1/manage/jobs/" + queued["id"]).json(),
            lambda job: job["status"] == "interrupted",
        )
        assert recovered["error"] == "worker_interrupted"
        assert recovered["scan"]["status"] == "interrupted"
        submitted = client.post(
            "/api/v1/manage/jobs", headers=HEADERS, json={"kind": "scan"}
        ).json()
        assert submitted["id"] != queued["id"]
        done = wait_for(
            lambda: client.get("/api/v1/manage/jobs/" + submitted["id"]).json(),
            lambda job: job["finished_at"],
        )
        assert done["status"] == "completed"


def test_concurrent_submit_and_job_isolation(settings, authenticated_client):
    scan_library(settings)
    manager = Management(
        settings, LibraryRepository(Database(settings.data_dir), settings.library_dir)
    )
    with ThreadPoolExecutor(max_workers=4) as executor:
        ids = list(executor.map(lambda _: manager.submit(JobRequest(kind="scan"))["id"], range(4)))
    assert len(set(ids)) == 1
    with pytest.raises(HTTPException) as conflict:
        manager.submit(JobRequest(kind="import"))
    assert conflict.value.status_code == 409
    other = settings.model_copy(update={"library_dir": settings.data_dir / "different"})
    with authenticated_client(other) as client:
        assert client.get("/api/v1/manage/jobs/" + ids[0]).status_code == 404
        assert client.get("/api/v1/manage/jobs").json()["total"] == 0
        assert client.post("/api/v1/manage/jobs", json={"kind": "scan"}).status_code == 403
        assert (
            client.post(
                "/api/v1/manage/jobs", headers=HEADERS, json={"kind": "unknown"}
            ).status_code
            == 422
        )
        assert (
            client.post(
                "/api/v1/manage/jobs", headers=HEADERS, json={"kind": "scan", "full": "yes"}
            ).status_code
            == 422
        )
        assert client.get("/api/v1/manage/jobs?limit=101").status_code == 422


def test_preferences_versioning_and_failed_import(settings, authenticated_client):
    with authenticated_client(settings) as client:
        body = {"name": "我的摇滚收藏", "version": 1}
        assert client.put("/api/v1/manage/preferences", json=body).status_code == 403
        response = client.put("/api/v1/manage/preferences", headers=HEADERS, json=body)
        assert response.status_code == 200 and response.json()["version"] == 2
        assert (
            client.put("/api/v1/manage/preferences", headers=HEADERS, json=body).status_code == 409
        )
        assert (
            client.put(
                "/api/v1/manage/preferences", headers=HEADERS, json={"name": " ", "version": 2}
            ).status_code
            == 422
        )
        job = client.post("/api/v1/manage/jobs", headers=HEADERS, json={"kind": "import"}).json()
        failed = wait_for(
            lambda: client.get("/api/v1/manage/jobs/" + job["id"]).json(),
            lambda job: job["finished_at"],
        )
        assert (
            failed["status"] == "failed"
            and failed["import"]["errors"][0]["code"] == "source_unavailable"
        )
    with authenticated_client(settings) as client:
        assert client.get("/api/v1/manage/overview").json()["preferences"]["name"] == "我的摇滚收藏"
