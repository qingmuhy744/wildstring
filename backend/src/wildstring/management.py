"""Authenticated management and a durable, single-consumer library task queue."""

import json
import logging
import os
import shutil
import sqlite3
import time
from importlib.metadata import version
from pathlib import PurePosixPath
from threading import Event, Thread
from typing import Annotated, Literal
from uuid import uuid4

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request
from filelock import FileLock, Timeout
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from wildstring.ai_config import AIService, AIUpdate
from wildstring.album_release_locks import ReleaseLockInput
from wildstring.diagnostics import record_event, trace_context
from wildstring.library.edits import MetadataEditor, MetadataUpdate, Overrides
from wildstring.library.importer import import_music
from wildstring.library.intake import Intake, IntakeApproval, IntakeSettings
from wildstring.library.lyric_edits import LyricsEditor, LyricsText, LyricsUpdate
from wildstring.library.repository import now
from wildstring.library.scanner import ScanBusyError, scan_library
from wildstring.task_notifications import management_result

logger = logging.getLogger(__name__)


class JobRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["import", "scan"]
    full: bool = Field(default=False, strict=True)


class PreferencesUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    name: str = Field(min_length=1, max_length=100)
    version: int = Field(ge=1, strict=True)


def validate_folder(value: str) -> str:
    path = PurePosixPath(value)
    if value.startswith("/") or ".." in path.parts:
        raise ValueError("invalid_folder")
    return path.as_posix()


class FolderTrackUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    track_id: str = Field(min_length=1, max_length=128)
    version: int = Field(ge=1, strict=True)


class FolderMetadataUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    folder: str = Field(min_length=1, max_length=4096)
    tracks: list[FolderTrackUpdate] = Field(min_length=1, max_length=1000)
    overrides: Overrides

    @field_validator("folder")
    @classmethod
    def valid_folder(cls, value: str) -> str:
        return validate_folder(value)


class AlbumMetadataUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    album_id: str = Field(min_length=1, max_length=128)
    tracks: list[FolderTrackUpdate] = Field(min_length=1, max_length=1000)
    overrides: Overrides


class Management:
    def __init__(self, settings, repository):
        self.settings, self.repository = settings, repository
        self.database = repository.database
        self.stopping = Event()
        self.thread = None
        self.worker_lock = FileLock(
            settings.data_dir / "admin-worker.lock", timeout=0, thread_local=False
        )
        self.storage_identity = None
        self.intake = Intake(settings, repository)
        self.next_discovery = 0

    def start(self):
        self.repository.library_id(create=True)
        info = self.settings.data_dir.stat()
        self.storage_identity = (info.st_dev, info.st_ino)
        # Acquire before exposing the API: FileLock otherwise may recreate a lost parent.
        try:
            self.worker_lock.acquire()
        except Timeout:
            logger.info("Library worker lock is held; waiting for the current owner")
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

    def submit(self, body, *, automatic=False):
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
                "INSERT INTO admin_jobs(id,library_id,kind,full,status,created_at,automatic) VALUES (?,?,?,?,'queued',?,?)",
                (job_id, library_id, body.kind, body.full, now(), automatic),
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

    def metadata_folders(self, limit=100, offset=0, folder=None):
        """Group managed tracks by their relative parent folder for batch editing."""
        library_id = self.repository.library_id()
        with self.database.connect() as connection:
            rows = connection.execute(
                """SELECT t.id,t.path,t.title,t.album,t.album_artists,t.artists,t.track_number,
                t.disc_number,m.version,m.observed,m.overrides
                FROM tracks t JOIN track_metadata m ON m.track_id=t.id
                WHERE t.library_id=? AND t.status='available' ORDER BY t.path,t.id""",
                (library_id,),
            ).fetchall()
        grouped = {}
        for row in rows:
            parent = PurePosixPath(row["path"]).parent.as_posix()
            if folder is not None and parent != folder:
                continue
            current = json.loads(row["observed"]) | json.loads(row["overrides"])
            item = {
                "track_id": row["id"],
                "title": row["title"],
                "album": row["album"],
                "album_artists": json.loads(row["album_artists"]),
                "artists": json.loads(row["artists"]),
                "track_number": row["track_number"],
                "disc_number": row["disc_number"],
                "metadata_version": row["version"],
                "metadata": current,
            }
            group = grouped.setdefault(
                parent,
                {"folder": parent, "tracks": [], "albums": set(), "album_artists": set()},
            )
            group["tracks"].append(item)
            group["albums"].add(row["album"] or "")
            group["album_artists"].update(json.loads(row["album_artists"]))
        values = []
        for group in grouped.values():
            albums = sorted(value for value in group.pop("albums") if value)
            artists = sorted(value for value in group.pop("album_artists") if value)
            group.update(
                {
                    "track_count": len(group["tracks"]),
                    "album_variants": albums,
                    "album_artist_variants": artists,
                    "warning": len(albums) > 1 or len(artists) > 1,
                }
            )
            values.append(group)
        values.sort(key=lambda item: item["folder"])
        if folder is not None:
            return values[0] if values else None
        return {
            "items": [
                {key: value for key, value in item.items() if key != "tracks"}
                for item in values[offset : offset + limit]
            ],
            "total": len(values),
            "limit": limit,
            "offset": offset,
        }

    def update_metadata_folder(self, body, *, user_id="admin"):
        group = self.metadata_folders(folder=body.folder)
        if group is None:
            raise HTTPException(404, "folder_not_found")
        requested = {item.track_id: item.version for item in body.tracks}
        available = {item["track_id"]: item for item in group["tracks"]}
        if set(requested) - set(available):
            raise HTTPException(409, "folder_membership_changed")
        editor = MetadataEditor(self.repository)
        with self.database.connect(write=True) as connection:
            connection.execute("BEGIN IMMEDIATE")
            for track_id, version_number in requested.items():
                editor.save_in_transaction(
                    connection,
                    track_id,
                    MetadataUpdate(version=version_number, overrides=body.overrides),
                    user_id=user_id,
                    source="folder-batch",
                )
        return {
            "folder": body.folder,
            "updated": len(requested),
            "album_variants": self.metadata_folders(folder=body.folder)["album_variants"],
        }

    def metadata_album(self, album_id):
        library_id = self.repository.library_id()
        with self.database.connect() as connection:
            rows = connection.execute(
                """SELECT t.id,t.path,t.title,t.album,t.album_artists,t.artists,t.track_number,
                t.disc_number,m.version,m.observed,m.overrides
                FROM tracks t JOIN track_metadata m ON m.track_id=t.id
                WHERE t.library_id=? AND t.album_id=? AND t.status='available'
                ORDER BY t.disc_number,t.track_number,t.path,t.id""",
                (library_id, album_id),
            ).fetchall()
        if not rows:
            return None
        tracks = []
        albums = set()
        album_artists = set()
        for row in rows:
            current = json.loads(row["observed"]) | json.loads(row["overrides"])
            tracks.append(
                {
                    "track_id": row["id"],
                    "title": row["title"],
                    "album": row["album"],
                    "album_artists": json.loads(row["album_artists"]),
                    "artists": json.loads(row["artists"]),
                    "track_number": row["track_number"],
                    "disc_number": row["disc_number"],
                    "metadata_version": row["version"],
                    "metadata": current,
                }
            )
            if row["album"]:
                albums.add(row["album"])
            album_artists.update(json.loads(row["album_artists"]))
        return {
            "album_id": album_id,
            "tracks": tracks,
            "album_variants": sorted(albums),
            "album_artist_variants": sorted(album_artists),
            "warning": len(albums) > 1 or len(album_artists) > 1,
        }

    def update_metadata_album(self, body, *, user_id="admin"):
        group = self.metadata_album(body.album_id)
        if group is None:
            raise HTTPException(404, "album_not_found")
        requested = {item.track_id: item.version for item in body.tracks}
        available = {item["track_id"]: item for item in group["tracks"]}
        if set(requested) - set(available):
            raise HTTPException(409, "album_membership_changed")
        editor = MetadataEditor(self.repository)
        with self.database.connect(write=True) as connection:
            connection.execute("BEGIN IMMEDIATE")
            for track_id, version_number in requested.items():
                editor.save_in_transaction(
                    connection,
                    track_id,
                    MetadataUpdate(version=version_number, overrides=body.overrides),
                    user_id=user_id,
                    source="album-batch",
                )
        return {"album_id": body.album_id, "updated": len(requested)}

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
                    automatic=bool(job["automatic"]),
                )
                if job["kind"] == "import"
                else scan_library(self.settings, full=bool(job["full"]), on_start=on_scan)
            )
            with self.database.connect(write=True) as connection:
                connection.execute(
                    "UPDATE admin_jobs SET status=?, finished_at=?, result=? WHERE id=?",
                    (result["status"], now(), json.dumps(result), job["id"]),
                )
                management_result(self, connection, job, result["status"])
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
                management_result(self, connection, job, "failed")

    def work(self):
        while not self.stopping.is_set():
            try:
                self.check_storage()
                if not self.worker_lock.is_locked:
                    self.worker_lock.acquire()
                try:
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
                        self.check_storage()
                        job = self.claim()
                        if job:
                            with trace_context(
                                job["id"].replace("-", ""),
                                task_id=job["id"],
                                sink=getattr(self, "diagnostics", None),
                            ):
                                record_event("library.task.started", operation=job["kind"])
                                self.execute(job)
                                record_event(
                                    "library.task.finished", stage=self.job(job["id"])["status"]
                                )
                        if time.monotonic() >= self.next_discovery:
                            self.next_discovery = (
                                time.monotonic() + self.intake.preferences()["interval_seconds"]
                            )
                            try:
                                if self.intake.has_work():
                                    self.submit(JobRequest(kind="import"), automatic=True)
                            except HTTPException as error:
                                if error.status_code != 409:
                                    raise
                                self.next_discovery = time.monotonic() + 1
                            except OSError:
                                logger.warning("Automatic import source is unavailable; will retry")
                        self.stopping.wait(0.5)
                finally:
                    self.worker_lock.release(force=True)
            except Timeout:
                self.stopping.wait(0.5)
            except (OSError, sqlite3.Error):
                logger.exception("Library worker temporarily unavailable")
                self.stopping.wait(1)
        self.worker_lock.release(force=True)

    def check_storage(self):
        info = self.settings.data_dir.stat()
        if (info.st_dev, info.st_ino) != self.storage_identity:
            raise OSError("Runtime directory changed; restore it or restart the service")

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


def management_router(service, auth, providers=None):
    router = APIRouter(prefix="/api/v1/manage", dependencies=[Depends(auth.require_admin)])
    editor = MetadataEditor(service.repository)
    lyrics = LyricsEditor(service.repository)
    ai = AIService(service.settings.data_dir, providers)

    @router.get("/intake/settings")
    def intake_settings():
        return service.intake.preferences()

    @router.put("/intake/settings", dependencies=[Depends(auth.require_client)])
    def configure_intake(body: IntakeSettings):
        result = service.intake.configure(body)
        service.next_discovery = 0
        return result

    @router.get("/intake/items")
    def intake_items(
        limit: Annotated[int, Query(ge=1, le=100)] = 50, offset: Annotated[int, Query(ge=0)] = 0
    ):
        return service.intake.items(limit, offset)

    @router.post("/intake/items/{item_id}/approve", dependencies=[Depends(auth.require_client)])
    def approve_intake(item_id: str, body: IntakeApproval):
        result = service.intake.approve(item_id, body)
        service.next_discovery = 0
        try:
            service.submit(JobRequest(kind="import"), automatic=True)
        except HTTPException as error:
            if error.status_code != 409:
                raise
        return result

    @router.post("/intake/items/{item_id}/ignore", dependencies=[Depends(auth.require_client)])
    def ignore_intake(item_id: str, body: Annotated[dict, Body()]):
        if set(body) != {"version"} or type(body["version"]) is not int or body["version"] < 1:
            raise HTTPException(422, "invalid_version")
        return service.intake.ignore(item_id, body["version"])

    @router.post("/intake/items/{item_id}/retry", dependencies=[Depends(auth.require_client)])
    def retry_intake(item_id: str, body: Annotated[dict, Body()]):
        if set(body) != {"version"} or type(body["version"]) is not int or body["version"] < 1:
            raise HTTPException(422, "invalid_version")
        with service.database.connect(write=True) as connection:
            result = connection.execute(
                "UPDATE intake_items SET state='retry',version=version+1 WHERE id=? AND library_id=? AND state='failed' AND version=?",
                (item_id, service.repository.library_id(), body["version"]),
            )
            if not result.rowcount:
                raise HTTPException(409, "metadata_version_conflict")
        service.next_discovery = 0
        try:
            service.submit(JobRequest(kind="import"), automatic=True)
        except HTTPException as error:
            if error.status_code != 409:
                raise
        return service.intake.public(service.intake.item(item_id))

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

    @router.get("/metadata/folders")
    def metadata_folders(
        limit: Annotated[int, Query(ge=1, le=200)] = 100,
        offset: Annotated[int, Query(ge=0)] = 0,
        folder: str | None = None,
    ):
        if folder is not None:
            folder = validate_folder(folder)
        return service.metadata_folders(limit, offset, folder)

    @router.put("/metadata/folders", dependencies=[Depends(auth.require_client)])
    def update_metadata_folder(
        body: FolderMetadataUpdate, user: Annotated[dict, Depends(auth.require_admin)]
    ):
        return service.update_metadata_folder(body, user_id=user["id"])

    @router.get("/metadata/albums")
    def metadata_album(album_id: Annotated[str, Query(min_length=1, max_length=128)]):
        result = service.metadata_album(album_id)
        if result is None:
            raise HTTPException(404, "album_not_found")
        return result

    @router.put("/metadata/albums", dependencies=[Depends(auth.require_client)])
    def update_metadata_album(
        body: AlbumMetadataUpdate, user: Annotated[dict, Depends(auth.require_admin)]
    ):
        return service.update_metadata_album(body, user_id=user["id"])

    @router.get("/tracks/{track_id}/metadata")
    def metadata(track_id: str):
        return editor.read(track_id)

    @router.put("/tracks/{track_id}/metadata", dependencies=[Depends(auth.require_client)])
    def update_metadata(
        track_id: str, body: MetadataUpdate, user: Annotated[dict, Depends(auth.require_admin)]
    ):
        return editor.save(track_id, body, user_id=user["id"])

    @router.get("/albums/{album_id}/release-lock")
    def album_release_lock(album_id: str):
        with service.database.connect() as connection:
            from wildstring.album_release_locks import read

            result = read(connection, service.repository.library_id(), album_id)
        return result or {"album_id": album_id, "locked": False}

    @router.put("/albums/{album_id}/release-lock", dependencies=[Depends(auth.require_client)])
    def save_album_release_lock(album_id: str, body: ReleaseLockInput):
        with service.database.connect(write=True) as connection:
            connection.execute("BEGIN IMMEDIATE")
            from wildstring.album_release_locks import save

            result = save(connection, service.repository.library_id(), album_id, body)
        return result | {"locked": True}

    @router.delete("/albums/{album_id}/release-lock", dependencies=[Depends(auth.require_client)])
    def clear_album_release_lock(album_id: str, version: Annotated[int | None, Query(ge=1)] = None):
        with service.database.connect(write=True) as connection:
            connection.execute("BEGIN IMMEDIATE")
            from wildstring.album_release_locks import clear

            return clear(connection, service.repository.library_id(), album_id, version)

    @router.get("/tracks/{track_id}/lyrics")
    def read_lyrics(track_id: str):
        return lyrics.read(track_id)

    @router.post("/tracks/{track_id}/lyrics/preview", dependencies=[Depends(auth.require_client)])
    def preview_lyrics(track_id: str, body: LyricsText):
        return lyrics.preview(track_id, body)

    @router.put("/tracks/{track_id}/lyrics", dependencies=[Depends(auth.require_client)])
    def update_lyrics(track_id: str, body: LyricsUpdate):
        return lyrics.save(track_id, body)

    return router
