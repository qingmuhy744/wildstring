import io

from PIL import Image
from test_personal_library import music
from test_providers import HEADERS

from wildstring.library.scanner import scan_library


def _sample_cover():
    buf = io.BytesIO()
    img = Image.new("RGB", (100, 100), color=(255, 0, 0))
    img.save(buf, format="JPEG")
    return buf.getvalue()


def test_album_management_metadata_and_cover(settings, authenticated_client):
    music(settings, "CD01/01.一无所有.flac", ["崔健"], ["崔健"], album="新长征路上的摇滚", number=1)
    music(settings, "CD01/02.假行僧.flac", ["崔健"], ["崔健"], album="新长征路上的摇滚", number=2)
    scan_library(settings)

    with authenticated_client(settings) as client:
        albums_res = client.get("/api/v1/albums")
        assert albums_res.status_code == 200
        album_id = albums_res.json()["items"][0]["id"]

        # 1. 检查 metadata_album 返回
        meta_res = client.get(f"/api/v1/manage/metadata/albums?album_id={album_id}")
        assert meta_res.status_code == 200
        data = meta_res.json()
        assert data["album_id"] == album_id
        assert data["primary_title"] == "新长征路上的摇滚"
        assert "崔健" in data["primary_artists"]
        assert len(data["tracks"]) == 2
        assert data["discs"] == [1]

        # 2. 批量修改专辑元数据（省略 tracks，自动应用）
        update_res = client.put(
            "/api/v1/manage/metadata/albums",
            headers=HEADERS,
            json={
                "album_id": album_id,
                "overrides": {
                    "album": "新长征路上的摇滚 (特别版)",
                    "album_artists": ["崔健"],
                    "release_date": "1989-02-01",
                    "label": "中国旅游声像出版社",
                    "catalog_number": "CS-001",
                    "genres": ["摇滚", "独立"],
                },
            },
        )
        assert update_res.status_code == 200
        assert update_res.json()["updated"] == 2

        # 重新获取新 album_id 下的元数据
        new_albums = client.get("/api/v1/albums").json()["items"]
        new_album_id = new_albums[0]["id"]
        updated_data = client.get(f"/api/v1/manage/metadata/albums?album_id={new_album_id}").json()
        assert updated_data["primary_title"] == "新长征路上的摇滚 (特别版)"
        assert updated_data["label"] == "中国旅游声像出版社"
        assert updated_data["catalog_number"] == "CS-001"
        assert "摇滚" in updated_data["genres"]

        # 3. 上传专辑封面
        cover_bytes = _sample_cover()
        upload_res = client.post(
            f"/api/v1/manage/albums/{new_album_id}/cover",
            headers=HEADERS,
            files={"file": ("custom_cover.jpg", cover_bytes, "image/jpeg")},
            data={"save_sidecar": "true"},
        )
        assert upload_res.status_code == 200
        cover_info = upload_res.json()
        assert cover_info["album_id"] == new_album_id
        assert cover_info["tracks_updated"] == 2
        assert "image_sha256" in cover_info

        # 检查是否成功标记 has_cover 和 custom_cover
        check_data = client.get(f"/api/v1/manage/metadata/albums?album_id={new_album_id}").json()
        assert check_data["has_custom_cover"] is True

        # 检查物理目录中是否保存了 cover.jpg (CD01 的上一级或者本级)
        sidecar = settings.library_dir / "CD01" / "cover.jpg"
        if not sidecar.is_file():
            sidecar = settings.library_dir / "cover.jpg"
        assert sidecar.is_file()

        # 4. 删除自定义封面
        del_res = client.delete(
            f"/api/v1/manage/albums/{new_album_id}/cover",
            headers=HEADERS,
        )
        assert del_res.status_code == 200
        after_del = client.get(f"/api/v1/manage/metadata/albums?album_id={new_album_id}").json()
        assert after_del["has_custom_cover"] is False


def test_album_update_with_null_and_empty_fields(settings, authenticated_client):
    music(settings, "CD01/01.落泪的戏子.flac", ["郑智化"], ["郑智化"], album="落泪的戏子", number=1)
    scan_library(settings)

    with authenticated_client(settings) as client:
        albums_res = client.get("/api/v1/albums")
        album_id = albums_res.json()["items"][0]["id"]

        # 测试即使传了 null 的 genres 和 description，或者空值，也能正常保存无 422
        res = client.put(
            "/api/v1/manage/metadata/albums",
            headers=HEADERS,
            json={
                "album_id": album_id,
                "overrides": {
                    "album": "落泪的戏子 (修复版)",
                    "album_artists": ["郑智化"],
                    "release_date": "1993",
                    "original_date": None,
                    "genres": None,
                    "description": None,
                    "label": None,
                    "catalog_number": None,
                },
            },
        )
        assert res.status_code == 200
        assert res.json()["updated"] == 1
