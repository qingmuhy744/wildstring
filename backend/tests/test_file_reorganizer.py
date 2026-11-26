import pytest
from fastapi.testclient import TestClient
from test_personal_library import music
from test_providers import HEADERS

from wildstring import album_release_locks
from wildstring.database import Database
from wildstring.library.albums import album_key
from wildstring.library.file_reorganizer import get_track_file_info
from wildstring.library.repository import LibraryRepository
from wildstring.library.scanner import scan_library


def test_reorganization_updates_folder_album_identity_and_release_lock(
    settings, authenticated_client
):
    music(settings, "源目录歌曲.flac", ["单曲艺人"], [], album="文件夹专辑")
    scan_library(settings)
    database = Database(settings.data_dir)
    with authenticated_client(settings) as client:
        track_id = client.get("/api/v1/tracks").json()["items"][0]["id"]
        metadata = f"/api/v1/manage/tracks/{track_id}/metadata"
        version = client.get(metadata).json()["version"]
        assert (
            client.put(
                metadata,
                headers=HEADERS,
                json={
                    "version": version,
                    "overrides": {"album_artists": []},
                },
            ).status_code
            == 200
        )
        with database.connect(write=True) as db:
            track = db.execute(
                "SELECT album_id,library_id,path,album FROM tracks WHERE id=?", (track_id,)
            ).fetchone()
            album_release_locks.save(
                db,
                track["library_id"],
                track["album_id"],
                album_release_locks.ReleaseLockInput(provider="fixture", release_id="release"),
            )
        response = client.post(f"/api/v1/manage/tracks/{track_id}/reorganize-file", headers=HEADERS)
        assert response.status_code == 200 and response.json()["changed"]
        new_id = album_key(track["library_id"], response.json()["new_path"], track["album"], [])
        assert new_id != track["album_id"]
        with database.connect() as db:
            assert (
                db.execute("SELECT album_id FROM tracks WHERE id=?", (track_id,)).fetchone()[0]
                == new_id
            )
            assert (
                album_release_locks.read(db, track["library_id"], new_id)["release_id"] == "release"
            )
            assert album_release_locks.read(db, track["library_id"], track["album_id"]) is None


def test_file_info_and_reorganize(settings, authenticated_client):
    music(settings, "歌曲.flac", ["原艺人"], ["原艺人"], album="原专辑")
    scan_library(settings)

    with authenticated_client(settings) as client:
        track = client.get("/api/v1/tracks").json()["items"][0]
        track_id = track["id"]

        # 1. Test get_track_file_info via endpoint (authenticated user here is owner)
        res = client.get(f"/api/v1/tracks/{track_id}/file-info")
        assert res.status_code == 200
        info = res.json()
        assert info["track_id"] == track_id
        assert info["format"] == "flac"
        assert info["file_exists"] is True
        assert "path" in info
        assert "suggested_path" in info
        assert info["absolute_path"] == info["full_path"]
        assert info["absolute_path"].startswith(str(settings.library_dir))
        assert info["library_root"] == str(settings.library_dir)

        manage_res = client.get(f"/api/v1/manage/tracks/{track_id}/file-info")
        assert manage_res.status_code == 200
        assert manage_res.json()["absolute_path"] == info["absolute_path"]

        # Default direct helper hides host paths unless explicitly requested.
        repo = LibraryRepository(Database(settings.data_dir), settings.library_dir)
        initial_info = get_track_file_info(repo, track_id)
        assert initial_info["file_exists"] is True
        assert initial_info["absolute_path"] is None
        assert initial_info["full_path"] is None
        assert initial_info["library_root"] is None
        assert initial_info["source_path"] is None
        assert (
            get_track_file_info(repo, track_id, include_host_paths=True)["absolute_path"]
            == (info["absolute_path"])
        )

        # 2. Modify metadata to make it out of sync
        meta_res = client.get(f"/api/v1/manage/tracks/{track_id}/metadata")
        version = meta_res.json()["version"]
        update_res = client.put(
            f"/api/v1/manage/tracks/{track_id}/metadata",
            headers=HEADERS,
            json={
                "version": version,
                "overrides": {
                    "title": "新歌名",
                    "artists": ["新艺人"],
                    "album_artists": ["新艺人"],
                    "album": "新专辑",
                    "track_number": 5,
                    "disc_number": 1,
                },
            },
        )
        assert update_res.status_code == 200

        # Now info should indicate not in sync
        info2 = client.get(f"/api/v1/tracks/{track_id}/file-info").json()
        assert info2["in_sync"] is False
        assert "新艺人" in info2["suggested_path"]
        assert "新专辑" in info2["suggested_path"]

        # 3. Trigger reorganize
        reorg_res = client.post(
            f"/api/v1/manage/tracks/{track_id}/reorganize-file", headers=HEADERS
        )
        assert reorg_res.status_code == 200
        reorg_data = reorg_res.json()
        assert reorg_data["status"] == "reorganized"
        assert reorg_data["changed"] is True

        # Now file should be at new path on disk
        info3 = client.get(f"/api/v1/tracks/{track_id}/file-info").json()
        assert info3["in_sync"] is True
        assert info3["file_exists"] is True
        assert (settings.library_dir / info3["path"]).is_file()

        # Reorganizing again returns already_organized
        reorg_res2 = client.post(
            f"/api/v1/manage/tracks/{track_id}/reorganize-file", headers=HEADERS
        )
        assert reorg_res2.status_code == 200
        assert reorg_res2.json()["status"] == "already_organized"


@pytest.mark.parametrize(
    ("profile", "manage_status"),
    [("librarian", 200), ("editor", 200), ("listener", 403)],
)
def test_file_info_hides_host_paths_from_non_owner_roles(
    settings, authenticated_client, profile, manage_status
):
    music(settings, "权限测试.flac", ["歌手"], ["歌手"], album="专辑")
    scan_library(settings)

    with authenticated_client(settings) as owner:
        track_id = owner.get("/api/v1/tracks").json()["items"][0]["id"]
        library_id = owner.get("/api/v1/libraries").json()[0]["id"]
        with Database(settings.data_dir).connect(write=True) as connection:
            target_path = owner.get(f"/api/v1/tracks/{track_id}/file-info").json()["path"]
            connection.execute(
                """INSERT INTO imported_files(
                       source_root, source_path, target_root, target_path,
                       source_size, source_mtime, sha256
                   ) VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (
                    "/host/import/source",
                    "/host/import/source/权限测试.flac",
                    str(settings.library_dir),
                    target_path,
                    1234,
                    1,
                    "a" * 64,
                ),
            )

        owner_info = owner.get(f"/api/v1/tracks/{track_id}/file-info").json()
        assert owner_info["absolute_path"] == str(settings.library_dir / owner_info["path"])
        assert owner_info["full_path"] == owner_info["absolute_path"]
        assert owner_info["library_root"] == str(settings.library_dir)
        assert owner_info["source_path"] == "/host/import/source/权限测试.flac"
        assert owner_info["source_filename"] == "权限测试.flac"

        created = owner.post(
            "/api/v1/manage/users",
            headers=HEADERS,
            json={
                "username": f"user-{profile}",
                "password": "synthetic-role-password",
                "profile": profile,
                "library_ids": [library_id],
            },
        )
        assert created.status_code == 201, created.text

        actor = TestClient(owner.app)
        assert (
            actor.post(
                "/api/v1/auth/login",
                headers=HEADERS,
                json={"username": f"user-{profile}", "password": "synthetic-role-password"},
            ).status_code
            == 200
        )

        track_res = actor.get(f"/api/v1/tracks/{track_id}/file-info")
        assert track_res.status_code == 200
        data = track_res.json()
        assert data["source_filename"] == "权限测试.flac"
        assert data["path"] == owner_info["path"]
        assert data["suggested_path"] == owner_info["suggested_path"]
        assert data["absolute_path"] is None
        assert data["full_path"] is None
        assert data["library_root"] is None
        assert data["source_path"] is None

        manage_res = actor.get(f"/api/v1/manage/tracks/{track_id}/file-info")
        assert manage_res.status_code == manage_status
        if manage_status == 200:
            manage_data = manage_res.json()
            assert manage_data["source_filename"] == "权限测试.flac"
            assert manage_data["absolute_path"] is None
            assert manage_data["full_path"] is None
            assert manage_data["library_root"] is None
            assert manage_data["source_path"] is None
