"""Bounded, allowlisted diagnostics independent of library transactions.

Only structured projections enter persistence or console output. In particular,
exception strings, request bodies, paths, query strings and model text do not.
"""

import contextvars
import json
import logging
import queue
import re
import sqlite3
import sys
import threading
import time
from contextlib import contextmanager
from datetime import UTC, datetime
from importlib.metadata import version
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Annotated
from uuid import uuid4

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from fastapi.responses import JSONResponse

TRACE_HEADER = "X-Wildstring-Trace-Id"
RETENTION_DAYS = 7
MAX_BYTES = 200 * 1024 * 1024
_context = contextvars.ContextVar("wildstring_diagnostics", default=None)
_name = re.compile(r"^[A-Za-z0-9_.:-]{1,100}$")
_trace = re.compile(r"^[a-f0-9]{32}$")
_fields = {
    "trace_id",
    "user_id",
    "task_id",
    "batch_id",
    "draft_id",
    "run_id",
    "attempt",
    "service",
    "domain",
    "proxy_mode",
    "via_proxy",
    "http_status",
    "elapsed_ms",
    "code",
    "stage",
    "count",
    "method",
    "source",
    "exception_type",
    "line",
    "model_calls",
    "tool_calls",
    "input_tokens",
    "output_tokens",
    "operation",
}


def trace_id():
    return (_context.get() or {}).get("trace_id") or uuid4().hex


@contextmanager
def trace_context(identity, *, user_id=None, task_id=None, sink=None):
    values = (_context.get() or {}).copy()
    values["trace_id"] = identity if _trace.fullmatch(str(identity)) else uuid4().hex
    if user_id is not None:
        values["user_id"] = user_id
    if task_id is not None:
        values["task_id"] = task_id
    if sink is not None:
        values["sink"] = sink
    token = _context.set(values)
    try:
        yield values["trace_id"]
    finally:
        _context.reset(token)


def _project(event, level, fields):
    result = {
        "id": uuid4().hex,
        "time": datetime.now(UTC).isoformat(),
        "schema_version": 1,
        "version": version("wildstring-backend"),
        "level": level if level in {"DEBUG", "INFO", "WARNING", "ERROR"} else "INFO",
        "event": event
        if isinstance(event, str) and _name.fullmatch(event)
        else "application.event",
    }
    for key, value in fields.items():
        if key not in _fields or value is None:
            continue
        if isinstance(value, bool | int | float):
            result[key] = value
        elif isinstance(value, str) and _name.fullmatch(value):
            # Hosts/IDs/codes only. Arbitrary descriptions are not log fields.
            result[key] = value
    return result


def record_event(event, *, level="INFO", trace_id=None, sink=None, **fields):
    context = _context.get() or {}
    target = sink or context.get("sink")
    values = {key: value for key, value in context.items() if key != "sink"} | fields
    if trace_id:
        values["trace_id"] = trace_id
    result = _project(event, level, values)
    if target is not None:
        target.record(result)
    # No raw values are passed to the logging subsystem.
    logging.getLogger("wildstring.events").log(
        getattr(logging, result["level"]), result["event"], extra={"safe_event": result}
    )
    return result


class SafeFormatter(logging.Formatter):
    def format(self, record):
        result = getattr(record, "safe_event", None)
        if result is None:
            result = _project("application.log", record.levelname, {"source": record.name})
            if record.exc_info and record.exc_info[0]:
                result["exception_type"] = record.exc_info[0].__name__
            result["line"] = record.lineno
        return json.dumps(result, ensure_ascii=False, allow_nan=False)


class SafeCapture(logging.Handler):
    def emit(self, record):
        context = _context.get() or {}
        target = context.get("sink")
        if target is None or record.name == "wildstring.events":
            return
        fields = {key: value for key, value in context.items() if key != "sink"}
        fields.update(source=record.name, line=record.lineno)
        if record.exc_info and record.exc_info[0]:
            fields["exception_type"] = record.exc_info[0].__name__
        target.record(_project("application.log", record.levelname, fields))


def install_logging():
    """Cover Uvicorn's console too; do not replace capture or third-party handlers."""
    root = logging.getLogger()
    if not any(isinstance(handler, SafeCapture) for handler in root.handlers):
        root.addHandler(SafeCapture())
    if not any(
        isinstance(handler, logging.StreamHandler)
        and not type(handler).__module__.startswith("_pytest")
        for handler in root.handlers
    ):
        handler = logging.StreamHandler(sys.stderr)
        handler.setFormatter(SafeFormatter())
        root.addHandler(handler)
    for name in ("", "uvicorn", "uvicorn.error", "uvicorn.access", "wildstring"):
        logger = logging.getLogger(name)
        for handler in logger.handlers:
            if isinstance(handler, logging.StreamHandler) and not type(
                handler
            ).__module__.startswith("_pytest"):
                handler.setFormatter(SafeFormatter())


class DiagnosticFileHandler(RotatingFileHandler):
    """logging otherwise swallows file errors before Diagnostics.flush can see them."""

    def __init__(self, owner, *args, **kwargs):
        self.owner = owner
        super().__init__(*args, **kwargs)

    def handleError(self, record):
        self.owner.degraded = True
        self.owner.dropped += 1
        # No recursive logging or default stderr dump of record/exception contents.


class Diagnostics:
    def __init__(self, directory):
        self.directory = Path(directory) / "diagnostics"
        self.path = self.directory / "events.sqlite3"
        self.pending = queue.Queue(maxsize=1024)
        self.stopping = threading.Event()
        self.thread = None
        self.degraded = False
        self.dropped = 0
        self.debug_until = 0
        self.debug_module = "all"
        self.file_handler = None
        self.error_rates = {}
        self.rate_lock = threading.Lock()
        self.next_cleanup = 0
        self.database = None
        self.repository = None

    def connect(self):
        connection = sqlite3.connect(self.path, timeout=1)
        connection.row_factory = sqlite3.Row
        return connection

    def start(self):
        try:
            self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
            with self.connect() as connection:
                connection.executescript(
                    "CREATE TABLE IF NOT EXISTS events (sequence INTEGER PRIMARY KEY AUTOINCREMENT,"
                    "id TEXT UNIQUE,at REAL NOT NULL,trace_id TEXT,level TEXT,event TEXT,task_id TEXT,"
                    "payload TEXT NOT NULL);"
                    "CREATE INDEX IF NOT EXISTS event_trace ON events(trace_id,sequence);"
                    "CREATE INDEX IF NOT EXISTS event_time ON events(at);"
                )
            self.file_handler = DiagnosticFileHandler(
                self, self.directory / "events.jsonl", maxBytes=5 * 1024 * 1024, backupCount=9
            )
            self.file_handler.setFormatter(SafeFormatter())
            self.thread = threading.Thread(
                target=self.work, name="wildstring-diagnostics", daemon=True
            )
            self.thread.start()
        except (OSError, sqlite3.Error):
            self.degraded = True

    def record(self, event):
        if event["level"] == "DEBUG" and (
            time.time() > self.debug_until
            or (
                self.debug_module != "all"
                and not event["event"].startswith(self.debug_module + ".")
            )
        ):
            return
        if event["event"] in {
            "provider.worker.failed",
            "provider.worker.stopped",
            "agent.worker.error",
        }:
            key = (event["event"], event.get("code"))
            with self.rate_lock:
                previous, count = self.error_rates.get(key, (0, 0))
                if time.monotonic() - previous < 30:
                    self.error_rates[key] = (previous, count + 1)
                    return
                event["count"] = count + 1
                self.error_rates[key] = (time.monotonic(), 0)
                if len(self.error_rates) > 128:
                    self.error_rates.pop(next(iter(self.error_rates)))
        try:
            self.pending.put_nowait(event)
        except queue.Full:
            self.degraded = True
            self.dropped += 1

    def flush(self):
        batch = []
        for _ in range(100):
            try:
                batch.append(self.pending.get_nowait())
            except queue.Empty:
                break
        if not batch:
            return
        try:
            with self.connect() as connection:
                connection.executemany(
                    "INSERT OR IGNORE INTO events(id,at,trace_id,level,event,task_id,payload) VALUES(?,?,?,?,?,?,?)",
                    [
                        (
                            item["id"],
                            time.time(),
                            item.get("trace_id"),
                            item["level"],
                            item["event"],
                            item.get("task_id"),
                            json.dumps(item, ensure_ascii=False),
                        )
                        for item in batch
                    ],
                )
                connection.execute(
                    "DELETE FROM events WHERE at<?", (time.time() - RETENTION_DAYS * 86400,)
                )
                # Keep SQL and JSON combined below 200 MiB. Rows have a strict projection.
                count = connection.execute("SELECT count(*) FROM events").fetchone()[0]
                if count > 100000:
                    connection.execute(
                        "DELETE FROM events WHERE sequence IN (SELECT sequence FROM events ORDER BY sequence LIMIT ?)",
                        (count - 100000,),
                    )
            if self.path.stat().st_size > 140 * 1024 * 1024:
                with self.connect() as connection:
                    connection.execute(
                        "DELETE FROM events WHERE sequence < (SELECT max(sequence)-20000 FROM events)"
                    )
                    connection.commit()
                    connection.execute("VACUUM")
            if time.monotonic() > self.next_cleanup:
                cutoff = time.time() - RETENTION_DAYS * 86400
                active = self.directory / "events.jsonl"
                if self.file_handler and active.exists() and active.stat().st_mtime < cutoff:
                    self.file_handler.doRollover()
                for path in self.directory.glob("events.jsonl.*"):
                    if path.stat().st_mtime < cutoff:
                        path.unlink(missing_ok=True)
                self.next_cleanup = time.monotonic() + 3600
            if self.file_handler:
                for item in batch:
                    record = logging.LogRecord(
                        "wildstring.events", logging.INFO, "", 0, item["event"], (), None
                    )
                    record.safe_event = item
                    self.file_handler.emit(record)
        except (OSError, sqlite3.Error, ValueError):
            # Logging failure cannot change a successful business operation or block playback.
            self.degraded = True
            self.dropped += len(batch)
        finally:
            for _ in batch:
                self.pending.task_done()

    def work(self):
        while not self.stopping.wait(0.2):
            self.flush()
        while not self.pending.empty():
            self.flush()

    def stop(self):
        self.stopping.set()
        if self.thread:
            self.thread.join(timeout=3)
        if self.file_handler:
            try:
                self.file_handler.close()
            except (OSError, ValueError):
                self.degraded = True

    def status(self):
        return {
            "retention_days": RETENTION_DAYS,
            "max_bytes": MAX_BYTES,
            "degraded": self.degraded,
            "dropped_events": self.dropped,
            "debug_until": self.debug_until if self.debug_until > time.time() else None,
        }

    def trace_members(self, identity):
        """Expand a known current-library refresh batch into bounded persisted job traces."""
        if not identity or self.database is None or self.repository is None:
            return [identity] if identity else [], False
        with self.database.connect() as connection:
            rows = connection.execute(
                "SELECT m.job_id FROM provider_refresh_members m "
                "JOIN provider_refresh_batches b ON b.id=m.batch_id "
                "WHERE b.id=? AND b.library_id=? ORDER BY m.position LIMIT 1001",
                (identity, self.repository.library_id()),
            ).fetchall()
        return list(
            dict.fromkeys([identity, *[row[0].replace("-", "") for row in rows[:1000]]])
        ), len(rows) > 1000

    def events(self, *, limit=50, cursor=None, trace_id=None, level=None, event=None, task_id=None):
        limit = max(1, min(int(limit), 100))
        for value in (trace_id, level, event, task_id):
            if value and (not isinstance(value, str) or not _name.fullmatch(value)):
                raise HTTPException(422, "invalid_diagnostic_filter")
        if cursor and not str(cursor).isdecimal():
            raise HTTPException(422, "invalid_diagnostic_cursor")
        cutoff = int(cursor) if cursor else None
        try:
            identifiers, members_truncated = self.trace_members(trace_id)
            with self.connect() as connection:
                rows = connection.execute(
                    "SELECT sequence,payload FROM events "
                    "WHERE (? IS NULL OR trace_id IN (SELECT value FROM json_each(?)) OR json_extract(payload,'$.batch_id')=?) AND (? IS NULL OR level=?) "
                    "AND (? IS NULL OR event=?) AND (? IS NULL OR task_id=?) "
                    "AND (? IS NULL OR sequence<?) ORDER BY sequence DESC LIMIT ?",
                    (
                        trace_id or None,
                        json.dumps(identifiers),
                        trace_id,
                        level or None,
                        level,
                        event or None,
                        event,
                        task_id or None,
                        task_id,
                        cutoff,
                        cutoff,
                        limit + 1,
                    ),
                ).fetchall()
            items = [json.loads(row["payload"]) for row in rows[:limit]]
            return {
                "items": items,
                "next_cursor": str(rows[limit - 1]["sequence"]) if len(rows) > limit else None,
                "trace_member_count": len(identifiers),
                "trace_members_truncated": members_truncated,
            } | self.status()
        except (OSError, sqlite3.Error):
            return {"items": [], "next_cursor": None} | self.status() | {"degraded": True}

    def bundle(self, trace_id=None):
        return {
            "version": version("wildstring-backend"),
            "logging": self.status(),
            "events": self.events(limit=100, trace_id=trace_id)["items"],
            "truncated_at": 100,
        }


class RequestTrace:
    def __init__(self, app, diagnostics):
        self.app, self.diagnostics = app, diagnostics

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        supplied = dict(scope.get("headers", [])).get(b"x-wildstring-trace-id", b"")
        identity = supplied.decode("ascii", errors="ignore")
        if not _trace.fullmatch(identity):
            identity = uuid4().hex
        scope.setdefault("state", {})["trace_id"] = identity
        started, status = time.monotonic(), 500

        async def traced_send(message):
            nonlocal status
            if message["type"] == "http.response.start":
                status = message["status"]
                message = message | {
                    "headers": [
                        (key, value)
                        for key, value in message.get("headers", [])
                        if key.lower() != b"x-wildstring-trace-id"
                    ]
                    + [(b"x-wildstring-trace-id", identity.encode())]
                }
            await send(message)

        with trace_context(identity, sink=self.diagnostics):
            try:
                await self.app(scope, receive, traced_send)
            except Exception as error:
                record_event("request.failed", level="ERROR", exception_type=type(error).__name__)
                raise
            finally:
                user = scope["state"].get("user") or {}
                quiet = status < 400 and (
                    scope.get("path", "").startswith("/health")
                    or "/stream" in scope.get("path", "")
                )
                record_event(
                    "request.completed",
                    level="DEBUG" if quiet else "INFO",
                    method=scope.get("method"),
                    user_id=user.get("id"),
                    http_status=status,
                    elapsed_ms=round((time.monotonic() - started) * 1000),
                )


def diagnostics_router(service, auth, database):
    router = APIRouter(
        prefix="/api/v1/manage/diagnostics", dependencies=[Depends(auth.require_owner)]
    )

    @router.get("/status")
    def status():
        with database.connect() as connection:
            schema = connection.execute("PRAGMA user_version").fetchone()[0]
        return {
            "version": version("wildstring-backend"),
            "schema_version": schema,
            "logging": service.status(),
            "external_services": ["musicbrainz", "lastfm", "caa", "acoustid"],
            "agent_available": True,
        }

    @router.get("/events")
    def events(
        limit: int = Query(50, ge=1, le=100),
        cursor: str | None = None,
        trace_id: str | None = None,
        level: str | None = None,
        event: str | None = None,
        task_id: str | None = None,
    ):
        return service.events(
            limit=limit, cursor=cursor, trace_id=trace_id, level=level, event=event, task_id=task_id
        )

    @router.get("/traces/{identity}")
    def trace(identity: str):
        return service.events(limit=100, trace_id=identity)

    @router.get("/bundle")
    def bundle(trace_id: str | None = None):
        return JSONResponse(
            service.bundle(trace_id),
            headers={
                "Cache-Control": "no-store",
                "Content-Disposition": 'attachment; filename="wildstring-diagnostics.json"',
            },
        )

    @router.post("/debug", dependencies=[Depends(auth.require_client)])
    def debug(body: Annotated[dict, Body()]):
        if (
            set(body) != {"minutes", "module"}
            or type(body["minutes"]) is not int
            or not 0 <= body["minutes"] <= 15
            or body["module"] not in {"outbound", "agent", "all"}
        ):
            raise HTTPException(422, "invalid_debug_settings")
        service.debug_until = time.time() + body["minutes"] * 60 if body["minutes"] else 0
        service.debug_module = body["module"]
        return {"debug_until": service.status()["debug_until"], "module": service.debug_module}

    return router
