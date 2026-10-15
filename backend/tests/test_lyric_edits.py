"""Lyrics are edited without touching music, preserve timing and reject stale saves."""

import hashlib

import pytest
from test_assets import audio, put_lyrics, url
from test_personal_library import HEADERS

from wildstring.library.scanner import scan_library


def test_plain_sync_clear_restore_rescan_and_music_unchanged(settings, authenticated_client):
    path = audio(settings)
    put_lyrics(path, "[00:01.200]文件第一句\n[00:02.300]文件第二句")
    public = url(settings)
    endpoint = public.replace("/tracks/", "/manage/tracks/") + "/lyrics"
    before = hashlib.sha256(path.read_bytes()).hexdigest()
    with authenticated_client(settings) as client:
        record = client.get(endpoint).json()
        assert record["override"] is None and record["effective"]["kind"] == "synced"
        assert record["text"] == "[00:01.200]文件第一句\n[00:02.300]文件第二句"
        for text in ("修改第一句\n修改第二句", "[00:00.123]修改第一句\n[00:00.234]修改第二句", ""):
            preview = client.post(endpoint + "/preview", headers=HEADERS, json={"text": text})
            assert preview.status_code == 200
            result = client.put(
                endpoint,
                headers=HEADERS,
                json={
                    "version": record["version"],
                    "file_version": record["file_version"],
                    "text": text,
                },
            )
            assert result.status_code == 200, result.text
            record = result.json()
            assert client.get(public + "/lyrics").json() == preview.json()
            scan_library(settings, full=True)
            assert client.get(endpoint).json() == record
        restored = client.put(
            endpoint,
            headers=HEADERS,
            json={
                "version": record["version"],
                "file_version": record["file_version"],
                "text": None,
            },
        )
        assert restored.status_code == 200
        assert client.get(public + "/lyrics").json()["source"] == "embedded"
        assert hashlib.sha256(path.read_bytes()).hexdigest() == before
        assert sorted(p.name for p in settings.library_dir.iterdir()) == [path.name]


def test_concurrent_editor_and_sidecar_changes_preserve_draft(settings, authenticated_client):
    path = audio(settings)
    public = url(settings)
    endpoint = public.replace("/tracks/", "/manage/tracks/") + "/lyrics"
    with authenticated_client(settings) as client:
        record = client.get(endpoint).json()
        body = {
            "version": record["version"],
            "file_version": record["file_version"],
            "text": "草稿",
        }
        assert client.put(endpoint, headers=HEADERS, json=body).status_code == 200
        assert client.put(endpoint, headers=HEADERS, json=body).status_code == 409
        record = client.get(endpoint).json()
        body.update(version=record["version"], file_version=record["file_version"])
        path.with_suffix(".lrc").write_text("[00:00.100]外部新增歌词")
        assert client.put(endpoint, headers=HEADERS, json=body).status_code == 409
        assert client.get(endpoint).json()["text"] == "草稿"
        assert client.get(public + "/lyrics").json()["lines"][0]["text"] == "草稿"
        assert client.get("/api/v1/manage/tracks/missing/lyrics").status_code == 404
        assert client.put(endpoint, json=body).status_code == 403


@pytest.mark.parametrize(
    "text",
    [
        "[00:01]第一句\n没有时间的第二句",
        "[00:90]时间错误",
        "中" * 200000,
        "\n".join(["行"] * 5001),
        "bad\x00text",
        "[00:00]" * 5001,
    ],
)
def test_lyric_validation_rejects_silent_truncation(settings, authenticated_client, text):
    audio(settings)
    public = url(settings)
    endpoint = public.replace("/tracks/", "/manage/tracks/") + "/lyrics"
    with authenticated_client(settings) as client:
        record = client.get(endpoint).json()
        response = client.put(
            endpoint,
            headers=HEADERS,
            json={
                "version": record["version"],
                "file_version": record["file_version"],
                "text": text,
            },
        )
        assert response.status_code == 422
        assert client.get(public + "/lyrics").json()["kind"] == "none"
