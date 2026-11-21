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
    "api_version": 2,
    "license": "GPL-3.0-only",
    "upstream": "https://example.com/fixture",
    "request_pacing": True,
    "settings": [{"key": "cookie", "type": "secret", "label": "Cookie"}],
}
ADAPTER = """
class Plugin:
    def search(self, context, query):
        return [{"id": "synthetic-song", "title": "摇滚", "artists": ["合成乐队"], "duration_ms": 12000, "source_url": "https://example.com/song"}]
    def metadata(self, context, request):
        return [{"id": candidate["id"], "release_id": "synthetic-release", "title": "摇滚", "artists": ["合成乐队"], "duration_ms": 12000, "fields": {"title": "摇滚", "artists": ["合成乐队"], "album": "录音室专辑"}, "source_url": "https://example.com/release?edition=studio"} for candidate in request["candidates"]]
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
                plugin.metadata(
                    context, {"candidates": [{"id": "native-song"}], "include_release": True}
                )[0]["fields"]["title"]
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
        packages_dir = settings.data_dir / "providers" / "source-plugins"
        assert len(list(packages_dir.iterdir())) == 1
        deleted = client.delete(BASE + "/fixture-source?version=2", headers=HEADERS)
        assert deleted.status_code == 200
        assert list(packages_dir.iterdir()) == []


def test_zip_rejects_unsupported_compression_and_rate_closes_connections(tmp_path):
    import sqlite3
    from zipfile import ZIP_BZIP2

    from wildstring.database import Database
    from wildstring.plugin_rate import cooldown, permit

    buf = io.BytesIO()
    with ZipFile(buf, "w", compression=ZIP_BZIP2) as archive:
        archive.writestr("manifest.json", json.dumps(MANIFEST))
        archive.writestr("adapter.py", ADAPTER)
    with pytest.raises(HTTPException) as exc:
        inspect_package(buf.getvalue())
    assert exc.value.detail == "source_plugin_invalid_zip"

    db = Database(tmp_path)
    db.initialize()
    rate_cfg = {
        "database": str(db.path),
        "plugin_id": "fixture-source",
        "interval_seconds": 0.01,
        "batch_id": None,
    }
    closed = 0
    real_connect = sqlite3.connect

    class TrackedConnection(sqlite3.Connection):
        def close(self):
            nonlocal closed
            closed += 1
            super().close()

    def tracked_connect(*args, **kwargs):
        kwargs["factory"] = TrackedConnection
        return real_connect(*args, **kwargs)

    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(sqlite3, "connect", tracked_connect)
        assert permit(rate_cfg) == 0
        cooldown(rate_cfg, 1)
    assert closed == 2


def test_upgrade_retires_v1_plugin_and_preserves_library_evidence(
    settings, authenticated_client, monkeypatch
):
    # Keep startup and the worker lock real, but leave synthetic pending work untouched.
    def idle_worker(providers):
        try:
            providers.exit.wait()
        finally:
            providers.worker_lock.release()

    monkeypatch.setattr(Providers, "run", idle_worker)
    music(settings, "摇滚.flac", ["合成乐队"], ["合成乐队"])
    scan_library(settings)
    second_manifest = MANIFEST | {"id": "other-source"}
    with authenticated_client(settings) as client:
        for identity, source_zip in (
            ("fixture-source", package()),
            ("other-source", package(manifest=second_manifest)),
        ):
            assert (
                client.post(BASE + "/import", headers=HEADERS, content=source_zip).status_code
                == 200
            )
            saved = client.put(
                BASE + "/" + identity,
                headers=HEADERS,
                json={"version": 1, "enabled": True, "config": {"cookie": identity + "-secret"}},
            )
            assert saved.status_code == 200
        providers = client.app.state.providers
        track = client.get("/api/v1/tracks").json()["items"][0]
        endpoint = f"/api/v1/manage/tracks/{track['id']}/online-lyrics"
        assert client.post(endpoint, headers=HEADERS).status_code == 200
        assert providers.sources.step()
        candidate = next(
            item
            for item in client.get(endpoint).json()["items"]
            if item["plugin_id"] == "fixture-source"
        )
        editor = client.get(f"/api/v1/manage/tracks/{track['id']}/lyrics").json()
        assert (
            client.post(
                f"/api/v1/manage/lyric-candidates/{candidate['id']}/apply",
                headers=HEADERS,
                json={"version": editor["version"], "file_version": editor["file_version"]},
            ).status_code
            == 200
        )
        before_lyrics = client.get(f"/api/v1/tracks/{track['id']}/lyrics").json()
        providers.secrets({"acoustid_api_key": "unrelated-secret"})
        db = providers.database
        with db.connect(write=True) as connection:
            old = connection.execute(
                "SELECT sha256,manifest FROM source_plugin_packages WHERE plugin_id='fixture-source'"
            ).fetchone()
            old_digest = old["sha256"]
            connection.execute(
                "UPDATE source_plugin_packages SET manifest=? WHERE plugin_id='fixture-source'",
                (json.dumps(json.loads(old["manifest"]) | {"api_version": 1}),),
            )
            connection.execute(
                "INSERT INTO plugin_request_gates(plugin_id,cooldown_until,reason) VALUES (?,?,?)",
                ("fixture-source", 9999999999, "source_plugin_rate_limited"),
            )
            connection.execute(
                "INSERT INTO provider_cache VALUES (?,?,?,?)",
                ("plugin:fixture-source", "cached", "{}", 9999999999),
            )
            library_id = connection.execute(
                "SELECT library_id FROM tracks WHERE id=?", (track["id"],)
            ).fetchone()[0]
            options = json.dumps({"providers": [{"id": "fixture-source"}]})
            connection.execute(
                "INSERT INTO lyric_scan_batches VALUES (?,?,?,'running',1,1,1)",
                ("old-batch", library_id, options),
            )
            connection.execute(
                "INSERT INTO lyric_lookup_jobs VALUES (?,?,'queued',NULL,'[]',1,1)",
                ("old-batch-job", track["id"]),
            )
            connection.execute(
                "INSERT INTO lyric_scan_items(id,batch_id,track_id,title,status,job_id,updated_at) VALUES (?,?,?,?,'queued',?,1)",
                ("old-item", "old-batch", track["id"], track["title"], "old-batch-job"),
            )
        old_package = providers.directory / "source-plugins" / old_digest
        old_state = providers.directory / "plugin-state" / "fixture-source"
        old_state.mkdir(parents=True, exist_ok=True)
        (old_state / "synthetic-state").write_text("old")
        assert old_package.exists()

    with authenticated_client(settings) as client:
        providers = client.app.state.providers
        assert [item["id"] for item in client.get(BASE).json()["items"]] == ["other-source"]
        assert not old_package.exists() and not old_state.exists()
        secrets = providers.secrets()
        assert "source:fixture-source:cookie" not in secrets
        assert secrets["source:other-source:cookie"] == "other-source-secret"
        assert secrets["acoustid_api_key"] == "unrelated-secret"
        assert client.get(f"/api/v1/tracks/{track['id']}/lyrics").json() == before_lyrics
        with providers.database.connect() as connection:
            assert (
                connection.execute(
                    "SELECT 1 FROM source_plugin_settings WHERE plugin_id='fixture-source'"
                ).fetchone()
                is None
            )
            assert (
                connection.execute(
                    "SELECT 1 FROM provider_cache WHERE provider='plugin:fixture-source'"
                ).fetchone()
                is None
            )
            assert (
                connection.execute(
                    "SELECT cooldown_until FROM plugin_request_gates WHERE plugin_id='fixture-source'"
                ).fetchone()[0]
                == 9999999999
            )
            assert (
                connection.execute(
                    "SELECT status FROM lyric_scan_batches WHERE id='old-batch'"
                ).fetchone()[0]
                == "cancelled"
            )
            item = connection.execute(
                "SELECT status,error FROM lyric_scan_items WHERE id='old-item'"
            ).fetchone()
            assert tuple(item) == ("cancelled", "source_plugin_incompatible_api")
            assert (
                connection.execute(
                    "SELECT status FROM lyric_lookup_jobs WHERE id='old-batch-job'"
                ).fetchone()[0]
                == "cancelled"
            )
            assert connection.execute(
                "SELECT 1 FROM lyric_candidates WHERE id=?", (candidate["id"],)
            ).fetchone()
        assert client.post(BASE + "/import", headers=HEADERS, content=package()).status_code == 200
        assert (
            client.put(
                BASE + "/fixture-source",
                headers=HEADERS,
                json={"version": 1, "enabled": True, "config": {"cookie": "new-cookie"}},
            ).status_code
            == 200
        )
        with providers.database.connect(write=True) as connection:
            connection.execute(
                "UPDATE plugin_request_gates SET cooldown_until=0 WHERE plugin_id='fixture-source'"
            )
        assert client.post(BASE + "/fixture-source/test", headers=HEADERS).json()["ok"] is True
        lookup = client.post(endpoint, headers=HEADERS).json()
        assert providers.sources.step()
        jobs = client.get(endpoint).json()["jobs"]
        assert next(job for job in jobs if job["id"] == lookup["id"])["status"] == "completed"
    with authenticated_client(settings) as client:
        assert client.app.state.providers.secrets()["source:fixture-source:cookie"] == "new-cookie"
        assert {item["id"] for item in client.get(BASE).json()["items"]} == {
            "fixture-source",
            "other-source",
        }
        assert client.get(f"/api/v1/tracks/{track['id']}/lyrics").json() == before_lyrics


def test_manual_lyric_job_survives_pending_batch_and_newer_batch_history(
    settings, authenticated_client, monkeypatch
):
    monkeypatch.setattr(Providers, "start", lambda self: None)
    music(settings, "摇滚.flac", ["合成乐队"], ["合成乐队"])
    scan_library(settings)
    with authenticated_client(settings) as client:
        assert client.post(BASE + "/import", headers=HEADERS, content=package()).status_code == 200
        assert (
            client.put(
                BASE + "/fixture-source", headers=HEADERS, json={"version": 1, "enabled": True}
            ).status_code
            == 200
        )
        providers = client.app.state.providers
        track = client.get("/api/v1/tracks").json()["items"][0]
        endpoint = f"/api/v1/manage/tracks/{track['id']}/online-lyrics"
        # Keep an existing, usable candidate associated with a completed batch lookup.
        assert client.post(endpoint, headers=HEADERS).status_code == 200
        assert providers.sources.step()
        existing = client.get(endpoint).json()["items"][0]
        with providers.database.connect(write=True) as connection:
            library_id = connection.execute(
                "SELECT library_id FROM tracks WHERE id=?", (track["id"],)
            ).fetchone()[0]
            for index in range(6):
                batch_id, job_id = f"batch-{index}", f"batch-job-{index}"
                status = "queued" if index == 5 else "completed"
                connection.execute(
                    "INSERT INTO lyric_scan_batches VALUES (?,?,?,'running',1,?,?)",
                    (batch_id, library_id, '{"providers": []}', index + 10, index + 10),
                )
                connection.execute(
                    "INSERT INTO lyric_lookup_jobs VALUES (?,?,?,NULL,'[]',?,?)",
                    (job_id, track["id"], status, index + 10, index + 10),
                )
                connection.execute(
                    "INSERT INTO lyric_scan_items(id,batch_id,track_id,title,status,job_id,updated_at) VALUES (?,?,?,?,?,?,?)",
                    (
                        f"item-{index}",
                        batch_id,
                        track["id"],
                        track["title"],
                        status,
                        job_id,
                        index + 10,
                    ),
                )
        response = client.post(endpoint, headers=HEADERS)
        assert response.status_code == 200, response.text
        manual_job = response.json()["id"]
        with providers.database.connect(write=True) as connection:
            # All six batch jobs are newer than the pending manual job.
            connection.execute(
                "UPDATE lyric_lookup_jobs SET created_at=1 WHERE id=?", (manual_job,)
            )
            connection.execute(
                "UPDATE lyric_lookup_jobs SET created_at=0 WHERE id=?", (existing["job_id"],)
            )
        result = client.get(endpoint).json()
        assert [job["id"] for job in result["jobs"]] == [manual_job, existing["job_id"]]
        assert result["jobs"][0]["status"] == "queued"
        assert existing["id"] in [item["id"] for item in result["items"]]
        assert client.post(endpoint, headers=HEADERS).json()["id"] == manual_job


@pytest.mark.parametrize("needs_details", [False, True])
def test_lyric_candidates_skip_invalid_rows_and_prefer_accepted_versions(
    monkeypatch, needs_details
):
    from types import SimpleNamespace

    from wildstring.music_sources import MusicSources

    track = {"title": "稻香", "artists": ["周杰伦"], "duration_ms": 223000}
    studio = track | {"id": "studio", "source_url": "https://example.com/studio"}
    live = studio | {"id": "live", "title": "稻香 (Live)", "source_url": "https://example.com/live"}
    summary = studio | {"duration_ms": None} if needs_details else studio
    detail_requests = []

    def metadata(_context, request):
        detail_requests.append(request)
        return [
            item | {"fields": {"title": item["title"], "artists": item["artists"]}}
            for item in (live, studio)
        ]

    plugin = SimpleNamespace(
        search=lambda *_: [{"id": "invalid", "source_url": []}, summary, live],
        metadata=metadata,
    )
    service = MusicSources(SimpleNamespace(database=None, directory=Path(".")))
    monkeypatch.setattr(service, "settings", lambda _identity: {})
    monkeypatch.setattr(MusicSources, "plugins", property(lambda _self: {"fixture-source": plugin}))
    candidates, _context = service.candidates(track, "fixture-source", include_release=False)
    assert [candidate["id"] for candidate in candidates] == ["studio"]
    assert detail_requests == (
        [{"candidates": [summary, live], "include_release": False}] if needs_details else []
    )
