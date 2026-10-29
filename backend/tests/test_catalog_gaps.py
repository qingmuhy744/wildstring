"""Tests for artist catalog gap audit feature."""

import shutil
from pathlib import Path

from fastapi.testclient import TestClient
from mutagen.flac import FLAC

from wildstring.config import Settings
from wildstring.library.scanner import scan_library

HEADERS = {"X-Wildstring-Client": "web"}
FIXTURE = Path(__file__).resolve().parents[2] / "tests/fixtures/audio/silence.flac"


def test_catalog_gaps_api(settings: Settings, authenticated_client):
    with authenticated_client(settings) as client:
        # Test audit for 许嵩
        res = client.post(
            "/api/v1/ai/catalog-gaps",
            json={"artist": "许嵩", "limit": 10},
        )
        assert res.status_code == 200
        data = res.json()
        assert data["artist"] == "许嵩"
        assert data["total_target"] == 10
        assert data["total_target"] == data["matched_count"] + data["missing_count"]
        assert 0 <= data["coverage_percent"] <= 100
        assert len(data["missing"]) > 0 or len(data["matched"]) > 0
        assert "许嵩" in data["summary"]


def test_catalog_gaps_respects_selected_library(settings, authenticated_client):
    hidden = settings.library_dir / "hidden.flac"
    shutil.copyfile(FIXTURE, hidden)
    tags = FLAC(hidden)
    tags["artist"] = ["许嵩"]
    tags["albumartist"] = ["许嵩"]
    tags["title"] = "有何不可"
    tags["album"] = "自定义"
    tags.save()
    scan_library(settings)

    with authenticated_client(settings) as owner:
        source = settings.data_dir.parent / "visible-source"
        source.mkdir()
        created = owner.post(
            "/api/v1/libraries",
            headers=HEADERS,
            json={"name": "可见库", "source_roots": [str(source)]},
        )
        assert created.status_code == 201, created.text
        visible = created.json()
        path = Path(visible["managed_root"]) / "visible.flac"
        shutil.copyfile(FIXTURE, path)
        tags = FLAC(path)
        tags["artist"] = ["许嵩"]
        tags["albumartist"] = ["许嵩"]
        tags["title"] = "素颜"
        tags["album"] = "单曲"
        tags.save()
        scan_library(settings.model_copy(update={"library_dir": Path(visible["managed_root"])}))
        assert (
            owner.post(
                "/api/v1/manage/users",
                headers=HEADERS,
                json={
                    "username": "catalog-gap-listener",
                    "password": "catalog-gap-password",
                    "library_ids": [visible["id"]],
                },
            ).status_code
            == 201
        )

    with TestClient(owner.app) as listener:
        assert (
            listener.post(
                "/api/v1/auth/login",
                headers=HEADERS,
                json={
                    "username": "catalog-gap-listener",
                    "password": "catalog-gap-password",
                },
            ).status_code
            == 200
        )
        assert [track["title"] for track in listener.get("/api/v1/tracks").json()["items"]] == [
            "素颜"
        ]
        result = listener.post(
            "/api/v1/ai/catalog-gaps",
            headers=HEADERS,
            json={"artist": "许嵩", "limit": 10},
        )
        assert result.status_code == 200, result.text
        assert [item["matched_title"] for item in result.json()["matched"]] == ["素颜"]
