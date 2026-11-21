import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

import pytest

from wildstring.database import Database
from wildstring.plugin_archives import _PrioritySlot, execute
from wildstring.plugin_rate import cooldown, permit
from wildstring.source_plugins import InstalledPlugin, Manifest, PluginError


def test_gate_rejection_preserves_cooldown_without_extending_it(tmp_path):
    database = Database(tmp_path)
    database.initialize()
    policy = {"database": str(database.path), "plugin_id": "fixture", "interval_seconds": 1}
    until = cooldown(policy, 120)
    with pytest.raises(PluginError) as failure:
        permit(policy)
    assert failure.value.code == "source_plugin_rate_limited"
    assert not failure.value.upstream_429
    assert failure.value.cooldown_until == until
    with database.connect() as db:
        assert db.execute("SELECT cooldown_until FROM plugin_request_gates").fetchone()[0] == until


def test_priority_slot_serves_interactive_waiter_first():
    slot = _PrioritySlot()
    order = []
    held = threading.Event()
    release = threading.Event()

    def run(interactive):
        with slot.acquire(interactive):
            order.append(interactive)

    def hold():
        with slot.acquire(False):
            held.set()
            release.wait(timeout=2)

    with ThreadPoolExecutor(max_workers=3) as pool:
        holder = pool.submit(hold)
        assert held.wait(timeout=1)
        background = pool.submit(run, False)
        interactive = pool.submit(run, True)
        deadline = time.monotonic() + 1
        while slot.interactive_waiters != 1 and time.monotonic() < deadline:
            time.sleep(0.001)
        assert slot.interactive_waiters == 1
        release.set()
        holder.result(timeout=1)
        interactive.result(timeout=1)
        background.result(timeout=1)
    assert order == [True, False]


def test_cache_bypasses_slot_and_cold_requests_are_deduplicated(tmp_path, monkeypatch):
    database = Database(tmp_path)
    database.initialize()
    calls = []

    class Process:
        def __init__(self, *args, stdout, **kwargs):
            calls.append(1)
            time.sleep(0.1)
            stdout.write(json.dumps({"value": None}).encode())
            self.returncode = 0
            self.pid = 0

        def poll(self):
            return 0

        def wait(self, timeout=None):
            return 0

    monkeypatch.setattr("wildstring.plugin_archives.subprocess.Popen", Process)
    monkeypatch.setattr("wildstring.plugin_archives.os.killpg", lambda *_: None)
    providers = SimpleNamespace(settings=lambda: {"proxy_mode": "environment"}, secrets=lambda: {})
    manager = SimpleNamespace(database=database, providers=providers, current=lambda *_: None)
    context = SimpleNamespace(
        manager=manager,
        identity="fixture",
        configuration={"version": 1, "config": {}},
        directory=tmp_path,
        deadline=time.monotonic() + 10,
        force=False,
        batch_id=None,
        interval_seconds=1,
        interactive=False,
    )
    plugin = InstalledPlugin(
        Manifest(
            id="fixture",
            name="Fixture",
            upstream="https://example.com",
            license="MIT",
            request_pacing=True,
        ),
        tmp_path,
        "digest",
    )
    with ThreadPoolExecutor(max_workers=2) as pool:
        assert list(pool.map(lambda _: execute(plugin, context, "search", "song"), range(2))) == [
            None,
            None,
        ]
    assert len(calls) == 1
    # Even an occupied slot cannot block a cached result.
    from wildstring.plugin_archives import _slots

    with _slots["fixture"].acquire(False):
        assert execute(plugin, context, "search", "song") is None
    assert len(calls) == 1


def test_worker_persists_upstream_cooldown_once(tmp_path):
    import subprocess
    import sys

    database = Database(tmp_path)
    database.initialize()
    (tmp_path / "adapter.py").write_text(
        "from wildstring.plugin_api import PluginError\n"
        "class Plugin:\n"
        "    def search(self, context, value):\n"
        "        context.throttle()\n"
        "        raise PluginError('source_plugin_rate_limited', upstream_429=True, retry_after=120)\n"
    )
    data = {
        "path": str(tmp_path),
        "entrypoint": "adapter:Plugin",
        "method": "search",
        "value": "x",
        "directory": str(tmp_path / "state"),
        "rate": {"database": str(database.path), "plugin_id": "fixture", "interval_seconds": 1},
    }

    def invoke():
        result = subprocess.run(
            [sys.executable, "-I", "-m", "wildstring.plugin_worker"],
            input=json.dumps(data),
            capture_output=True,
            text=True,
            check=True,
        )
        return json.loads(result.stdout)

    first = invoke()
    second = invoke()
    assert first["error"] == second["error"] == "source_plugin_rate_limited"
    assert first["upstream_429"] is True
    assert first["retry_after"] == 120
    assert second["upstream_429"] is False
    assert second["cooldown_until"] == first["cooldown_until"]
    with database.connect() as db:
        assert (
            db.execute("SELECT cooldown_until FROM plugin_request_gates").fetchone()[0]
            == first["cooldown_until"]
        )


def test_http_business_rate_code_preserves_retry_after(tmp_path, monkeypatch):
    from wildstring.plugin_worker import Context

    monkeypatch.setattr(
        "wildstring.plugin_worker.request_bytes",
        lambda *args, **kwargs: (200, {"Retry-After": "120"}, b'{"code": "429"}'),
    )
    context = Context({"directory": str(tmp_path), "proxy_mode": "environment"})
    with pytest.raises(PluginError) as failure:
        context.http("https://example.com/")
    assert failure.value.upstream_429 is True
    assert failure.value.retry_after == 120


def test_qq_cgi_partial_rate_limit_does_not_return_partial_success(tmp_path):
    pytest.importorskip("qqmusic_api")
    import importlib.util
    from pathlib import Path

    spec = importlib.util.spec_from_file_location(
        "community_adapters_test",
        Path(__file__).resolve().parents[2] / "plugins/community_adapters.py",
    )
    adapters = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(adapters)

    class Context:
        directory = tmp_path

        def http(self, url, **kwargs):
            assert kwargs["rate_codes"] == (429, 2001)
            return {"code": 0, "req_0": {"code": 2001}, "req_1": {"code": 0}}

    with pytest.raises(PluginError) as failure:
        adapters.QQPlugin().call(Context(), "song", ["a", "b"])
    assert failure.value.upstream_429 is True
    assert failure.value.retry_after == 900


def test_interactive_request_waits_for_active_source_and_precedes_background(tmp_path, monkeypatch):
    from filelock import FileLock

    from wildstring.plugin_archives import _slots

    database = Database(tmp_path)
    database.initialize()
    manager = SimpleNamespace(database=database, current=lambda *_: None)
    plugin = InstalledPlugin(
        Manifest("fixture-wait", "Fixture", "https://example.com", "MIT"), tmp_path, "digest"
    )
    directory = tmp_path / "plugin-state"
    directory.mkdir()
    lock = FileLock(str(directory / "fixture-wait.request.lock"))
    order = []

    def invoke(interactive, value):
        context = SimpleNamespace(
            manager=manager,
            identity="fixture-wait",
            configuration={"version": 1},
            directory=tmp_path,
            deadline=time.monotonic() + 7,
            force=False,
            interactive=interactive,
        )
        return execute(plugin, context, "search", value)

    def completed(_plugin, _context, _method, value, _key):
        order.append(value)
        return value

    monkeypatch.setattr("wildstring.plugin_archives.execute_serial", completed)
    with ThreadPoolExecutor(max_workers=3) as pool:
        with lock:
            holder = pool.submit(invoke, False, "holder")
            deadline = time.monotonic() + 1
            while (
                not _slots.get("fixture-wait") or not _slots["fixture-wait"].active
            ) and time.monotonic() < deadline:
                time.sleep(0.001)
            assert _slots["fixture-wait"].active
            interactive = pool.submit(invoke, True, "manual")
            deadline = time.monotonic() + 1
            while _slots["fixture-wait"].interactive_waiters != 1 and time.monotonic() < deadline:
                time.sleep(0.001)
            assert _slots["fixture-wait"].interactive_waiters == 1
            # The background attempt reaches its short lock deadline. A manual
            # request waiting for the slot must survive that full two seconds.
            with pytest.raises(PluginError, match="source_plugin_busy"):
                holder.result(timeout=4)
            background = pool.submit(invoke, False, "background")
            time.sleep(0.1)
        assert interactive.result(timeout=2) == "manual"
        assert background.result(timeout=2) == "background"
    assert order == ["manual", "background"]


def test_installed_v1_package_reports_unavailable(tmp_path):
    plugin = InstalledPlugin(
        Manifest("fixture", "Fixture", "https://example.com", "MIT", api_version=1),
        tmp_path,
        "digest",
    )
    assert not plugin.available()


def test_node_gate_runs_without_axios_dependency(tmp_path):
    import shutil
    import subprocess
    from pathlib import Path

    source = Path(__file__).resolve().parents[2] / "plugins/node-runtime/rate.cjs"
    shutil.copy(source, tmp_path / "rate.cjs")
    script = """
require('./rate.cjs').paced({}, async () => ({status: 200}))().then(result => {
  if (result.status !== 200) process.exit(1);
});
"""
    subprocess.run(
        ["node", "-e", script],
        cwd=tmp_path,
        capture_output=True,
        check=True,
        timeout=10,
    )
