"""Real ZIP workers, durable coverage, confirmed upgrades and source gates."""

import io
import json
import shutil
import subprocess
import threading
import time
from pathlib import Path
from zipfile import ZipFile

import pytest
from mutagen.flac import FLAC
from test_personal_library import music
from test_providers import HEADERS
from test_source_plugins import MANIFEST

from wildstring.database import SCHEMA_VERSION, Database
from wildstring.library.repository import LibraryRepository
from wildstring.library.scanner import scan_library
from wildstring.lyric_quality import improves, quality, reaches
from wildstring.plugin_rate import permit
from wildstring.providers import Providers
from wildstring.source_plugins import PluginError

BASE = "/api/v1/manage/lyric-scans"


def test_stop_during_worker_start_finishes_without_leaking_a_thread(tmp_path, monkeypatch):
    database = Database(tmp_path)
    database.initialize()
    providers = Providers(LibraryRepository(database, tmp_path / "library"))
    scans = providers.sources.scans
    thread_type = threading.Thread
    starting, release, stopping = threading.Event(), threading.Event(), threading.Event()
    failures = []

    class SlowStart(thread_type):
        def start(self):
            starting.set()
            assert release.wait(2)
            super().start()

    monkeypatch.setattr(threading, "Thread", SlowStart)

    def start():
        try:
            scans.start()
        except Exception as error:
            failures.append(error)

    def stop():
        stopping.set()
        try:
            providers.stop()
        except Exception as error:
            failures.append(error)

    starter, stopper = thread_type(target=start), thread_type(target=stop)
    starter.start()
    try:
        assert starting.wait(2)
        stopper.start()
        assert stopping.wait(2)
        stopper.join(timeout=0.05)
    finally:
        release.set()
        starter.join(timeout=3)
        if stopper.ident is not None:
            stopper.join(timeout=3)
        scans.stop()
    assert not failures
    assert not starter.is_alive() and not stopper.is_alive()
    assert scans.exit.is_set() and not scans.thread.is_alive()


def test_late_worker_start_after_provider_stop_does_not_restart_it(tmp_path):
    database = Database(tmp_path)
    database.initialize()
    providers = Providers(LibraryRepository(database, tmp_path / "library"))
    providers.stop()
    scans = providers.sources.scans
    try:
        scans.start()
        assert scans.thread is None
        assert scans.exit.is_set()
    finally:
        scans.stop()


def setup(settings, client):
    track = client.get("/api/v1/tracks").json()["items"][0]
    adapter = f"""
import json
class Plugin:
    def search(self, context, query):
        counter = context.directory / "requests.json"
        count = json.loads(counter.read_text()) if counter.exists() else 0
        counter.write_text(json.dumps(count + 1))
        return [{{"id":"song", "title":{track["title"]!r}, "artists":{track["artists"]!r}, "duration_ms":{track["duration_ms"]}, "source_url":"https://example.com/song"}}]
    def metadata(self, context, request):
        (context.directory / "details-requested").touch()
        return [{{"id":"song", "title":{track["title"]!r}, "artists":{track["artists"]!r}, "duration_ms":{track["duration_ms"]}, "fields":{{"title":{track["title"]!r},"artists":{track["artists"]!r}}}, "source_url":"https://example.com/song"}}]
    def lyrics(self, context, candidate):
        return {{"original":"synthetic", "normalized":{{"kind":"synced", "format":"krc", "lines":[{{"time_ms":1000,"text":"Synthetic","words":[{{"start_ms":1000,"end_ms":2000,"text":"Synthetic"}}]}}],"layers":{{"translation":[{{"time_ms":1000,"text":"合成译文"}}]}}}}}}
"""
    output = io.BytesIO()
    with ZipFile(output, "w") as archive:
        archive.writestr("manifest.json", json.dumps(MANIFEST))
        archive.writestr("adapter.py", adapter)
    plugins = "/api/v1/manage/source-plugins"
    assert (
        client.post(plugins + "/import", headers=HEADERS, content=output.getvalue()).status_code
        == 200
    )
    assert (
        client.put(
            plugins + "/fixture-source", headers=HEADERS, json={"version": 1, "enabled": True}
        ).status_code
        == 200
    )
    return track, client.app.state.providers.sources.scans


def finish(client, scans, identity):
    for _ in range(10):
        scans.step()
        result = client.get(BASE + "/" + identity).json()
        if result["status"] == "completed":
            return result
    raise AssertionError(str(result))


def prepare(settings, monkeypatch):
    monkeypatch.setattr(Providers, "start", lambda self: None)
    path = music(settings, "合成.flac", ["合成艺人"], ["合成艺人"])
    tags = FLAC(path)
    for key in list(tags):
        if "lyric" in key.lower():
            del tags[key]
    tags.save()
    scan_library(settings)


def test_scan_coverage_force_scope_and_confirmation_restore(
    settings, authenticated_client, monkeypatch
):
    prepare(settings, monkeypatch)
    with authenticated_client(settings) as client:
        track, scans = setup(settings, client)
        body = {"scope": "album", "scope_id": track["album_id"]}
        assert client.post(BASE, json=body).status_code == 403
        assert client.post(BASE + "/preview", headers=HEADERS, json=body).json()["total"] == 1
        first = client.post(BASE, headers=HEADERS, json=body).json()
        result = finish(client, scans, first["id"])
        assert result["counts"] == {"ready": 1}, result
        assert client.get(f"/api/v1/tracks/{track['id']}/lyrics").json()["kind"] == "none"
        assert result["items"][0]["quality"]["level"] == 5
        assert not (
            scans.sources.providers.directory / "plugin-state/fixture-source/details-requested"
        ).exists()
        second = client.post(BASE, headers=HEADERS, json=body).json()
        repeated = finish(client, scans, second["id"])
        assert repeated["counts"] == {"ready": 1}
        counter = scans.sources.providers.directory / "plugin-state/fixture-source/requests.json"
        assert json.loads(counter.read_text()) == 1
        forced = client.post(BASE, headers=HEADERS, json=body | {"force": True}).json()
        finish(client, scans, forced["id"])
        assert json.loads(counter.read_text()) == 2
        item = result["items"][0]
        applied = client.post(
            BASE + f"/{first['id']}/apply", headers=HEADERS, json={"item_ids": [item["id"]]}
        ).json()
        assert applied["items"][0]["status"] == "applied", applied
        playing = client.get(f"/api/v1/tracks/{track['id']}/lyrics").json()
        assert playing["lines"][0]["translation"] == "合成译文"
        duplicate = client.post(
            BASE + f"/{first['id']}/apply", headers=HEADERS, json={"item_ids": [item["id"]]}
        ).json()
        assert duplicate["items"][0]["status"] == "conflict"
        restored = client.post(
            f"/api/v1/manage/lyric-scan-items/{item['id']}/restore", headers=HEADERS
        )
        assert restored.status_code == 200, restored.text
        assert client.get(f"/api/v1/tracks/{track['id']}/lyrics").json()["kind"] == "none"


def test_pause_cancel_locked_and_changed_lyrics_are_protected(
    settings, authenticated_client, monkeypatch
):
    prepare(settings, monkeypatch)
    with authenticated_client(settings) as client:
        track, scans = setup(settings, client)
        batch = client.post(BASE, headers=HEADERS, json={}).json()
        control = BASE + f"/{batch['id']}/control"
        assert (
            client.post(control, headers=HEADERS, json={"action": "pause"}).json()["status"]
            == "paused"
        )
        assert scans.step() is False
        assert (
            client.post(control, headers=HEADERS, json={"action": "resume"}).json()["status"]
            == "running"
        )
        result = finish(client, scans, batch["id"])
        lock_url = f"/api/v1/manage/tracks/{track['id']}/lyric-lock"
        lock = client.get(lock_url).json()
        assert (
            client.put(lock_url, headers=HEADERS, json=lock | {"locked": True}).status_code == 200
        )
        applied = client.post(
            BASE + f"/{batch['id']}/apply",
            headers=HEADERS,
            json={"item_ids": [result["items"][0]["id"]]},
        ).json()
        assert applied["items"][0]["error"] == "lyrics_locked"
        forced = client.post(BASE, headers=HEADERS, json={"force": True}).json()
        assert finish(client, scans, forced["id"])["counts"] == {"locked": 1}
        cancelled = client.post(BASE, headers=HEADERS, json={}).json()
        assert client.post(
            BASE + f"/{cancelled['id']}/control", headers=HEADERS, json={"action": "cancel"}
        ).json()["counts"] == {"cancelled": 1}


def test_source_gate_no_burst_pause_and_cooldown(settings, authenticated_client, monkeypatch):
    prepare(settings, monkeypatch)
    with authenticated_client(settings) as client:
        _, scans = setup(settings, client)
        batch = client.post(BASE, headers=HEADERS, json={}).json()
        policy = {
            "database": str(scans.database.path),
            "plugin_id": "fixture-source",
            "interval_seconds": 5,
            "batch_id": batch["id"],
        }
        assert permit(policy, clock=100) == 0
        assert permit(policy, clock=100) > 0
        assert permit(policy, clock=104.99) > 0
        assert permit(policy, clock=105) == 0
        assert permit(policy | {"interval_seconds": 20}, clock=110) > 0
        assert permit(policy | {"interval_seconds": 20}, clock=125) == 0
        client.post(BASE + f"/{batch['id']}/control", headers=HEADERS, json={"action": "pause"})
        with pytest.raises(PluginError, match="lyric_scan_paused"):
            permit(policy, clock=110)
        policy.pop("batch_id")
        with scans.database.connect(write=True) as db:
            db.execute(
                "UPDATE plugin_request_gates SET cooldown_until=?,reason='source_plugin_rate_limited'",
                (time.time() + 900,),
            )
        with pytest.raises(PluginError, match="source_plugin_rate_limited"):
            permit(policy)


def test_quality_uses_actual_coverage_and_never_loses_existing_capabilities():
    plain = quality(
        {"kind": "plain", "lines": [{"text": "synthetic", "time_ms": None}], "format": "krc"}
    )
    assert plain["level"] == 1
    words = quality(
        {
            "kind": "synced",
            "lines": [
                {
                    "text": "synthetic",
                    "time_ms": 1,
                    "words": [{"text": "synthetic", "start_ms": 1, "end_ms": 2}],
                }
            ],
        }
    )
    dual_line = quality(
        {
            "kind": "synced",
            "lines": [{"text": "synthetic", "time_ms": 1}],
            "layers": {"translation": [{"text": "合成", "time_ms": 1}]},
        }
    )
    assert words["level"] == 4 and dual_line["level"] == 3
    assert not improves(words, dual_line, "bilingual")
    assert not improves(dual_line, words)
    assert not reaches(words, 5) and reaches(words, 4)


def test_schema20_upgrade_keeps_existing_library(settings):
    from migration_support import pre21

    db = Database(settings.data_dir)
    db.initialize()
    with db.connect(write=True) as connection:
        pre21(connection)
        connection.execute("PRAGMA user_version=20")
        before = connection.execute("SELECT count(*) FROM users").fetchone()[0]
    db.initialize()
    with db.connect() as connection:
        assert connection.execute("PRAGMA user_version").fetchone()[0] == SCHEMA_VERSION
        assert connection.execute("SELECT count(*) FROM users").fetchone()[0] == before


def test_rate_profiles_are_persistent_and_custom_is_per_task(
    settings, authenticated_client, monkeypatch
):
    prepare(settings, monkeypatch)
    with authenticated_client(settings) as client:
        _, _scans = setup(settings, client)
        url = "/api/v1/manage/lyric-scan-settings"
        default = client.get(url).json()
        assert default["default_profile"] == "low" and default["low_seconds"] == 10
        updated = default | {"low_seconds": 30, "medium_seconds": 10, "high_seconds": 3}
        assert client.put(url, headers=HEADERS, json=updated).status_code == 200
        assert client.put(url, headers=HEADERS, json=updated).status_code == 409
        assert client.get(url).json()["low_seconds"] == 30
        assert (
            client.post(BASE, headers=HEADERS, json={}).json()["options"]["interval_seconds"] == 30
        )
        assert (
            client.post(BASE, headers=HEADERS, json={"rate_profile": "high"}).json()["options"][
                "interval_seconds"
            ]
            == 3
        )
        custom = client.post(
            BASE, headers=HEADERS, json={"rate_profile": "custom", "interval_seconds": 120}
        ).json()
        assert custom["options"]["interval_seconds"] == 120
        invalid = client.get(url).json() | {"low_seconds": 1, "high_seconds": 10}
        assert client.put(url, headers=HEADERS, json=invalid).status_code == 422


def test_no_match_is_covered_but_network_failure_is_retryable(
    settings, authenticated_client, monkeypatch
):
    prepare(settings, monkeypatch)
    with authenticated_client(settings) as client:
        _, scans = setup(settings, client)
        original = scans.sources.candidates
        monkeypatch.setattr(scans.sources, "candidates", lambda *args, **kwargs: ([], None))
        empty = client.post(BASE, headers=HEADERS, json={}).json()
        assert finish(client, scans, empty["id"])["counts"] == {"no_match": 1}
        repeat = client.post(BASE, headers=HEADERS, json={}).json()
        assert finish(client, scans, repeat["id"])["counts"] == {"skipped_scanned": 1}

        def timeout(*args, **kwargs):
            raise PluginError("source_plugin_timeout")

        monkeypatch.setattr(scans.sources, "candidates", timeout)
        failed = client.post(BASE, headers=HEADERS, json={"force": True}).json()
        scans.step()
        pending = client.get(BASE + "/" + failed["id"]).json()["items"][0]
        assert pending["status"] == "queued" and pending["attempts"] == 1
        assert pending["next_at"] > time.time() + 20
        for _ in range(3):
            with scans.database.connect(write=True) as db:
                db.execute(
                    "UPDATE lyric_scan_items SET next_at=0 WHERE batch_id=?", (failed["id"],)
                )
            scans.step()
        assert client.get(BASE + "/" + failed["id"]).json()["counts"] == {"failed": 1}
        monkeypatch.setattr(scans.sources, "candidates", original)
        client.post(
            BASE + f"/{failed['id']}/control", headers=HEADERS, json={"action": "retry_failed"}
        )
        assert finish(client, scans, failed["id"])["counts"] == {"ready": 1}


def test_paused_work_survives_manager_recreation(settings, authenticated_client, monkeypatch):
    from wildstring.lyric_scans import LyricScans

    prepare(settings, monkeypatch)
    with authenticated_client(settings) as client:
        _, scans = setup(settings, client)
        batch = client.post(BASE, headers=HEADERS, json={}).json()
        client.post(BASE + f"/{batch['id']}/control", headers=HEADERS, json={"action": "pause"})
        replacement = LyricScans(scans.sources)
        assert replacement.step() is False
        replacement.control(batch["id"], "resume")
        assert finish(client, replacement, batch["id"])["counts"] == {"ready": 1}


def test_node_physical_requests_share_gate_and_are_serial(
    settings, authenticated_client, monkeypatch
):
    import sys

    node = shutil.which("node")
    if not node:
        pytest.skip("Node runtime required for bundled community adapters")
    prepare(settings, monkeypatch)
    with authenticated_client(settings) as client:
        _, scans = setup(settings, client)
        script = """
const {paced}=require(process.argv[1]);const data=JSON.parse(process.argv[2]);
let active=0,max=0;const starts=[];
const send=paced(data,async()=>{active++;max=Math.max(max,active);starts.push(Date.now());await new Promise(r=>setTimeout(r,50));active--;});
Promise.all([send(),send()]).then(()=>console.log(JSON.stringify({max,starts})));
"""
        value = {
            "rate": {
                "database": str(scans.database.path),
                "plugin_id": "fixture-source",
                "interval_seconds": 1,
            },
            "rate_command": [sys.executable, "-I", "-m", "wildstring.plugin_rate"],
        }
        result = subprocess.run(
            [
                node,
                "-e",
                script,
                str(Path(__file__).resolve().parents[2] / "plugins/node-runtime/rate.cjs"),
                json.dumps(value),
            ],
            check=True,
            capture_output=True,
            text=True,
            timeout=15,
        )
        proof = json.loads(result.stdout)
        assert proof["max"] == 1 and proof["starts"][1] - proof["starts"][0] >= 990


def test_metadata_change_after_scan_cannot_apply_old_candidate(
    settings, authenticated_client, monkeypatch
):
    prepare(settings, monkeypatch)
    with authenticated_client(settings) as client:
        track, scans = setup(settings, client)
        batch = client.post(BASE, headers=HEADERS, json={}).json()
        result = finish(client, scans, batch["id"])
        item = result["items"][0]
        with scans.database.connect(write=True) as db:
            db.execute(
                "UPDATE tracks SET title='Changed synthetic recording' WHERE id=?", (track["id"],)
            )
        response = client.post(
            BASE + f"/{batch['id']}/apply", headers=HEADERS, json={"item_ids": [item["id"]]}
        ).json()
        assert response["items"][0]["error"] == "lyrics_version_conflict"
        assert client.get("/api/v1/manage/tracks/not-found/lyric-lock").status_code == 404


def test_partial_source_failure_keeps_a_usable_upgrade(settings, authenticated_client, monkeypatch):
    from wildstring.source_plugins import InstalledPlugin

    prepare(settings, monkeypatch)
    with authenticated_client(settings) as client:
        _, scans = setup(settings, client)
        original = scans.sources.candidates

        def two_candidates(*args, **kwargs):
            values, context = original(*args, **kwargs)
            return values * 2, context

        calls = []

        def partially_available(self, context, candidate):
            calls.append(candidate)
            if len(calls) == 2:
                raise PluginError("source_plugin_timeout")
            return {
                "original": "synthetic",
                "normalized": {
                    "kind": "synced",
                    "format": "qrc",
                    "lines": [
                        {
                            "time_ms": 1000,
                            "text": "Synthetic",
                            "words": [{"text": "Synthetic", "start_ms": 1000, "end_ms": 2000}],
                        }
                    ],
                },
            }

        monkeypatch.setattr(scans.sources, "candidates", two_candidates)
        monkeypatch.setattr(InstalledPlugin, "lyrics", partially_available)
        batch = client.post(BASE, headers=HEADERS, json={}).json()
        result = finish(client, scans, batch["id"])
        assert result["counts"] == {"ready": 1}
        assert result["items"][0]["quality"]["level"] == 4
        assert result["items"][0]["error"] == "source_plugin_timeout"


@pytest.mark.parametrize("force", [False, True])
def test_partial_cooldown_keeps_candidate_and_retries_source(
    settings, authenticated_client, monkeypatch, force
):
    from wildstring.source_plugins import InstalledPlugin

    prepare(settings, monkeypatch)
    with authenticated_client(settings) as client:
        _, scans = setup(settings, client)
        original_candidates = scans.sources.candidates
        original_lyrics = InstalledPlugin.lyrics

        def two_candidates(*args, **kwargs):
            values, context = original_candidates(*args, **kwargs)
            return [values[0], values[0] | {"id": "other"}], context

        blocked = True
        calls = []

        def lyrics(plugin, context, candidate):
            calls.append(candidate["id"])
            value = original_lyrics(plugin, context, candidate)
            if candidate["id"] == "song":
                return value | {
                    "normalized": value["normalized"] | {"layers": {}},
                }
            if blocked:
                raise PluginError("source_plugin_rate_limited")
            return value

        monkeypatch.setattr(scans.sources, "candidates", two_candidates)
        monkeypatch.setattr(InstalledPlugin, "lyrics", lyrics)
        batch = client.post(BASE, headers=HEADERS, json={"force": force}).json()
        with scans.database.connect(write=True) as db:
            db.execute(
                "INSERT INTO plugin_request_gates(plugin_id,cooldown_until) VALUES (?,?)",
                ("fixture-source", time.time() + 120),
            )
        assert scans.step()
        row = client.get(f"{BASE}/{batch['id']}").json()["items"][0]
        assert row["status"] == "queued" and row["attempts"] == 0
        assert row["quality"]["level"] == 4 and row["results"] == {}
        first_candidate = row["candidate_id"]
        with scans.database.connect(write=True) as db:
            assert db.execute("SELECT count(*) FROM lyric_scan_coverage").fetchone()[0] == 0
            db.execute("UPDATE lyric_scan_items SET next_at=0 WHERE id=?", (row["id"],))
            db.execute("UPDATE plugin_request_gates SET cooldown_until=0")
            db.execute("DELETE FROM provider_cache")
        blocked = False
        assert finish(client, scans, batch["id"])["counts"] == {"ready": 1}
        with scans.database.connect() as db:
            assert db.execute(
                "SELECT 1 FROM lyric_candidates WHERE id=?", (first_candidate,)
            ).fetchone()
        assert calls == ["song", "other", "song", "other"]


def test_workers_claim_distinct_sources_and_tracks(settings, authenticated_client, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor

    prepare(settings, monkeypatch)
    with authenticated_client(settings) as client:
        track, scans = setup(settings, client)
        batch = client.post(BASE, headers=HEADERS, json={}).json()
        with scans.database.connect(write=True) as db:
            options = batch["options"]
            options["providers"].append({"id": "second-source"})
            db.execute(
                "UPDATE lyric_scan_batches SET options=? WHERE id=?",
                (json.dumps(options), batch["id"]),
            )
            original = db.execute(
                "SELECT * FROM lyric_scan_items WHERE batch_id=?", (batch["id"],)
            ).fetchone()
            db.execute(
                "INSERT INTO lyric_scan_items(id,batch_id,track_id,title,results,updated_at) "
                "VALUES (?,?,?,?,?,?)",
                (
                    "second-item",
                    batch["id"],
                    "second-track",
                    "Synthetic second track",
                    '{"fixture-source":{"status":"no_match","error":null}}',
                    original["updated_at"],
                ),
            )
        entered, release = threading.Event(), threading.Event()
        claimed = []

        def process(item, _options):
            claimed.append((item["track_id"], item["source"]))
            if item["track_id"] == track["id"]:
                entered.set()
                assert release.wait(5)
            with scans.database.connect(write=True) as db:
                db.execute(
                    "UPDATE lyric_scan_items SET status='no_match' WHERE id=?", (item["id"],)
                )

        monkeypatch.setattr(scans, "process", process)
        with ThreadPoolExecutor(max_workers=2) as pool:
            first = pool.submit(scans.step)
            try:
                assert entered.wait(5)
                assert pool.submit(scans.step).result(5)
                assert claimed == [
                    (track["id"], "fixture-source"),
                    ("second-track", "second-source"),
                ]
            finally:
                release.set()
            assert first.result(5)


def test_cooldown_releases_source_slot_for_other_tracks(
    settings, authenticated_client, monkeypatch
):
    from concurrent.futures import ThreadPoolExecutor

    prepare(settings, monkeypatch)
    music(settings, "第二首.flac", ["合成艺人"], ["合成艺人"])
    scan_library(settings)
    with authenticated_client(settings) as client:
        _, scans = setup(settings, client)
        batch = client.post(BASE, headers=HEADERS, json={}).json()
        options = batch["options"]
        options["providers"].extend([{"id": "source-b"}, {"id": "source-c"}])
        with scans.database.connect(write=True) as db:
            db.execute(
                "UPDATE lyric_scan_batches SET options=? WHERE id=?",
                (json.dumps(options), batch["id"]),
            )

        active_b = threading.Event()
        active_first_source = threading.Event()
        release_b = threading.Event()
        release_first_source = threading.Event()
        calls = []
        call_lock = threading.Lock()

        def process_provider(item, _track, _record, provider, _options):
            identity = provider["id"]
            with scans.claim_lock:
                assert item["source"] == identity
                assert identity in scans.active_sources
            with call_lock:
                calls.append((item["track_id"], identity))
            if identity == "fixture-source":
                with call_lock:
                    count = sum(source == identity for _, source in calls)
                if count == 2:
                    active_first_source.set()
                    assert release_first_source.wait(5)
                return time.time() + 120
            assert identity == "source-b"
            active_b.set()
            assert release_b.wait(5)
            scans.advance(item, identity, "no_match")
            return None

        monkeypatch.setattr(scans, "process_provider", process_provider)
        with ThreadPoolExecutor(max_workers=2) as pool:
            first = pool.submit(scans.step)
            try:
                assert active_b.wait(5)
                second = pool.submit(scans.step)
                assert active_first_source.wait(5)
                with scans.claim_lock:
                    assert scans.active_sources == {"fixture-source", "source-b"}
                release_first_source.set()
                assert second.result(5)
            finally:
                release_first_source.set()
                release_b.set()
            assert first.result(5)
        assert [identity for _, identity in calls].count("fixture-source") == 2
        assert [identity for _, identity in calls].count("source-b") == 1
        assert [identity for _, identity in calls].count("source-c") == 0
        with scans.database.connect() as db:
            rows = db.execute(
                "SELECT status, results, attempts, busy_deferrals FROM lyric_scan_items "
                "WHERE batch_id=?",
                (batch["id"],),
            ).fetchall()
        assert len(rows) == 2
        for row in rows:
            assert row["status"] == "queued"
            assert row["attempts"] == row["busy_deferrals"] == 0
            assert "fixture-source" not in json.loads(row["results"])


def test_lyric_scans_source_filtering_and_sources_endpoint(
    settings, authenticated_client, monkeypatch
):
    prepare(settings, monkeypatch)
    second_manifest = MANIFEST | {"id": "second-source", "name": "第二来源"}
    with authenticated_client(settings) as client:
        track, scans = setup(settings, client)
        adapter = f"""
class Plugin:
    def search(self, context, query):
        return [{{"id":"song", "title":{track["title"]!r}, "artists":{track["artists"]!r}, "duration_ms":{track["duration_ms"]}, "source_url":"https://example.com/song2"}}]
    def metadata(self, context, request):
        return [{{"id":"song", "title":{track["title"]!r}, "artists":{track["artists"]!r}, "duration_ms":{track["duration_ms"]}, "fields":{{"title":{track["title"]!r},"artists":{track["artists"]!r}}}, "source_url":"https://example.com/song2"}}]
    def lyrics(self, context, candidate):
        return {{"original":"synthetic", "normalized":{{"kind":"synced", "format":"krc", "lines":[{{"time_ms":1000,"text":"Synthetic","words":[{{"start_ms":1000,"end_ms":2000,"text":"Synthetic"}}]}}],"layers":{{"translation":[{{"time_ms":1000,"text":"合成译文"}}]}}}}}}
"""
        second_zip = io.BytesIO()
        with ZipFile(second_zip, "w") as archive:
            archive.writestr("manifest.json", json.dumps(second_manifest))
            archive.writestr("adapter.py", adapter)
        assert (
            client.post(
                "/api/v1/manage/source-plugins/import",
                headers=HEADERS,
                content=second_zip.getvalue(),
            ).status_code
            == 200
        )
        assert (
            client.put(
                "/api/v1/manage/source-plugins/second-source",
                headers=HEADERS,
                json={"version": 1, "enabled": True, "priority": 60},
            ).status_code
            == 200
        )
        sources = client.get("/api/v1/manage/lyric-scans/sources").json()["items"]
        assert [s["id"] for s in sources] == ["fixture-source", "second-source"]

        # GET settings schema remains untouched (round-trip strict PUT still succeeds)
        current_settings = client.get("/api/v1/manage/lyric-scan-settings").json()
        assert (
            client.put(
                "/api/v1/manage/lyric-scan-settings", headers=HEADERS, json=current_settings
            ).status_code
            == 200
        )

        invalid = client.post(
            BASE + "/preview", headers=HEADERS, json={"plugin_ids": ["missing-source"]}
        )
        assert invalid.status_code == 422
        assert (
            client.post(
                BASE + "/preview", headers=HEADERS, json={"plugin_ids": ["second-source"]}
            ).json()["total"]
            == 1
        )
        created = client.post(
            BASE, headers=HEADERS, json={"plugin_ids": ["second-source"], "goal": 1}
        )
        assert created.status_code == 200
        batch = finish(client, scans, created.json()["id"])
        assert batch["items"][0]["results"] and list(batch["items"][0]["results"].keys()) == [
            "second-source"
        ]
