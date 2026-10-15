"""Authenticated management and a durable, single-consumer library task queue."""

import json
import logging
import os
import shutil
import sqlite3
from importlib.metadata import version
from threading import Event, Thread
from typing import Annotated, Literal
from uuid import uuid4

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request
from filelock import FileLock, Timeout
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from wildstring.ai_config import AIService, AIUpdate
from wildstring.library.edits import MetadataEditor, MetadataUpdate
from wildstring.library.importer import import_music
from wildstring.library.repository import now
from wildstring.library.scanner import ScanBusyError, scan_library

logger = logging.getLogger(__name__)


class JobRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["import", "scan"]
    full: bool = Field(default=False, strict=True)


class PreferencesUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    name: str = Field(min_length=1, max_length=100)
    version: int = Field(ge=1, strict=True)


class Management:
    def __init__(self, settings, repository):
        self.settings, self.repository = settings, repository
        self.database = repository.database
        self.stopping = Event()
        self.thread = None

    def start(self):
        self.repository.library_id(create=True)
        self.thread = Thread(target=self.work, name="wildstring-library-worker", daemon=True)
        self.thread.start()

    def stop(self):
        self.stopping.set()
        if self.thread is not None:
            self.thread.join(timeout=5)

    def preferences(self):
        with self.database.connect() as connection:
            row = connection.execute(
                "SELECT name, version FROM library_preferences WHERE library_id=?",
                (self.repository.library_id(),),
            ).fetchone()
        return dict(row) if row else {"name": "我的曲库", "version": 1}

    def update_preferences(self, body):
        library_id = self.repository.library_id(create=True)
        with self.database.connect(write=True) as connection:
            connection.execute("BEGIN IMMEDIATE")
            connection.execute(
                "INSERT OR IGNORE INTO library_preferences(library_id) VALUES (?)",
                (library_id,),
            )
            result = connection.execute(
                "UPDATE library_preferences SET name=?, version=version+1 WHERE library_id=? AND version=?",
                (body.name, self.repository.library_id(), body.version),
            )
            if result.rowcount != 1:
                raise HTTPException(409, "settings_version_conflict")
        return self.preferences()

    def submit(self, body):
        library_id = self.repository.library_id(create=True)
        with self.database.connect(write=True) as connection:
            connection.execute("BEGIN IMMEDIATE")
            active = connection.execute(
                "SELECT * FROM admin_jobs WHERE library_id=? AND status IN ('queued','running')",
                (library_id,),
            ).fetchone()
            if active:
                if active["kind"] == body.kind and bool(active["full"]) == body.full:
                    return self.job(active["id"])
                raise HTTPException(409, "library_task_busy")
            job_id = uuid4().hex
            connection.execute(
                "INSERT INTO admin_jobs(id,library_id,kind,full,status,created_at) VALUES (?,?,?,?,'queued',?)",
                (job_id, library_id, body.kind, body.full, now()),
            )
        return self.job(job_id)

    def job(self, job_id):
        with self.database.connect() as connection:
            row = connection.execute(
                "SELECT * FROM admin_jobs WHERE id=? AND library_id=?",
                (job_id, self.repository.library_id()),
            ).fetchone()
            if row is None:
                raise HTTPException(404, "task_not_found")
            result = dict(row)
            result.pop("library_id")
            result["full"] = bool(result["full"])
            result["result"] = json.loads(result["result"]) if result["result"] else None
            if row["import_id"]:
                imported = connection.execute(
                    "SELECT status, counts, errors FROM import_runs WHERE id=?", (row["import_id"],)
                ).fetchone()
                result["import"] = (
                    {
                        "status": imported["status"],
                        "counts": json.loads(imported["counts"]),
                        "errors": json.loads(imported["errors"]),
                    }
                    if imported
                    else None
                )
            else:
                result["import"] = None
        result["scan"] = self.repository.scan(row["scan_id"]) if row["scan_id"] else None
        return result

    def jobs(self, limit=20, offset=0):
        with self.database.connect() as connection:
            parameters = (self.repository.library_id(),)
            total = connection.execute(
                "SELECT count(*) FROM admin_jobs WHERE library_id=?", parameters
            ).fetchone()[0]
            ids = connection.execute(
                "SELECT id FROM admin_jobs WHERE library_id=? ORDER BY created_at DESC, id LIMIT ? OFFSET ?",
                (*parameters, limit, offset),
            ).fetchall()
        return {
            "items": [self.job(row["id"]) for row in ids],
            "total": total,
            "limit": limit,
            "offset": offset,
        }

    def link(self, job_id, *, import_id=None, scan_id=None):
        with self.database.connect(write=True) as connection:
            connection.execute(
                "UPDATE admin_jobs SET import_id=COALESCE(?,import_id), scan_id=COALESCE(?,scan_id) WHERE id=?",
                (import_id, scan_id, job_id),
            )

    def claim(self):
        with self.database.connect(write=True) as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                "SELECT * FROM admin_jobs WHERE library_id=? AND status='queued' ORDER BY created_at, id LIMIT 1",
                (self.repository.library_id(),),
            ).fetchone()
            if row:
                connection.execute(
                    "UPDATE admin_jobs SET status='running', started_at=?, error=NULL WHERE id=?",
                    (now(), row["id"]),
                )
        return dict(row) if row else None

    def execute(self, job):
        try:

            def on_scan(run_id):
                self.link(job["id"], scan_id=run_id)

            result = (
                import_music(
                    self.settings,
                    full=bool(job["full"]),
                    on_import=lambda run_id: self.link(job["id"], import_id=run_id),
                    on_scan=on_scan,
                )
                if job["kind"] == "import"
                else scan_library(self.settings, full=bool(job["full"]), on_start=on_scan)
            )
            with self.database.connect(write=True) as connection:
                connection.execute(
                    "UPDATE admin_jobs SET status=?, finished_at=?, result=? WHERE id=?",
                    (result["status"], now(), json.dumps(result), job["id"]),
                )
        except ScanBusyError:
            with self.database.connect(write=True) as connection:
                connection.execute(
                    "UPDATE admin_jobs SET status='queued', started_at=NULL, error='waiting_for_library' WHERE id=?",
                    (job["id"],),
                )
        except Exception:
            logger.exception("Library management task failed")
            with self.database.connect(write=True) as connection:
                connection.execute(
                    "UPDATE admin_jobs SET status='failed', finished_at=?, error='task_failed' WHERE id=?",
                    (now(), job["id"]),
                )

    def work(self):
        lock = FileLock(self.settings.data_dir / "admin-worker.lock", timeout=0)
        while not self.stopping.is_set():
            try:
                with lock:
                    # This process owns the worker lock: previous running jobs lost their owner.
                    with self.database.connect(write=True) as connection:
                        connection.execute("BEGIN IMMEDIATE")
                        connection.execute(
                            """UPDATE scan_runs SET status='interrupted', finished_at=?
                            WHERE status='running' AND id IN (SELECT scan_id FROM admin_jobs
                            WHERE library_id=? AND status='running')""",
                            (now(), self.repository.library_id()),
                        )
                        connection.execute(
                            """UPDATE import_runs SET status='interrupted', finished_at=?
                            WHERE status='running' AND id IN (SELECT import_id FROM admin_jobs
                            WHERE library_id=? AND status='running')""",
                            (now(), self.repository.library_id()),
                        )
                        connection.execute(
                            "UPDATE admin_jobs SET status='interrupted', finished_at=?, error='worker_interrupted' WHERE library_id=? AND status='running'",
                            (now(), self.repository.library_id()),
                        )
                    while not self.stopping.is_set():
                        job = self.claim()
                        if job:
                            self.execute(job)
                        self.stopping.wait(0.5)
            except Timeout:
                self.stopping.wait(0.5)
            except (OSError, sqlite3.Error):
                logger.exception("Library worker temporarily unavailable")
                self.stopping.wait(1)

    def overview(self):
        def directory(path):
            try:
                with os.scandir(path) as entries:
                    next(entries, None)
                disk = shutil.disk_usage(path)
                return {
                    "path": str(path),
                    "available": True,
                    "free_bytes": disk.free,
                    "total_bytes": disk.total,
                }
            except OSError:
                return {
                    "path": str(path),
                    "available": False,
                    "free_bytes": None,
                    "total_bytes": None,
                }

        with self.database.connect() as connection:
            counts = connection.execute(
                "SELECT count(*) AS tracks, COALESCE(sum(size_bytes),0) AS size_bytes, sum(status != 'available') AS unavailable FROM tracks WHERE library_id=?",
                (self.repository.library_id(),),
            ).fetchone()
            schema = connection.execute("PRAGMA user_version").fetchone()[0]
            active = connection.execute(
                "SELECT id FROM admin_jobs WHERE library_id=? AND status IN ('queued','running')",
                (self.repository.library_id(),),
            ).fetchone()
        return {
            "active_job": active["id"] if active else None,
            "version": version("wildstring-backend"),
            "schema_version": schema,
            "preferences": self.preferences(),
            "counts": dict(counts),
            "albums": self.repository.albums(limit=1)["total"],
            "artists": self.repository.artists(limit=1)["total"],
            "source": directory(self.settings.music_dir),
            "library": directory(self.settings.library_dir),
            "data": directory(self.settings.data_dir),
            "last_scan": next(iter(self.repository.scans(1)), None),
            "deployment": {
                "host": self.settings.host,
                "port": self.settings.port,
                "cookie_secure": self.settings.cookie_secure,
                "source_readonly": True,
                "metadata_writeback": False,
            },
        }


def management_router(service, auth):
    router = APIRouter(prefix="/api/v1/manage", dependencies=[Depends(auth.require_session)])
    editor = MetadataEditor(service.repository)
    ai = AIService(service.settings.data_dir)

    @router.get("/ai")
    def ai_settings():
        return ai.get()

    @router.put("/ai", dependencies=[Depends(auth.require_client)])
    def update_ai(body: object = Body(...)):
        try:
            validated = AIUpdate.model_validate(body)
        except ValidationError:
            # Validation errors must not echo a submitted API key.
            raise HTTPException(422, "invalid_ai_settings") from None
        return ai.save(validated)

    @router.post("/ai/test", dependencies=[Depends(auth.require_client)])
    def test_ai():
        return ai.probe()

    @router.get("/overview")
    def overview(request: Request):
        result = service.overview()
        address = request.scope.get("server")
        if address:
            result["deployment"].update(host=address[0], port=address[1])
        return result

    @router.put("/preferences", dependencies=[Depends(auth.require_client)])
    def preferences(body: PreferencesUpdate):
        return service.update_preferences(body)

    @router.get("/jobs")
    def jobs(
        limit: Annotated[int, Query(ge=1, le=100)] = 20, offset: Annotated[int, Query(ge=0)] = 0
    ):
        return service.jobs(limit, offset)

    @router.post("/jobs", status_code=202, dependencies=[Depends(auth.require_client)])
    def submit(body: JobRequest):
        return service.submit(body)

    @router.get("/jobs/{job_id}")
    def job(job_id: str):
        return service.job(job_id)

    @router.get("/tracks/{track_id}/metadata")
    def metadata(track_id: str):
        return editor.read(track_id)

    @router.put("/tracks/{track_id}/metadata", dependencies=[Depends(auth.require_client)])
    def update_metadata(track_id: str, body: MetadataUpdate):
        return editor.save(track_id, body)

    return router
