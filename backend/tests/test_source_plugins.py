"""Importable ZIPs exercise the real worker boundary with synthetic music only."""

import io
import json
from zipfile import ZipFile

import pytest
from fastapi import HTTPException
from test_personal_library import music
from test_providers import HEADERS

from wildstring.library.scanner import scan_library
from wildstring.plugin_archives import inspect_package
from wildstring.providers import Providers

BASE = "/api/v1/manage/source-plugins"
MANIFEST = {
    "id": "fixture-source",
    "name": "合成社区来源",
    "version": "1.0.0",
    "license": "GPL-3.0-only",
    "upstream": "https://example.com/fixture",
    "request_pacing": True,
    "settings": [{"key": "cookie", "type": "secret", "label": "Cookie"}],
}
ADAPTER = """
class Plugin:
    def search(self, context, query):
        return [{"id": "synthetic-song"}]
    def metadata(self, context, candidate):
        return {"id": candidate["id"], "release_id": "synthetic-release", "title": "摇滚", "artists": ["合成乐队"], "duration_ms": 12000, "fields": {"title": "摇滚", "artists": ["合成乐队"], "album": "录音室专辑"}, "source_url": "https://example.com/release?edition=studio"}
    def lyrics(self, context, candidate):
        return {"format": "qrc", "original": '<Lyric_1 LyricType="1" LyricContent="[1000,2000]摇(1000,500)滚(1500,1500)"/>', "normalized": {"format": "qrc", "kind": "synced", "layers": {"translation": [{"time_ms": 1000, "text": "Synthetic translation"}]}, "lines": [{"time_ms": 1000, "end_ms": 3000, "text": "摇滚", "words": [{"start_ms": 1000, "end_ms": 1500, "text": "摇"}, {"start_ms": 1500, "end_ms": 3000, "text": "滚"}]}]}}
"""


def package(extra=None, manifest=None):
    output = io.BytesIO()
    with ZipFile(output, "w") as archive:
        archive.writestr("manifest.json", json.dumps(manifest or MANIFEST))
        archive.writestr("adapter.py", ADAPTER)
        for name, value in (extra or {}).items():
            archive.writestr(name, value)
    return output.getvalue()


@pytest.mark.parametrize(
    "path", ["../escape.py", "/absolute.py", "sub/../../escape.py", "back\\escape.py"]
)
def test_unsafe_zip_is_rejected_before_import(path):
    with pytest.raises(HTTPException, match="source_plugin_invalid_zip"):
        inspect_package(package({path: "not extracted"}))


def test_zip_lifecycle_worker_matching_and_lyrics(settings, authenticated_client, monkeypatch):
    monkeypatch.setattr(Providers, "start", lambda self: None)
    music(settings, "摇滚.flac", ["合成乐队"], ["合成乐队"])
    scan_library(settings)
    source_zip = package()
    with authenticated_client(settings) as client:
        assert client.get(BASE).json()["items"] == []
        assert client.post(BASE + "/import", content=source_zip).status_code == 403
        imported = client.post(BASE + "/import", headers=HEADERS, content=source_zip)
        assert imported.status_code == 200, imported.text
        value = imported.json()
        assert value["enabled"] is False and value["version"] == 1
        disabled_test = client.post(BASE + "/fixture-source/test", headers=HEADERS)
        assert disabled_test.status_code == 409
        assert disabled_test.json()["detail"] == "source_plugin_disabled"
        assert client.get(BASE + "/fixture-source/export").content == source_zip
        assert client.post(BASE + "/import", headers=HEADERS, content=source_zip).status_code == 409
        saved = client.put(
            BASE + "/fixture-source",
            headers=HEADERS,
            json={"version": 1, "enabled": True, "config": {"cookie": "synthetic-plugin-secret"}},
        )
        assert saved.status_code == 200, saved.text
        assert "synthetic-plugin-secret" not in saved.text and saved.json()[
            "configured_secrets"
        ] == ["cookie"]
        assert client.post(BASE + "/fixture-source/test", headers=HEADERS).json() == {
            "ok": True,
            "count": 1,
        }
        providers = client.app.state.providers
        track = client.get("/api/v1/tracks").json()["items"][0]
        values, warnings = providers.sources.suggestions(track)
        assert not warnings and values[0][4]["source_id"] == "synthetic-song"
        endpoint = f"/api/v1/manage/tracks/{track['id']}/online-lyrics"
        assert client.post(endpoint, headers=HEADERS).status_code == 200
        assert providers.sources.step()
        result = client.get(endpoint).json()
        assert result["jobs"][0]["status"] == "completed", result
        candidate = result["items"][0]
        assert candidate["normalized"]["lines"][0]["words"][1]["start_ms"] == 1500
        assert candidate["normalized"]["lines"][0]["translation"] == "Synthetic translation"
        editor = client.get(f"/api/v1/manage/tracks/{track['id']}/lyrics").json()
        choice = {
            "version": editor["version"],
            "file_version": editor["file_version"],
            "offset_ms": 250,
        }
        applied = client.post(
            f"/api/v1/manage/lyric-candidates/{candidate['id']}/apply", headers=HEADERS, json=choice
        )
        assert applied.status_code == 200, applied.text
        playing = client.get(f"/api/v1/tracks/{track['id']}/lyrics").json()
        assert playing["source"] == "fixture-source" and playing["offset_ms"] == 250
        assert playing["lines"][0]["words"][1]["start_ms"] == 1750
        assert playing["lines"][0]["translation"] == "Synthetic translation"
        # Saving unchanged text must not wipe out the active candidate
        editor_after = client.get(f"/api/v1/manage/tracks/{track['id']}/lyrics").json()
        saved = client.put(
            f"/api/v1/manage/tracks/{track['id']}/lyrics",
            headers=HEADERS,
            json={
                "version": editor_after["version"],
                "file_version": editor_after["file_version"],
                "text": editor_after["text"],
            },
        )
        assert saved.status_code == 200
        playing_after = client.get(f"/api/v1/tracks/{track['id']}/lyrics").json()
        assert playing_after["source"] == "fixture-source"
        assert len(playing_after["lines"][0]["words"]) > 0

        # After version advances due to custom text edit, old candidate can still be re-applied
        saved_custom = client.put(
            f"/api/v1/manage/tracks/{track['id']}/lyrics",
            headers=HEADERS,
            json={
                "version": saved.json()["version"],
                "file_version": saved.json()["file_version"],
                "text": "[00:01.000] Custom manual override line",
            },
        )
        assert saved_custom.status_code == 200
        reapplied = client.post(
            f"/api/v1/manage/lyric-candidates/{candidate['id']}/apply",
            headers=HEADERS,
            json=choice,
        )
        assert reapplied.status_code == 200
        playing_restored = client.get(f"/api/v1/tracks/{track['id']}/lyrics").json()
        assert playing_restored["source"] == "fixture-source"
        assert playing_restored["lines"][0]["translation"] == "Synthetic translation"

        deletion_response = client.delete(BASE + "/fixture-source?version=2", headers=HEADERS)
        assert deletion_response.status_code == 409
        assert (
            client.put(
                BASE + "/fixture-source", headers=HEADERS, json={"version": 2, "enabled": False}
            ).status_code
            == 200
        )
        deletion_response = client.delete(BASE + "/fixture-source?version=3", headers=HEADERS)
        assert deletion_response.status_code == 200
        assert client.get(BASE).json()["items"] == []


def test_upgrade_cannot_replace_different_identity(settings, authenticated_client, monkeypatch):
    monkeypatch.setattr(Providers, "start", lambda self: None)
    with authenticated_client(settings) as client:
        imported = client.post(BASE + "/import", headers=HEADERS, content=package()).json()
        response = client.post(
            BASE + "/import?expected_id=wrong-plugin&expected_version=1",
            headers=HEADERS,
            content=package(),
        )
        assert (
            response.status_code == 409
            and response.json()["detail"] == "source_plugin_identity_conflict"
        )
        replacement = client.post(
            BASE + "/import?expected_id=fixture-source&expected_version=1",
            headers=HEADERS,
            content=package(manifest=MANIFEST | {"version": "1.1.0"}),
        )
        assert replacement.status_code == 200
        assert replacement.json()["version"] == imported["version"] + 1
        assert replacement.json()["plugin_version"] == "1.1.0"
        assert replacement.json()["enabled"] is False
