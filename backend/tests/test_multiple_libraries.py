"""Library grants must fence real data, assets, playlists and queued imports."""

import shutil
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from wildstring.database import Database
from wildstring.library.scanner import scan_library

HEADERS = {"X-Wildstring-Client": "web"}
FIXTURE = Path(__file__).resolve().parents[2] / "tests/fixtures/audio/silence.mp3"


@pytest.fixture
def catalog(settings, authenticated_client, tmp_path):
    shutil.copyfile(FIXTURE, settings.library_dir / "first.mp3")
    scan_library(settings)
    source = tmp_path / "second-source"
    source.mkdir()
    with authenticated_client(settings) as client:
        default = client.get("/api/v1/libraries").json()[0]
        response = client.post(
            "/api/v1/libraries",
            headers=HEADERS,
            json={"name": "古典音乐", "source_roots": [str(source)]},
        )
        assert response.status_code == 201, response.text
        second = response.json()
        shutil.copyfile(FIXTURE, Path(second["managed_root"]) / "second.mp3")
        scan_library(settings.model_copy(update={"library_dir": Path(second["managed_root"])}))
        tracks = client.get("/api/v1/tracks").json()["items"]
        assert len(tracks) == 2
        yield client, default, second, tracks, source


def listener(client, library_ids, profile="listener"):
    response = client.post(
        "/api/v1/manage/users",
        headers=HEADERS,
        json={
            "username": "library-user",
            "password": "library-test-password",
            "profile": profile,
            "library_ids": library_ids,
        },
    )
    assert response.status_code == 201, response.text
    other = TestClient(client.app)
    assert (
        other.post(
            "/api/v1/auth/login",
            headers=HEADERS,
            json={"username": "library-user", "password": "library-test-password"},
        ).status_code
        == 200
    )
    return other, response.json()["id"]


def test_grants_filter_catalog_and_block_direct_objects_and_assets(catalog):
    client, first, second, tracks, _ = catalog
    other, _ = listener(client, [second["id"]])
    try:
        assert [r["id"] for r in other.get("/api/v1/libraries").json()] == [second["id"]]
        page = other.get("/api/v1/tracks").json()
        assert page["total"] == 1
        permitted = next(t for t in tracks if t["library_id"] == second["id"])
        forbidden = next(t for t in tracks if t["library_id"] == first["id"])
        assert (
            client.get(
                f"/api/v1/manage/tracks/{permitted['id']}/metadata",
                headers={"X-Wildstring-Library": first["id"]},
            ).status_code
            == 200
        )
        assert page["items"][0]["id"] == permitted["id"]
        assert other.get("/api/v1/albums").json()["total"] == 1
        assert other.get("/api/v1/browse-index?kind=tracks").json()["total"] == 1
        for suffix in ("", "/stream", "/cover", "/lyrics"):
            assert other.get(f"/api/v1/tracks/{forbidden['id']}{suffix}").status_code == 404
        assert other.get(f"/api/v1/albums/{forbidden['album_id']}").status_code == 404
        assert other.get(f"/api/v1/tracks/{permitted['id']}/stream").status_code == 200
        assert (
            other.get("/api/v1/tracks", headers={"X-Wildstring-Library": first["id"]}).status_code
            == 404
        )
    finally:
        other.close()


def test_cross_library_playlist_retains_hidden_slots_across_revocation(catalog):
    client, first, second, tracks, _ = catalog
    other, user_id = listener(client, [first["id"], second["id"]])
    try:
        playlist = other.post(
            "/api/v1/playlists", headers=HEADERS, json={"name": "跨库歌单"}
        ).json()
        added = other.post(
            f"/api/v1/playlists/{playlist['id']}/tracks",
            headers=HEADERS,
            json={"version": playlist["version"], "track_ids": [t["id"] for t in tracks]},
        )
        assert added.status_code == 200, added.text
        assert added.json()["track_count"] == 2
        access = client.get(f"/api/v1/libraries/access/{user_id}").json()
        changed = client.put(
            f"/api/v1/libraries/access/{user_id}",
            headers=HEADERS,
            json={"version": access["version"], "library_ids": [first["id"]]},
        )
        assert changed.status_code == 200
        visible = other.get(f"/api/v1/playlists/{playlist['id']}/tracks").json()
        assert visible["total"] == 1
        assert visible["items"][0]["library_id"] == first["id"]
        restored = client.put(
            f"/api/v1/libraries/access/{user_id}",
            headers=HEADERS,
            json={"version": changed.json()["version"], "library_ids": [first["id"], second["id"]]},
        )
        assert restored.status_code == 200
        assert other.get(f"/api/v1/playlists/{playlist['id']}/tracks").json()["total"] == 2
    finally:
        other.close()


def test_two_sources_import_to_one_managed_library_without_changing_sources(
    catalog, settings, tmp_path
):
    client, _, second, _, source = catalog
    extra = tmp_path / "extra-source"
    extra.mkdir()
    shutil.copyfile(FIXTURE, source / "one.mp3")
    shutil.copyfile(FIXTURE, extra / "duplicate.mp3")
    response = client.put(
        f"/api/v1/libraries/{second['id']}",
        headers=HEADERS,
        json={
            "version": second["version"],
            "name": "两个文件夹",
            "source_roots": [str(source), str(extra)],
        },
    )
    assert response.status_code == 200, response.text
    scoped = {**HEADERS, "X-Wildstring-Library": second["id"]}
    roots = client.get("/api/v1/manage/library/sources", headers=scoped).json()["items"]
    assert len(roots) == 2
    for root in roots:
        assert (
            client.get(
                f"/api/v1/manage/library/folders?source_id={root['id']}", headers=scoped
            ).status_code
            == 200
        )
    queued = client.post("/api/v1/manage/jobs", headers=scoped, json={"kind": "import"})
    assert queued.status_code == 202, queued.text
    result = queued.json()
    deadline = time.monotonic() + 15
    while result["status"] in {"queued", "running"} and time.monotonic() < deadline:
        time.sleep(0.1)
        result = client.get(f"/api/v1/manage/jobs/{result['id']}", headers=scoped).json()
    assert result["status"] in {"completed", "completed_with_errors"}, result
    with Database(settings.data_dir).connect() as db:
        imported = db.execute(
            "SELECT source_root,target_path FROM imported_files WHERE target_root=?",
            (second["managed_root"],),
        ).fetchall()
        assert {row["source_root"] for row in imported} == {
            str(source.resolve()),
            str(extra.resolve()),
        }
        assert len({row["target_path"] for row in imported}) == 1
    assert (source / "one.mp3").read_bytes() == FIXTURE.read_bytes()
    assert (extra / "duplicate.mp3").read_bytes() == FIXTURE.read_bytes()


def test_new_account_can_have_no_music_grants_and_cannot_escalate(catalog):
    client, _, second, _, _ = catalog
    other, user_id = listener(client, [])
    try:
        assert other.get("/api/v1/libraries").json() == []
        assert other.get("/api/v1/tracks").json()["total"] == 0
        assert other.get("/api/v1/albums").json()["total"] == 0
        assert (
            other.put(
                f"/api/v1/libraries/access/{user_id}",
                headers=HEADERS,
                json={"version": 1, "library_ids": [second["id"]]},
            ).status_code
            == 403
        )
    finally:
        other.close()


def test_schema35_upgrade_preserves_ids_accounts_playlists_progress_and_audio(
    settings, authenticated_client
):
    from migration_support import pre36

    from wildstring.database import SCHEMA_VERSION

    shutil.copyfile(FIXTURE, settings.library_dir / "legacy.mp3")
    original = (settings.library_dir / "legacy.mp3").read_bytes()
    scan_library(settings)
    with authenticated_client(settings) as client:
        track = client.get("/api/v1/tracks").json()["items"][0]
        library = client.get("/api/v1/libraries").json()[0]
        other, user_id = listener(client, [library["id"]])
        try:
            playlist = other.post(
                "/api/v1/playlists", headers=HEADERS, json={"name": "旧歌单"}
            ).json()
            saved = other.post(
                f"/api/v1/playlists/{playlist['id']}/tracks",
                headers=HEADERS,
                json={"version": playlist["version"], "track_ids": [track["id"]]},
            )
            assert saved.status_code == 200
        finally:
            other.close()
        with Database(settings.data_dir).connect(write=True) as db:
            db.execute(
                "INSERT INTO podcasts(id,title,feed_url,created_at) VALUES ('legacy-podcast','旧节目','https://example.com/old.xml',CURRENT_TIMESTAMP)"
            )
            db.execute(
                "INSERT INTO podcast_episodes(id,podcast_id,guid,title,audio_url,created_at) VALUES ('legacy-episode','legacy-podcast','old','旧单集','https://example.com/old.mp3',CURRENT_TIMESTAMP)"
            )
            db.execute(
                "INSERT INTO podcast_progress(user_id,episode_id,position_seconds,version,last_listened_at) VALUES (?,'legacy-episode',123,4,CURRENT_TIMESTAMP)",
                (user_id,),
            )
    database = Database(settings.data_dir)
    with database.connect(write=True) as db:
        pre36(db)
        db.execute("PRAGMA user_version=35")
    database.initialize()
    with authenticated_client(settings) as client:
        assert client.get("/api/v1/libraries").json()[0]["id"] == library["id"]
        assert client.get(f"/api/v1/libraries/access/{user_id}").json()["library_ids"] == [
            library["id"]
        ]
        other = TestClient(client.app)
        try:
            assert (
                other.post(
                    "/api/v1/auth/login",
                    headers=HEADERS,
                    json={"username": "library-user", "password": "library-test-password"},
                ).status_code
                == 200
            )
            assert (
                other.get(f"/api/v1/playlists/{playlist['id']}/tracks").json()["items"][0]["id"]
                == track["id"]
            )
            assert other.get("/api/v1/podcasts?followed=true").json() == []
        finally:
            other.close()
    with database.connect() as db:
        assert db.execute("PRAGMA user_version").fetchone()[0] == SCHEMA_VERSION
        assert tuple(
            db.execute(
                "SELECT position_seconds,version FROM podcast_progress WHERE user_id=?", (user_id,)
            ).fetchone()
        ) == (123, 4)
    assert (settings.library_dir / "legacy.mp3").read_bytes() == original


def test_queued_import_rechecks_revoked_grants_before_copying(catalog):
    client, _, second, _, source = catalog
    client.app.state.management.stop()
    shutil.copyfile(FIXTURE, source / "pending.mp3")
    other, user_id = listener(client, [second["id"]], profile="librarian")
    try:
        job = other.post(
            f"/api/v1/manage/jobs?library_id={second['id']}",
            headers=HEADERS,
            json={"kind": "import", "source_id": "all"},
        )
        assert job.status_code == 202, job.text
        version = client.get(f"/api/v1/libraries/access/{user_id}").json()["version"]
        assert (
            client.put(
                f"/api/v1/libraries/access/{user_id}",
                headers=HEADERS,
                json={"version": version, "library_ids": []},
            ).status_code
            == 200
        )
        with Database(client.app.state.management.database.path.parent).connect() as db:
            record = dict(
                db.execute("SELECT * FROM admin_jobs WHERE id=?", (job.json()["id"],)).fetchone()
            )
        client.app.state.management.execute(record)
        with client.app.state.management.database.connect() as db:
            assert (
                db.execute("SELECT status FROM admin_jobs WHERE id=?", (record["id"],)).fetchone()[
                    0
                ]
                == "failed"
            )
        assert (source / "pending.mp3").exists()
        assert len(list(Path(second["managed_root"]).rglob("*.mp3"))) == 1
    finally:
        other.close()


def test_ai_cross_library_playlist_preserves_hidden_references_when_edited(catalog):
    client, first, second, tracks, _ = catalog
    other, user_id = listener(client, [first["id"], second["id"]])
    base = "/api/v1/agent"

    def draft_and_apply(payload):
        response = other.post(
            base + "/drafts",
            headers=HEADERS,
            json={"kind": "playlist", "title": "跨库歌单草案", "payload": payload},
        )
        assert response.status_code == 200, response.text
        draft = response.json()
        assert (
            other.post(
                base + f"/drafts/{draft['id']}/approve", headers=HEADERS, json={"version": 1}
            ).status_code
            == 200
        )
        applied = other.post(
            base + f"/drafts/{draft['id']}/apply",
            headers=HEADERS,
            json={"version": 1, "idempotency_key": "apply-" + draft["id"]},
        )
        assert applied.status_code == 200, applied.text
        return applied.json()["result"]["playlist_id"]

    try:
        playlist_id = draft_and_apply(
            {"name": "跨库 AI 歌单", "track_ids": [t["id"] for t in tracks]}
        )
        version = client.get(f"/api/v1/libraries/access/{user_id}").json()["version"]
        access = client.put(
            f"/api/v1/libraries/access/{user_id}",
            headers=HEADERS,
            json={"version": version, "library_ids": [first["id"]]},
        ).json()
        playlist = other.get(f"/api/v1/playlists/{playlist_id}").json()
        visible = next(t for t in tracks if t["library_id"] == first["id"])
        draft_and_apply(
            {
                "name": "修改可见部分",
                "playlist_id": playlist_id,
                "playlist_version": playlist["version"],
                "track_ids": [visible["id"]],
            }
        )
        assert (
            client.put(
                f"/api/v1/libraries/access/{user_id}",
                headers=HEADERS,
                json={"version": access["version"], "library_ids": [first["id"], second["id"]]},
            ).status_code
            == 200
        )
        assert [
            t["id"] for t in other.get(f"/api/v1/playlists/{playlist_id}/tracks").json()["items"]
        ] == [t["id"] for t in tracks]
    finally:
        other.close()


def test_intake_approval_resolves_the_items_actual_source_folder(catalog, settings, tmp_path):
    from mutagen.flac import FLAC
    from PIL import Image

    client, _, second, _, source = catalog
    Image.new("RGB", (16, 16)).save(Path(second["managed_root"]) / "cover.png")
    extra = tmp_path / "review-source"
    extra.mkdir()
    path = extra / "needs-tags.flac"
    shutil.copyfile(FIXTURE.with_suffix(".flac"), path)
    tags = FLAC(path)
    tags.clear()
    tags.save()
    updated = client.put(
        f"/api/v1/libraries/{second['id']}",
        headers=HEADERS,
        json={
            "version": second["version"],
            "name": second["name"],
            "source_roots": [str(source), str(extra)],
        },
    )
    assert updated.status_code == 200
    source_id = next(
        item["id"] for item in updated.json()["sources"] if item["root"] == str(extra.resolve())
    )
    with Database(settings.data_dir).connect(write=True) as db:
        db.execute(
            "UPDATE library_sources SET id='zz-review-source' WHERE library_id=? AND id=?",
            (second["id"], source_id),
        )
    source_id = "zz-review-source"
    scoped = {**HEADERS, "X-Wildstring-Library": second["id"]}
    job = client.post(
        "/api/v1/manage/jobs", headers=scoped, json={"kind": "import", "source_id": source_id}
    ).json()
    deadline = time.monotonic() + 15
    while job["status"] in {"queued", "running"} and time.monotonic() < deadline:
        time.sleep(0.1)
        job = client.get(f"/api/v1/manage/jobs/{job['id']}", headers=scoped).json()
    items = client.get("/api/v1/manage/intake/items", headers=scoped).json()["items"]
    item = next(item for item in items if item["source_path"] == path.name)
    assert item["state"] == "review", item
    assert not list((settings.data_dir / "intake" / item["id"]).rglob("cover.png"))
    response = client.post(
        f"/api/v1/manage/intake/items/{item['id']}/approve",
        headers=scoped,
        json={
            "version": item["version"],
            "overrides": {
                "title": "已核对",
                "artists": ["艺人"],
                "album": "专辑",
                "album_artists": ["艺人"],
            },
        },
    )
    assert response.status_code == 200, response.text


def test_discovery_survives_a_source_replaced_after_its_snapshot(catalog, monkeypatch):
    from wildstring.library.catalog import current_library

    client, _, second, _, _ = catalog
    manager = client.app.state.management
    manager.stop()
    manager.discovery_due.clear()
    visited = []

    def source_changes():
        context = current_library.get()
        visited.append(context.library_id)
        if context.library_id == second["id"]:
            with manager.database.connect(write=True) as db:
                db.execute(
                    "UPDATE library_sources SET id='replacement-source' WHERE library_id=?",
                    (second["id"],),
                )
            # The same lookup used by automatic imports must reject the stale source identity.
            _ = manager.settings
        return False

    monkeypatch.setattr(manager.intake, "has_work", source_changes)
    manager.discover_sources()
    assert second["id"] in visited
    assert len(visited) == 2
