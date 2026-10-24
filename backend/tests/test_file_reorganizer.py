from test_personal_library import music
from test_providers import HEADERS

from wildstring.database import Database
from wildstring.library.file_reorganizer import get_track_file_info
from wildstring.library.repository import LibraryRepository
from wildstring.library.scanner import scan_library


def test_file_info_and_reorganize(settings, authenticated_client):
    music(settings, "歌曲.flac", ["原艺人"], ["原艺人"], album="原专辑")
    scan_library(settings)

    with authenticated_client(settings) as client:
        track = client.get("/api/v1/tracks").json()["items"][0]
        track_id = track["id"]

        # 1. Test get_track_file_info via endpoint
        res = client.get(f"/api/v1/tracks/{track_id}/file-info")
        assert res.status_code == 200
        info = res.json()
        assert info["track_id"] == track_id
        assert info["format"] == "flac"
        assert info["file_exists"] is True
        assert "path" in info
        assert "suggested_path" in info

        # Initially in sync
        repo = LibraryRepository(Database(settings.data_dir), settings.library_dir)
        initial_info = get_track_file_info(repo, track_id)
        assert initial_info["file_exists"] is True

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
