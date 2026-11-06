"""Trace isolation, safe persistence, retention and failure-independent logging."""

import json
import logging
import time
from concurrent.futures import ThreadPoolExecutor

import pytest

from wildstring.diagnostics import (
    DiagnosticLevelFilter,
    Diagnostics,
    LogSettings,
    SafeCapture,
    SafeFormatter,
    exception_stack,
    record_event,
    trace_context,
)

HEADERS = {"X-Wildstring-Client": "web"}


def test_exception_stack_preserves_origin_and_causes_without_values(tmp_path):
    service = Diagnostics(tmp_path)
    service.start()

    def failing_origin():
        private_local = "must-not-appear-in-stack"
        raise ValueError(private_local)

    with trace_context("c" * 32, sink=service):
        try:
            try:
                failing_origin()
            except ValueError as cause:
                raise RuntimeError("outer-private-message") from cause
        except RuntimeError as error:
            record_event("test.failed", level="ERROR", error=error)
    service.stop()
    event = service.events(trace_id="c" * 32)["items"][0]
    chain = event["stack"]["exceptions"]
    assert [item["type"] for item in chain] == ["RuntimeError", "ValueError"]
    assert chain[1]["relation"] == "cause"
    assert chain[1]["frames"][-1]["function"] == "failing_origin"
    assert chain[1]["frames"][-1]["line"] > 0
    for text in (json.dumps(event), (service.directory / "events.jsonl").read_text()):
        assert "must-not-appear-in-stack" not in text
        assert "outer-private-message" not in text
        assert str(tmp_path) not in text


def test_standard_logs_and_events_share_levels_debug_scope_and_stack_toggle(tmp_path, monkeypatch):
    import io

    service = Diagnostics(tmp_path)
    service.start()
    service.configure(LogSettings(level="WARNING", capture_stack=False))
    output = io.StringIO()
    console = logging.StreamHandler(output)
    console.setFormatter(SafeFormatter(service))
    console.addFilter(DiagnosticLevelFilter(service))
    logger = logging.getLogger("wildstring.agent.fixture")
    monkeypatch.setattr(logger, "handlers", [SafeCapture(service), console])
    monkeypatch.setattr(logger, "propagate", False)
    previous_level = logger.level
    logger.setLevel(logging.DEBUG)
    try:
        with trace_context("d" * 32, sink=service):
            logger.info("private-info")
            record_event("agent.info")
            logger.debug("private-debug")
            service.debug_until = time.time() + 30
            service.debug_module = "outbound"
            logger.debug("private-wrong-module")
            service.debug_module = "agent"
            logger.debug("private-matching-debug")
            record_event("agent.debug", level="DEBUG")
            record_event("outbound.debug", level="DEBUG")
            try:
                raise RuntimeError("private-error-message")
            except RuntimeError:
                logger.exception("private-log-message")
            logger.critical("private-critical")
    finally:
        logger.setLevel(previous_level)
        service.stop()
    events = service.events(trace_id="d" * 32)["items"]
    assert sorted(item["level"] for item in events) == ["CRITICAL", "DEBUG", "DEBUG", "ERROR"]
    assert all("stack" not in item for item in events)
    assert any(item.get("exception_type") == "RuntimeError" for item in events)
    console_events = [json.loads(line) for line in output.getvalue().splitlines()]
    assert [item["level"] for item in console_events] == ["DEBUG", "ERROR", "CRITICAL"]
    assert "private-" not in output.getvalue()


def test_settings_are_owner_only_validated_and_survive_restart(
    settings, authenticated_client, monkeypatch
):
    from test_users import login, new_user

    with authenticated_client(settings) as client:
        endpoint = "/api/v1/manage/diagnostics/settings"
        body = {"level": "ERROR", "capture_stack": False}
        assert client.put(endpoint, json=body).status_code == 403
        for invalid in (
            {"level": "DEBUG", "capture_stack": True},
            {"level": "ERROR", "capture_stack": "false"},
            body | {"unknown": True},
        ):
            assert client.put(endpoint, json=invalid, headers=HEADERS).status_code == 422
        saved = client.put(endpoint, json=body, headers=HEADERS)
        assert saved.status_code == 200
        assert saved.json()["level"] == "ERROR"
        assert saved.json()["capture_stack"] is False
        service = client.app.state.diagnostics
        with monkeypatch.context() as patch:
            import sqlite3

            def unavailable():
                raise sqlite3.OperationalError("synthetic-disk-failure")

            patch.setattr(service, "connect", unavailable)
            failed = client.put(
                endpoint, json={"level": "INFO", "capture_stack": True}, headers=HEADERS
            )
            assert failed.status_code == 503
            assert service.settings == LogSettings(level="ERROR", capture_stack=False)
        service.debug_until = time.time() + 30
        new_user(client)
        client.post("/api/v1/auth/logout", headers=HEADERS)
        assert login(client).status_code == 200
        assert client.put(endpoint, json=body, headers=HEADERS).status_code == 403
        assert client.get("/api/v1/manage/diagnostics/events").status_code == 403
        client.post("/api/v1/auth/logout", headers=HEADERS)
        assert client.put(endpoint, json=body, headers=HEADERS).status_code == 401
    restarted = Diagnostics(settings.data_dir)
    restarted.start()
    try:
        assert restarted.settings == LogSettings(level="ERROR", capture_stack=False)
        assert restarted.status()["debug_until"] is None
    finally:
        restarted.stop()


def test_failed_request_records_origin_stack_and_status(settings, authenticated_client):
    with authenticated_client(settings) as client:

        def failing_route():
            raise ValueError("private-request-value")

        client.app.add_api_route("/api/v1/diagnostic-fixture", failing_route)
        with pytest.raises(ValueError):
            client.get("/api/v1/diagnostic-fixture", headers={"X-Wildstring-Trace-Id": "e" * 32})
        service = client.app.state.diagnostics
        service.flush()
        events = service.events(trace_id="e" * 32)["items"]
        failed = next(item for item in events if item["event"] == "request.failed")
        assert failed["level"] == "ERROR"
        assert failed["stack"]["exceptions"][0]["frames"][-1]["function"] == "failing_route"
        completed = next(item for item in events if item["event"] == "request.completed")
        assert completed["level"] == "ERROR" and completed["http_status"] == 500
        assert "private-request-value" not in json.dumps(service.bundle("e" * 32))


def test_stack_honors_suppression_and_bounds():
    try:
        try:
            raise ValueError("hidden")
        except ValueError:
            raise RuntimeError("hidden") from None
    except RuntimeError as error:
        assert len(exception_stack(error)["exceptions"]) == 1

    previous = None
    for _ in range(7):
        error = RuntimeError("hidden")
        error.__cause__ = previous
        previous = error
    stack = exception_stack(previous)
    assert len(stack["exceptions"]) == 5 and stack["chain_truncated"]

    def recurse(depth):
        if depth:
            return recurse(depth - 1)
        raise RuntimeError("hidden")

    try:
        recurse(40)
    except RuntimeError as error:
        frames = exception_stack(error)["exceptions"][0]
        assert len(frames["frames"]) == 32 and frames["frames_truncated"]


def test_structured_projection_drops_secrets_in_values_and_exception(tmp_path):
    service = Diagnostics(tmp_path)
    service.start()
    secret = "private-token?signature=secret"
    with trace_context("a" * 32, user_id="owner", sink=service):
        record_event(
            "outbound.completed",
            code="tls_error",
            domain="example.com",
            api_key=secret,
            url=secret,
            payload={"token": secret},
            stage=secret,
        )
    service.stop()
    payload = service.events(trace_id="a" * 32)
    assert len(payload["items"]) == 1
    assert payload["items"][0]["user_id"] == "owner"
    assert secret not in json.dumps(payload)
    assert secret not in (service.directory / "events.jsonl").read_text()
    try:
        raise RuntimeError(secret)
    except RuntimeError:
        import sys

        record = logging.LogRecord(
            "wildstring.unsafe", logging.ERROR, secret, 10, secret, (), sys.exc_info()
        )
    formatted = SafeFormatter().format(record)
    assert secret not in formatted and "RuntimeError" in formatted


def test_two_instances_and_worker_contexts_never_cross(tmp_path):
    one, two = Diagnostics(tmp_path / "one"), Diagnostics(tmp_path / "two")
    one.start()
    two.start()

    def work(service, identity, owner):
        with trace_context(identity, user_id=owner, sink=service):
            for _ in range(10):
                record_event("agent.step", task_id="task")

    with ThreadPoolExecutor(max_workers=2) as pool:
        list(pool.map(lambda args: work(*args), [(one, "a" * 32, "alice"), (two, "b" * 32, "bob")]))
    one.stop()
    two.stop()
    assert {item["user_id"] for item in one.events()["items"]} == {"alice"}
    assert {item["trace_id"] for item in two.events()["items"]} == {"b" * 32}


def test_queue_disk_failure_and_temporary_debug_are_bounded(tmp_path, monkeypatch):
    service = Diagnostics(tmp_path)
    service.start()
    record_event("outbound.detail", level="DEBUG", sink=service)
    assert service.pending.empty()
    service.debug_until = time.time() + 30
    service.debug_module = "outbound"
    record_event("agent.detail", level="DEBUG", sink=service)
    assert service.pending.empty()
    record_event("outbound.detail", level="DEBUG", sink=service)
    service.stop()
    assert len(service.events()["items"]) == 1
    service.debug_until = time.time() - 1
    record_event("outbound.detail", level="DEBUG", sink=service)
    assert service.pending.empty() and service.status()["debug_until"] is None
    for _ in range(1500):
        record_event("agent.step", sink=service)
    assert service.pending.qsize() == 1024 and service.dropped == 476
    monkeypatch.setattr(service, "connect", lambda: (_ for _ in ()).throw(OSError("private-token")))
    service.flush()
    assert service.degraded


def test_request_headers_permissions_cursor_and_safe_bundle(settings, authenticated_client):
    with authenticated_client(settings) as client:
        one = client.get("/api/v1/tracks", headers={"X-Wildstring-Trace-Id": "a" * 32})
        assert one.headers["X-Wildstring-Trace-Id"] == "a" * 32
        two = client.get("/api/v1/tracks", headers={"X-Wildstring-Trace-Id": "private-invalid"})
        assert len(two.headers["X-Wildstring-Trace-Id"]) == 32
        service = client.app.state.diagnostics
        service.flush()
        result = client.get("/api/v1/manage/diagnostics/events?limit=1").json()
        assert len(result["items"]) == 1 and result["next_cursor"]
        next_page = client.get(
            "/api/v1/manage/diagnostics/events", params={"cursor": result["next_cursor"]}
        ).json()
        assert result["items"][0]["id"] not in {item["id"] for item in next_page["items"]}
        trace = client.get("/api/v1/manage/diagnostics/traces/" + "a" * 32).json()
        assert trace["items"][0]["trace_id"] == "a" * 32
        assert client.get("/api/v1/manage/diagnostics/events?cursor=SQL").status_code == 422
        assert (
            client.post(
                "/api/v1/manage/diagnostics/debug",
                json={"minutes": 16, "module": "all"},
                headers=HEADERS,
            ).status_code
            == 422
        )
        assert (
            client.post(
                "/api/v1/manage/diagnostics/debug",
                json={"minutes": 1, "module": "outbound"},
                headers=HEADERS,
            ).status_code
            == 200
        )
        bundle = client.get("/api/v1/manage/diagnostics/bundle?trace_id=" + "a" * 32)
        assert (
            "no-store" in bundle.headers["cache-control"]
            and "attachment" in bundle.headers["content-disposition"]
        )
        assert "password" not in bundle.text and "base_url" not in bundle.text
        client.post("/api/v1/auth/logout", headers=HEADERS)
        assert client.get("/api/v1/manage/diagnostics/events").status_code == 401


def test_jsonl_write_failure_marks_degraded_without_stderr_or_business_failure(tmp_path):
    import io
    from contextlib import redirect_stderr

    class BrokenStream(io.StringIO):
        def write(self, value):
            raise OSError("synthetic-file-write-failure")

    service = Diagnostics(tmp_path)
    service.start()
    service.stopping.set()
    service.thread.join(timeout=2)
    service.file_handler.stream.close()
    service.file_handler.stream = BrokenStream()
    stderr = io.StringIO()
    with redirect_stderr(stderr):
        record_event("test.file.failure", sink=service)
        service.flush()
    assert service.degraded and service.dropped == 1
    assert len(service.events()["items"]) == 1
    assert stderr.getvalue() == ""
    service.stop()


def test_refresh_notification_trace_expands_jobs_and_legacy_task_diagnostics(
    settings, authenticated_client
):
    from test_personal_library import music

    from wildstring.library.scanner import scan_library
    from wildstring.task_notifications import metadata_result

    music(settings, "one.flac", ["合成"], [])
    music(settings, "two.flac", ["合成"], [])
    scan_library(settings)
    with authenticated_client(settings) as client:
        providers = client.app.state.providers
        providers.stop()
        service = client.app.state.agent_platform
        service.stop()
        diagnostics = client.app.state.diagnostics
        with service.database.connect(write=True) as connection:
            connection.execute("UPDATE provider_settings SET enabled=1 WHERE id=1")
        ids = [row["id"] for row in service.repository.tracks()["items"]]
        batch = providers.enqueue(ids, track_batch=True)
        with service.database.connect(write=True) as connection:
            rows = connection.execute(
                "SELECT id,track_id FROM provider_jobs ORDER BY id"
            ).fetchall()
            for row in rows:
                connection.execute(
                    "UPDATE provider_jobs SET status='failed',error='tls_error' WHERE id=?",
                    (row["id"],),
                )
            metadata_result(providers, connection, rows[-1]["id"])
            connection.execute(
                "INSERT INTO admin_jobs(id,library_id,kind,full,status,created_at,result) VALUES (?,?,'scan',0,'completed',?,?)",
                (
                    "b" * 32,
                    service.library_id,
                    "2026-10-17T00:00:00+00:00",
                    json.dumps(
                        {
                            "counts": {"added": 2},
                            "errors": [{"path": "/private/library/never-expose"}],
                        }
                    ),
                ),
            )
        for index, row in enumerate(rows):
            with trace_context(row["id"], task_id=row["id"], sink=diagnostics):
                record_event(
                    "provider.fixture.failed", level="WARNING", code="tls_error", attempt=index
                )
        diagnostics.flush()
        notification = client.get("/api/v1/agent/notifications").json()["items"][0]
        assert notification["trace_id"] == batch["batch_id"]
        trace = client.get("/api/v1/manage/diagnostics/traces/" + notification["trace_id"]).json()
        assert {row["id"] for row in rows} <= {event.get("trace_id") for event in trace["items"]}
        assert trace["trace_members_truncated"] is False

        def tool(identity):
            response = client.post(
                "/api/v1/agent/tools/get_task_diagnostics",
                headers=HEADERS,
                json={"task_id": identity},
            )
            assert response.status_code == 200, response.text
            return response.json()["result"]

        assert tool(batch["batch_id"])["task"]["kind"] == "metadata_refresh_batch"
        assert tool(rows[0]["id"])["task"]["error_code"] == "tls_error"
        admin = tool("b" * 32)
        assert admin["task"]["counts"] == {"added": 2}
        assert "never-expose" not in json.dumps(admin)
        # A batch belonging to another configured library must not expand into this one.
        with service.database.connect(write=True) as connection:
            connection.execute(
                "INSERT INTO libraries(id,root) VALUES (?,?)", ("other-library", "/not-this-root")
            )
            connection.execute(
                "INSERT INTO provider_refresh_batches VALUES (?,?,0,1)", ("c" * 32, "other-library")
            )
            connection.execute(
                "INSERT INTO provider_refresh_members VALUES (?,?,?,?,0)",
                ("c" * 32, rows[0]["id"], ids[0], "other"),
            )
        assert diagnostics.trace_members("c" * 32) == (["c" * 32], False)
        assert (
            client.post(
                "/api/v1/agent/tools/get_task_diagnostics",
                headers=HEADERS,
                json={"task_id": "c" * 32},
            ).status_code
            == 404
        )
