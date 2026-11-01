"""Importable ZIPs exercise the real worker boundary with synthetic music only."""

import io
import json
import os
from importlib.machinery import EXTENSION_SUFFIXES
from pathlib import Path
from zipfile import ZipFile

import pytest
from fastapi import HTTPException
from test_personal_library import music
from test_providers import HEADERS

from wildstring.library.scanner import scan_library
from wildstring.plugin_archives import inspect_package
from wildstring.providers import Providers
from wildstring.source_plugins import InstalledPlugin, Manifest

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


@pytest.mark.parametrize("folder", [".", "lib"])
@pytest.mark.parametrize("suffix", [".py", "/__init__.py", *EXTENSION_SUFFIXES])
def test_packaged_dependencies_are_found_without_importing(tmp_path, folder, suffix):
    dependency = tmp_path / folder / ("fixture_core" + suffix)
    dependency.parent.mkdir(parents=True, exist_ok=True)
    # Invalid native bytes and raising Python source prove discovery does not execute them.
    dependency.write_bytes(b"raise RuntimeError('must only execute in the worker')")
    installed = InstalledPlugin(
        Manifest(**MANIFEST, requires_modules=["fixture_core"]), tmp_path, "fixture"
    )
    assert installed.available()


def test_incompatible_binary_suffix_does_not_report_available(tmp_path):
    (tmp_path / "fixture_core.cpython-399-unknown.so").write_bytes(b"incompatible")
    installed = InstalledPlugin(
        Manifest(**MANIFEST, requires_modules=["fixture_core"]), tmp_path, "fixture"
    )
    assert not installed.available()


def test_manual_plugin_installation_survives_restart_without_default_plugins(
    settings, authenticated_client
):
    source_zip = package()
    with authenticated_client(settings) as client:
        assert client.get(BASE).json()["items"] == []
        imported = client.post(BASE + "/import", headers=HEADERS, content=source_zip)
        assert imported.status_code == 200
        saved = client.put(
            BASE + "/fixture-source",
            headers=HEADERS,
            json={
                "version": 1,
                "enabled": True,
                "config": {"cookie": "synthetic-preserved-secret"},
            },
        )
        assert saved.status_code == 200
        before = saved.json()
    with authenticated_client(settings) as client:
        items = client.get(BASE).json()["items"]
        assert len(items) == 1
        assert items[0]["id"] == "fixture-source"
        assert items[0]["enabled"] is True and items[0]["version"] == before["version"]
        assert items[0]["configured_secrets"] == ["cookie"]
        assert client.get(BASE + "/fixture-source/export").content == source_zip
        assert client.post(BASE + "/fixture-source/test", headers=HEADERS).json()["ok"] is True


@pytest.mark.skipif(
    not os.environ.get("WILDSTRING_NATIVE_PLUGIN_DIR"),
    reason="Run make test-native-plugin to compile the fixture",
)
def test_native_module_zip_worker_and_upgrade(settings, authenticated_client, monkeypatch):
    from wildstring.music_sources import PluginContext

    monkeypatch.setattr(Providers, "start", lambda self: None)
    directory = Path(os.environ["WILDSTRING_NATIVE_PLUGIN_DIR"])
    binary = next(
        directory / ("native_core" + suffix)
        for suffix in EXTENSION_SUFFIXES
        if (directory / ("native_core" + suffix)).is_file()
    )
    with authenticated_client(settings) as client:
        for revision in (1, 2):
            output = io.BytesIO()
            with ZipFile(output, "w") as archive:
                archive.writestr(
                    "manifest.json",
                    json.dumps(
                        MANIFEST
                        | {"version": f"{revision}.0.0", "requires_modules": ["native_core"]}
                    ),
                )
                archive.writestr(
                    "adapter.py",
                    f"from native_core import Plugin as Core\nclass Plugin(Core):\n    revision = {revision}\n",
                )
                archive.write(binary, "lib/" + binary.name)
            url = (
                BASE
                + "/import"
                + ("?expected_id=fixture-source&expected_version=2" if revision == 2 else "")
            )
            imported = client.post(url, headers=HEADERS, content=output.getvalue())
            assert imported.status_code == 200, imported.text
            assert imported.json()["available"] is True
            assert imported.json()["enabled"] is False
            version = imported.json()["version"]
            enabled = client.put(
                BASE + "/fixture-source",
                headers=HEADERS,
                json={"version": version, "enabled": True},
            )
            assert enabled.status_code == 200
            assert client.post(BASE + "/fixture-source/test", headers=HEADERS).json() == {
                "ok": True,
                "count": 1,
            }
            manager = client.app.state.providers.sources
            plugin = manager.plugins["fixture-source"]
            context = PluginContext(manager, "fixture-source", manager.settings("fixture-source"))
            assert (
                plugin.metadata(context, {"id": "native-song"})["fields"]["title"]
                == "Compiled fixture"
            )
            assert (
                plugin.lyrics(context, {"id": "native-song"})["original"]
                == "[00:01]Compiled fixture"
            )
            assert client.get(BASE + "/fixture-source/export").content == output.getvalue()


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
