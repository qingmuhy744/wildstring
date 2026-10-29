"""Storage migrations preserve identity and explicit saves fence shared cache collection."""

import shutil
import time
from pathlib import Path

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from test_podcast_publishers import seed

from wildstring.database import SCHEMA_VERSION, Database
from wildstring.library.catalog import LibraryInput, LibraryUpdate
from wildstring.library.repository import LibraryRepository
from wildstring.library.scanner import scan_library
from wildstring.library.storage import LibraryStorage, MigrationInput
from wildstring.podcast_resources import ProtectionUpdate, ResourceSettings

HEADERS = {"X-Wildstring-Client": "web"}
FIXTURE = Path(__file__).resolve().parents[2] / "tests/fixtures/audio/silence.mp3"


@pytest.fixture
def resources(settings, authenticated_client):
    with authenticated_client(settings) as client:
        db = Database(settings.data_dir)
        seed(db)
        manager = client.app.state.podcasts
        manager.queue_download_episode = lambda identity: True
        path = settings.podcasts_dir / "shared.mp3"
        path.write_bytes(b"shared audio")
        with db.connect(write=True) as conn:
            conn.execute(
                "UPDATE podcast_episodes SET local_path=?,download_status='downloaded' WHERE id='ep-east'",
                (str(path),),
            )
            manager.resources.downloaded(conn, "ep-east")
        created = client.post(
            "/api/v1/manage/users",
            headers=HEADERS,
            json={"username": "saver", "password": "test-saver-password", "library_ids": []},
        ).json()
        with db.connect(write=True) as conn:
            conn.execute("INSERT INTO podcast_user_catalog VALUES (?,?)", (created["id"], "east"))
        other = TestClient(client.app)
        mutation = other.post(
            "/api/v1/auth/login",
            headers=HEADERS,
            json={"username": "saver", "password": "test-saver-password"},
        )
        assert mutation.status_code == 200
        try:
            yield client, other, manager.resources, path, db, created["id"]
        finally:
            other.close()


def test_personal_saves_reuse_and_release_independently(resources):
    owner, listener, store, path, db, user_id = resources
    endpoint = "/api/v1/podcasts/episodes/ep-east/download"
    for client in [owner, listener, listener]:
        response = client.post(endpoint, headers=HEADERS)
        assert response.status_code == 200, response.text
        assert response.json()["reused"] is True
    with db.connect() as conn:
        assert conn.execute("SELECT count(*) FROM podcast_resource_refs").fetchone()[0] == 2
    assert listener.get("/api/v1/podcasts/east").json()["episodes"][0]["resource_saved"] is True
    response = listener.delete(endpoint, headers=HEADERS)
    assert response.json()["saved"] is False
    assert owner.get("/api/v1/podcasts/episodes/ep-east").json()["resource_saved"] is True
    collection = store.cleanup(dry_run=False)
    assert collection["deleted_count"] == 0
    assert path.is_file()
    response = owner.delete(endpoint, headers=HEADERS)
    assert response.status_code == 200
    preview = store.cleanup()
    assert preview["candidate_count"] == 1 and path.is_file()
    collection = store.cleanup(dry_run=False)
    assert collection["freed_bytes"] == len(b"shared audio")
    assert not path.exists()
    mutation = store.save("ep-east", user_id)
    assert mutation["status"] == "downloading"
    assert listener.get("/api/v1/podcasts/resources").status_code == 403
    mutation = listener.post(
        "/api/v1/podcasts/resources/cleanup", headers=HEADERS, json={"dry_run": False}
    )
    assert mutation.status_code == 403


def test_collector_respects_manual_pins_streams_aliases_and_grace(resources):
    owner, _, store, path, db, _ = resources
    collection = store.cleanup(automatic=True, dry_run=False)
    assert collection["deleted_count"] == 0
    current = store.settings()
    store.configure(ResourceSettings(**{**current, "enabled": True, "retention_days": 7}))
    collection = store.cleanup(automatic=True, dry_run=False)
    assert collection["deleted_count"] == 0
    with db.connect(write=True) as conn:
        conn.execute("UPDATE podcast_resource_state SET zero_since=?", (time.time() - 8 * 86400,))
        lease = store.acquire(conn, "ep-east")
    collection = store.cleanup(dry_run=False)
    assert collection["deleted_count"] == 0
    store.release_lease(lease)
    item = store.listing()["items"][0]
    protected = store.protect("ep-east", ProtectionUpdate(version=item["version"], protected=True))
    collection = store.cleanup(dry_run=False)
    assert collection["deleted_count"] == 0
    with pytest.raises(HTTPException):
        store.protect("ep-east", ProtectionUpdate(version=item["version"], protected=False))
    store.protect("ep-east", ProtectionUpdate(version=protected["version"], protected=False))
    with db.connect(write=True) as conn:
        conn.execute(
            "UPDATE podcast_episodes SET local_path=?,download_status='downloaded' WHERE id='ep-coffee'",
            (str(path),),
        )
        store.downloaded(conn, "ep-coffee")
    store.save("ep-coffee", "admin")
    collection = store.cleanup(dry_run=False)
    assert collection["deleted_count"] == 0
    store.release("ep-coffee", "admin")
    collection = store.cleanup(dry_run=False)
    assert collection["deleted_count"] == 1
    assert not path.exists()


def test_stream_acquires_and_releases_lease_and_delete_failure_keeps_registration(
    resources, monkeypatch
):
    owner, _, store, path, db, _ = resources
    response = store.local_response("ep-east")
    assert response is not None
    collection = store.cleanup(dry_run=False)
    assert collection["deleted_count"] == 0
    with db.connect(write=True) as conn:
        conn.execute("DELETE FROM podcast_resource_leases")
    original = Path.unlink

    def fail(self, *args, **kwargs):
        if self == path:
            raise PermissionError("test read only")
        return original(self, *args, **kwargs)

    monkeypatch.setattr(Path, "unlink", fail)
    collection = store.cleanup(dry_run=False)
    assert collection["failed_count"] == 1
    with db.connect() as conn:
        assert conn.execute(
            "SELECT local_path FROM podcast_episodes WHERE id='ep-east'"
        ).fetchone()[0] == str(path)
    assert owner.get("/api/v1/podcasts/episodes/ep-east/stream").content == b"shared audio"
    with db.connect() as conn:
        assert conn.execute("SELECT count(*) FROM podcast_resource_leases").fetchone()[0] == 0


def test_schema36_upgrade_registers_cached_audio_under_standard_rules(resources):
    _, _, _, path, db, _ = resources
    from migration_support import pre37

    with db.connect(write=True) as conn:
        pre37(conn)
        conn.execute("PRAGMA user_version=36")
    db.initialize()
    with db.connect() as conn:
        assert conn.execute("PRAGMA user_version").fetchone()[0] == SCHEMA_VERSION
        assert conn.execute("SELECT protected FROM podcast_resource_state").fetchone()[0] == 0
        assert conn.execute("SELECT count(*) FROM podcast_resource_refs").fetchone()[0] == 0
    assert path.read_bytes() == b"shared audio"


def test_custom_storage_watch_pause_and_verified_migration(
    settings, authenticated_client, tmp_path
):
    source = tmp_path / "watch"
    source.mkdir()
    destination = tmp_path / "managed"
    with authenticated_client(settings) as client:
        catalog = client.app.state.library_catalog
        result = catalog.save(
            LibraryInput(
                name="archive",
                source_roots=[str(source)],
                paused_source_roots=[str(source)],
                managed_root=str(destination),
            )
        )
        assert result["managed_root"] == str(destination)
        assert result["sources"][0]["watch_enabled"] == 0
        updated = catalog.save(
            LibraryUpdate(
                name="archive renamed", source_roots=[str(source)], version=result["version"]
            ),
            result["id"],
        )
        assert updated["sources"][0]["watch_enabled"] == 0
        shutil.copy2(FIXTURE, destination / "song.mp3")
        (destination / "cover.txt").write_text("keep sidecar")
        scoped = settings.model_copy(update={"library_dir": destination})
        scan_library(scoped)
        repository = LibraryRepository(catalog.database, destination)
        with catalog.database.connect() as conn:
            track = dict(
                conn.execute("SELECT * FROM tracks WHERE library_id=?", (result["id"],)).fetchone()
            )
        target = tmp_path / "new-managed"
        storage = LibraryStorage(catalog)
        job = storage.submit(
            result["id"],
            MigrationInput(version=updated["version"], managed_root=str(target)),
            {"id": "admin"},
        )
        # Execute under the real copy/scan lock, without the worker thread racing this test.
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            latest = storage.listing(result["id"])["items"][0]
            if latest["status"] not in {"queued", "running"}:
                break
            time.sleep(0.1)
        assert latest["status"] == "completed", latest
        assert (target / "song.mp3").read_bytes() == FIXTURE.read_bytes()
        assert (destination / "song.mp3").read_bytes() == FIXTURE.read_bytes()
        assert (target / "cover.txt").read_text() == "keep sidecar"
        assert repository.root == target
        assert repository.library_id() == result["id"]
        assert client.get(f"/api/v1/tracks/{track['id']}/stream").status_code == 200
        catalog.initialize()
        with catalog.database.connect() as conn:
            assert (
                conn.execute(
                    "SELECT count(*) FROM libraries WHERE id=?", (result["id"],)
                ).fetchone()[0]
                == 1
            )
            assert (
                conn.execute(
                    "SELECT id FROM tracks WHERE library_id=?", (result["id"],)
                ).fetchone()[0]
                == track["id"]
            )
        assert job["source_root"] == str(destination)


@pytest.mark.parametrize("failure", ["io", "source_changed"])
def test_failed_migration_preserves_original_and_recovery_reuses_verified_files(
    settings, authenticated_client, tmp_path, monkeypatch, failure
):
    shutil.copy2(FIXTURE, settings.library_dir / "original.mp3")
    scan_library(settings)
    with authenticated_client(settings) as client:
        client.app.state.management.stop()
        catalog = client.app.state.library_catalog
        storage = LibraryStorage(catalog)
        library = client.get("/api/v1/libraries").json()[0]
        original_id = library["id"]
        target = tmp_path / "migration-target"
        task = storage.submit(
            original_id,
            MigrationInput(version=library["version"], managed_root=str(target)),
            {"id": "admin"},
        )
        actual_copy = __import__(
            "wildstring.library.storage", fromlist=["copy_exclusive"]
        ).copy_exclusive

        def disk_full(*args, **kwargs):
            if failure == "source_changed":
                from wildstring.library.scanner import SourceChangedError

                raise SourceChangedError
            raise OSError("no space")

        monkeypatch.setattr("wildstring.library.storage.copy_exclusive", disk_full)
        assert storage.step()
        failed = storage.listing(original_id)["items"][0]
        assert failed["status"] == "failed"
        assert catalog.record(original_id)["root"] == str(settings.library_dir)
        assert (settings.library_dir / "original.mp3").read_bytes() == FIXTURE.read_bytes()
        monkeypatch.setattr("wildstring.library.storage.copy_exclusive", actual_copy)
        storage.retry(original_id, task["id"], {"id": "admin"})
        # A crash after copying and before switching resumes the same task.
        shutil.copy2(settings.library_dir / "original.mp3", target / "original.mp3")
        interrupted = target / (".wildstring-import-" + "0" * 32)
        interrupted.write_bytes(b"interrupted exclusive copy")
        with catalog.database.connect(write=True) as db:
            db.execute("UPDATE library_migrations SET status='running' WHERE id=?", (task["id"],))
        storage.recover()
        assert storage.step()
        assert storage.listing(original_id)["items"][0]["status"] == "completed"
        assert not interrupted.exists()
        assert client.get("/api/v1/tracks").json()["items"][0]["library_id"] == original_id
    # The old disk/path may become unavailable after its retained files are archived.
    settings.library_dir.rename(tmp_path / "retained-originals")
    settings.library_dir.write_text("retired storage location")
    # Startup with the old environment path resolves the stable default ID.
    with authenticated_client(settings) as restarted:
        libraries = restarted.get("/api/v1/libraries").json()
        assert len(libraries) == 1 and libraries[0]["id"] == original_id
        assert libraries[0]["managed_root"] == str(target)
        assert restarted.get("/api/v1/tracks").json()["total"] == 1
        assert restarted.get("/health/ready").status_code == 200
        assert restarted.get("/api/v1/manage/library").status_code != 500
        from wildstring.library.importer import import_music

        settings.music_dir.mkdir(parents=True, exist_ok=True)
        mutation = import_music(settings)
        assert mutation["status"] == "completed"


def test_storage_rejects_overlap_nonempty_paths_and_direct_root_changes(
    settings, authenticated_client, tmp_path
):
    source = tmp_path / "watch"
    source.mkdir()
    nonempty = tmp_path / "existing"
    nonempty.mkdir()
    (nonempty / "personal.txt").write_text("preserve")
    with authenticated_client(settings) as client:
        library = client.get("/api/v1/libraries").json()[0]
        configured = client.put(
            f"/api/v1/libraries/{library['id']}",
            headers=HEADERS,
            json={
                "version": library["version"],
                "name": library["name"],
                "source_roots": [str(source)],
            },
        )
        assert configured.status_code == 200
        library = configured.json()
        for target in [
            str(source),
            str(source / "child"),
            str(settings.data_dir),
            str(settings.library_dir),
            "relative/path",
        ]:
            response = client.post(
                f"/api/v1/libraries/{library['id']}/migrations",
                headers=HEADERS,
                json={"version": library["version"], "managed_root": target},
            )
            assert response.status_code in (409, 422), response.text
        response = client.post(
            "/api/v1/libraries",
            headers=HEADERS,
            json={"name": "bad", "source_roots": [str(source)], "managed_root": str(nonempty)},
        )
        assert response.status_code == 409
        assert (nonempty / "personal.txt").read_text() == "preserve"
        response = client.put(
            f"/api/v1/libraries/{library['id']}",
            headers=HEADERS,
            json={
                "version": library["version"],
                "name": library["name"],
                "source_roots": [str(source)],
                "managed_root": str(tmp_path / "new"),
            },
        )
        assert (
            response.status_code == 409
            and response.json()["detail"] == "library_migration_required"
        )


@pytest.mark.parametrize("profile", [None, "listener", "editor", "librarian", "owner"])
def test_storage_routes_authorize_before_probing_owner_selected_paths(
    settings, authenticated_client, tmp_path, monkeypatch, profile
):
    source = tmp_path / "watch"
    source.mkdir()
    target = tmp_path / "owner-selected-mount"
    with authenticated_client(settings) as owner:
        library = owner.get("/api/v1/libraries").json()[0]
        other = TestClient(owner.app)
        try:
            if profile not in (None, "owner"):
                created = owner.post(
                    "/api/v1/manage/users",
                    headers=HEADERS,
                    json={
                        "username": "storage-review-user",
                        "password": "storage-review-test-password",
                        "profile": profile,
                        "library_ids": [library["id"]],
                    },
                )
                assert created.status_code == 201
                signed_in = other.post(
                    "/api/v1/auth/login",
                    headers=HEADERS,
                    json={
                        "username": "storage-review-user",
                        "password": "storage-review-test-password",
                    },
                )
                assert signed_in.status_code == 200

            def forbidden_probe(*_args, **_kwargs):
                pytest.fail("A denied request must not probe its requested server path")

            monkeypatch.setattr(LibraryStorage, "destination", forbidden_probe)
            client = owner if profile == "owner" else other
            headers = {} if profile == "owner" else HEADERS
            expected = 401 if profile is None else 403
            create = client.post(
                "/api/v1/libraries",
                headers=headers,
                json={
                    "name": "Owner path",
                    "source_roots": [str(source)],
                    "managed_root": str(target),
                },
            )
            migration = client.post(
                f"/api/v1/libraries/{library['id']}/migrations",
                headers=headers,
                json={"version": library["version"], "managed_root": str(target)},
            )
            retry = client.post(
                f"/api/v1/libraries/{library['id']}/migrations/not-a-job/retry", headers=headers
            )
            assert create.status_code == expected, create.text
            assert migration.status_code == expected, migration.text
            assert retry.status_code == expected, retry.text
            assert not target.exists()
            with Database(settings.data_dir).connect() as db:
                assert db.execute("SELECT count(*) FROM library_migrations").fetchone()[0] == 0
        finally:
            other.close()


def test_storage_resolves_aliases_before_rejecting_reserved_roots(
    settings, authenticated_client, tmp_path
):
    settings = settings.model_copy(
        update={"podcasts_dir": tmp_path / "podcasts", "web_dir": tmp_path / "web"}
    )
    settings.music_dir.mkdir()
    settings.web_dir.mkdir()
    with authenticated_client(settings) as client:
        library = client.get("/api/v1/libraries").json()[0]
        for index, root in enumerate(
            (
                settings.data_dir,
                settings.podcasts_dir,
                settings.web_dir,
                settings.library_dir,
                settings.music_dir,
            )
        ):
            alias = tmp_path / f"directory-alias-{index}"
            alias.symlink_to(root, target_is_directory=True)
            response = client.post(
                f"/api/v1/libraries/{library['id']}/migrations",
                headers=HEADERS,
                json={
                    "version": library["version"],
                    "managed_root": str(alias / "unexpected-copy"),
                },
            )
            assert response.status_code == 422, response.text
            assert not (root / "unexpected-copy").exists()


@pytest.mark.parametrize("profile,enabled", [("librarian", 1), ("owner", 0)])
def test_migration_rechecks_owner_before_touching_files(
    settings, authenticated_client, tmp_path, profile, enabled
):
    source = tmp_path / "old-files"
    source.mkdir()
    original = source / "original.mp3"
    original.write_bytes(b"keep source")
    target = tmp_path / "new-mount"
    with authenticated_client(settings) as client:
        catalog = client.app.state.library_catalog
        with catalog.database.connect(write=True) as db:
            db.execute("UPDATE users SET profile=?,enabled=? WHERE id='admin'", (profile, enabled))
        with pytest.raises(HTTPException) as denied:
            LibraryStorage(catalog).copy(
                {"created_by": "admin", "source_root": str(source), "target_root": str(target)}
            )
        assert denied.value.status_code == 403
        assert original.read_bytes() == b"keep source"
        assert not target.exists()


def test_automatic_collection_respects_last_release_time(resources):
    _, _, store, path, db, user_id = resources
    store.configure(ResourceSettings(**{**store.settings(), "enabled": True, "retention_days": 7}))
    store.save("ep-east", user_id)
    with db.connect(write=True) as conn:
        conn.execute("UPDATE podcast_resource_state SET zero_since=?", (time.time() - 30 * 86400,))
    collection = store.cleanup(automatic=True, dry_run=False)
    assert collection["deleted_count"] == 0
    store.release("ep-east", user_id)
    collection = store.cleanup(automatic=True, dry_run=False)
    assert collection["deleted_count"] == 0
    with db.connect(write=True) as conn:
        conn.execute("UPDATE podcast_resource_state SET zero_since=?", (time.time() - 8 * 86400,))
    collection = store.cleanup(automatic=True, dry_run=False)
    assert collection["deleted_count"] == 1
    assert not path.exists()
    # A newly downloaded physical copy starts a fresh cache grace period.
    path.write_bytes(b"new shared audio")
    with db.connect(write=True) as conn:
        conn.execute(
            "UPDATE podcast_episodes SET local_path=?,download_status='downloaded' WHERE id='ep-east'",
            (str(path),),
        )
        store.downloaded(conn, "ep-east")
    collection = store.cleanup(automatic=True, dry_run=False)
    assert collection["deleted_count"] == 0
    assert path.is_file()


def test_approved_paused_source_keeps_its_identity_and_queues_after_running_import(
    settings, authenticated_client, tmp_path
):
    from wildstring.library.scope import library_context
    from wildstring.management import JobRequest

    first, second = tmp_path / "watch-a", tmp_path / "watch-b"
    first.mkdir()
    second.mkdir()
    with authenticated_client(settings) as client:
        manager = client.app.state.management
        manager.stop()
        catalog = client.app.state.library_catalog
        library = catalog.save(
            LibraryInput(
                name="Sources",
                source_roots=[str(first), str(second)],
                paused_source_roots=[str(second)],
            )
        )
        ids = {s["root"]: s["id"] for s in library["sources"]}
        with library_context("admin", library["id"], ids[str(first)]):
            initial = manager.submit(JobRequest(kind="import"))
        with catalog.database.connect(write=True) as db:
            db.execute("UPDATE admin_jobs SET status='running' WHERE id=?", (initial["id"],))
        with library_context("admin", library["id"], ids[str(second)]):
            next_job = manager.submit(JobRequest(kind="import"), automatic=True, followup=True)
            assert next_job["source_id"] == ids[str(second)]
            assert next_job["id"] != initial["id"]
            assert (
                manager.submit(JobRequest(kind="import"), automatic=True, followup=True)["id"]
                == next_job["id"]
            )
        # Pausing discovery does not discard an explicitly approved import.
        with catalog.database.connect() as db:
            assert (
                db.execute(
                    "SELECT status FROM admin_jobs WHERE id=?", (next_job["id"],)
                ).fetchone()[0]
                == "queued"
            )


def test_schema38_removes_only_automatic_protection_and_preserves_files_refs_and_policy(resources):
    _, _, store, path, database, user_id = resources
    manual_path = path.with_name("manual.mp3")
    manual_path.write_bytes(b"explicitly protected")
    with database.connect(write=True) as db:
        db.execute(
            "UPDATE podcast_resource_state SET protected=1,version=1 WHERE episode_id='ep-east'"
        )
        db.execute(
            "UPDATE podcast_episodes SET local_path=?,download_status='downloaded' WHERE id='ep-coffee'",
            (str(manual_path),),
        )
        store.downloaded(db, "ep-coffee")
    item = next(row for row in store.listing()["items"] if row["id"] == "ep-coffee")
    store.protect("ep-coffee", ProtectionUpdate(version=item["version"], protected=True))
    store.save("ep-east", user_id)
    policy = store.configure(
        ResourceSettings(**{**store.settings(), "enabled": True, "retention_days": 30})
    )
    with database.connect(write=True) as db:
        lease = store.acquire(db, "ep-east")
        db.execute("PRAGMA user_version=38")
    database.initialize()
    with database.connect() as db:
        state = {
            row["episode_id"]: dict(row)
            for row in db.execute("SELECT * FROM podcast_resource_state")
        }
        assert state["ep-east"]["protected"] == 0
        assert state["ep-coffee"]["protected"] == 1
        assert db.execute("PRAGMA user_version").fetchone()[0] == SCHEMA_VERSION
    assert store.saved_ids(user_id) == {"ep-east"}
    assert store.settings() == policy
    assert path.read_bytes() == b"shared audio"
    assert manual_path.read_bytes() == b"explicitly protected"
    assert store.cleanup()["candidate_count"] == 0
    store.release_lease(lease)
    store.release("ep-east", user_id)
    # A released save still receives the configured retention period.
    assert store.cleanup(automatic=True)["candidate_count"] == 0
    assert store.cleanup()["candidate_count"] == 1
    assert path.exists()  # Preview never removes audio.
    database.initialize()
    assert (
        next(row for row in store.listing()["items"] if row["id"] == "ep-coffee")["protected"]
        is True
    )


def test_discovered_existing_audio_uses_standard_zero_reference_retention(resources):
    _, _, store, path, database, _ = resources
    with database.connect(write=True) as db:
        db.execute("DELETE FROM podcast_resource_state WHERE episode_id='ep-east'")
    item = store.listing()["items"][0]
    assert item["protected"] is False
    assert item["reference_count"] == 0
    assert store.cleanup()["candidate_count"] == 1
    assert path.exists()
    store.configure(ResourceSettings(**{**store.settings(), "enabled": True, "retention_days": 7}))
    assert store.cleanup(automatic=True)["candidate_count"] == 0
    with database.connect(write=True) as db:
        db.execute(
            "UPDATE podcast_resource_state SET zero_since=? WHERE episode_id='ep-east'",
            (time.time() - 8 * 86400,),
        )
    result = store.cleanup(automatic=True, dry_run=False)
    assert result["deleted_count"] == 1
    assert not path.exists()
