"""Authenticated management and a durable, single-consumer library task queue."""

import hashlib
import json
import logging
import os
import re
import shutil
import sqlite3
import time
from datetime import datetime
from pathlib import Path, PurePosixPath
from tempfile import NamedTemporaryFile
from threading import Event, Thread
from typing import Annotated, Literal
from uuid import uuid4

from fastapi import APIRouter, Body, Depends, File, Form, HTTPException, Query, Request, UploadFile
from filelock import FileLock, Timeout
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from wildstring import get_app_version
from wildstring.ai_config import AIService, AIUpdate
from wildstring.album_release_locks import ReleaseLockInput
from wildstring.diagnostics import record_event, trace_context
from wildstring.library.assets import MAX_COVER_BYTES, TrackAssets
from wildstring.library.download_policy import partial
from wildstring.library.edits import MetadataEditor, MetadataUpdate, Overrides
from wildstring.library.importer import import_music
from wildstring.library.intake import INPUT_SUFFIXES, Intake, IntakeApproval, IntakeSettings
from wildstring.library.lyric_edits import LyricsEditor, LyricsText, LyricsUpdate
from wildstring.library.repository import now
from wildstring.library.scanner import ScanBusyError, scan_library
from wildstring.recommendations import DAY_ZONE, Recommendations
from wildstring.task_notifications import management_result

logger = logging.getLogger(__name__)


class JobRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["import", "scan"]
    full: bool = Field(default=False, strict=True)
    path: str = "."

    @field_validator("path")
    @classmethod
    def valid_path(cls, value: str) -> str:
        return validate_folder(value) if value != "." else "."


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
    tracks: list[FolderTrackUpdate] | None = None
    overrides: Overrides


class SourcePathRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    source_id: Literal["import"] = "import"
    path: str = "."

    @field_validator("path")
    @classmethod
    def valid_path(cls, value: str) -> str:
        return validate_folder(value) if value != "." else "."


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
        self.next_recommendation = 0
        self.recommendation_inflight: set[str] = set()

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
                if (
                    active["kind"] == body.kind
                    and bool(active["full"]) == body.full
                    and active["scope_path"] == body.path
                ):
                    return self.job(active["id"])
                raise HTTPException(409, "library_task_busy")
            job_id = uuid4().hex
            connection.execute(
                "INSERT INTO admin_jobs(id,library_id,kind,full,status,created_at,automatic,scope_path) VALUES (?,?,?,?,'queued',?,?,?)",
                (job_id, library_id, body.kind, body.full, now(), automatic, body.path),
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
                t.disc_number,t.has_cover,m.version,m.observed,m.overrides,a.filename AS custom_cover
                FROM tracks t
                JOIN track_metadata m ON m.track_id=t.id
                LEFT JOIN artwork_choices a ON a.track_id=t.id
                WHERE t.library_id=? AND t.album_id=? AND t.status='available'
                ORDER BY coalesce(t.disc_number,1),coalesce(t.track_number,99999),t.path,t.id""",
                (library_id, album_id),
            ).fetchall()
        if not rows:
            return None
        tracks = []
        albums = set()
        album_artists = set()
        discs = set()
        genres = set()
        cover_track_id = None
        has_custom_cover = False
        release_date = ""
        original_date = ""
        label = ""
        catalog_number = ""
        description = ""
        disc_total = 1

        for row in rows:
            current = json.loads(row["observed"]) | json.loads(row["overrides"])
            if row["has_cover"] and cover_track_id is None:
                cover_track_id = row["id"]
            if row["custom_cover"]:
                has_custom_cover = True
            if row["disc_number"]:
                discs.add(row["disc_number"])
                if row["disc_number"] > disc_total:
                    disc_total = row["disc_number"]
            if current.get("disc_total") and current["disc_total"] > disc_total:
                disc_total = current["disc_total"]
            if not release_date and current.get("release_date"):
                release_date = current["release_date"]
            if not original_date and current.get("original_date"):
                original_date = current["original_date"]
            if not label and current.get("label"):
                label = current["label"]
            if not catalog_number and current.get("catalog_number"):
                catalog_number = current["catalog_number"]
            if not description and current.get("description"):
                description = current["description"]
            if current.get("genres"):
                genres.update(current["genres"])

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
                    "has_cover": bool(row["has_cover"]),
                    "custom_cover": row["custom_cover"],
                }
            )
            if row["album"]:
                albums.add(row["album"])
            album_artists.update(json.loads(row["album_artists"]))

        if cover_track_id is None and tracks:
            cover_track_id = tracks[0]["track_id"]

        primary_title = (
            next(iter(albums), "") if len(albums) == 1 else (tracks[0]["album"] if tracks else "")
        )
        primary_artists = (
            list(album_artists)
            if len(album_artists) > 0
            else (tracks[0]["album_artists"] if tracks else [])
        )

        return {
            "album_id": album_id,
            "primary_title": primary_title,
            "primary_artists": primary_artists,
            "cover_track_id": cover_track_id,
            "has_custom_cover": has_custom_cover,
            "release_date": release_date,
            "original_date": original_date,
            "label": label,
            "catalog_number": catalog_number,
            "disc_total": disc_total,
            "discs": sorted(discs) if discs else [1],
            "genres": sorted(genres),
            "description": description,
            "tracks": tracks,
            "album_variants": sorted(albums),
            "album_artist_variants": sorted(album_artists),
            "warning": len(albums) > 1 or len(album_artists) > 1,
        }

    def update_album_cover(
        self, album_id: str, file_bytes: bytes, filename: str, save_sidecar: bool = True
    ):
        if len(file_bytes) > MAX_COVER_BYTES:
            raise HTTPException(413, "cover_too_large")
        assets = TrackAssets(self.repository)
        if assets.thumbnail(file_bytes, 320) is None:
            raise HTTPException(422, "invalid_cover_image")

        artwork_folder = self.database.path.parent / "artwork"
        artwork_folder.mkdir(parents=True, exist_ok=True)
        key = hashlib.sha256(file_bytes).hexdigest()
        with NamedTemporaryFile(dir=artwork_folder, delete=False) as stream:
            temp_path = Path(stream.name)
            try:
                stream.write(file_bytes)
                stream.flush()
                os.fsync(stream.fileno())
                temp_path.replace(artwork_folder / key)
            finally:
                temp_path.unlink(missing_ok=True)

        with self.database.connect(write=True) as connection:
            connection.execute("BEGIN IMMEDIATE")
            tracks = connection.execute(
                "SELECT id, path FROM tracks WHERE album_id=? AND library_id=? AND status='available'",
                (album_id, self.repository.library_id()),
            ).fetchall()
            if not tracks:
                raise HTTPException(404, "album_not_found")

            for track in tracks:
                connection.execute(
                    "INSERT INTO artwork_choices(track_id,filename,source_url,mode) VALUES (?,?,'upload','chosen') "
                    "ON CONFLICT(track_id) DO UPDATE SET filename=excluded.filename,source_url=excluded.source_url,"
                    "mode='chosen',version=artwork_choices.version+1",
                    (track["id"], key),
                )
                connection.execute("UPDATE tracks SET has_cover=1 WHERE id=?", (track["id"],))
                connection.execute(
                    "UPDATE track_metadata SET version=version+1 WHERE track_id=?", (track["id"],)
                )

        if save_sidecar:
            self._save_album_sidecar_cover(tracks, file_bytes)

        return {"album_id": album_id, "image_sha256": key, "tracks_updated": len(tracks)}

    def remove_album_cover(self, album_id: str):
        with self.database.connect(write=True) as connection:
            connection.execute("BEGIN IMMEDIATE")
            tracks = connection.execute(
                "SELECT id FROM tracks WHERE album_id=? AND library_id=? AND status='available'",
                (album_id, self.repository.library_id()),
            ).fetchall()
            if not tracks:
                raise HTTPException(404, "album_not_found")
            for track in tracks:
                connection.execute("DELETE FROM artwork_choices WHERE track_id=?", (track["id"],))
                # 重新判断是否有内嵌封面或者同目录本地封面，若无则设为 0
                connection.execute("UPDATE tracks SET has_cover=0 WHERE id=?", (track["id"],))
                connection.execute(
                    "UPDATE track_metadata SET version=version+1 WHERE track_id=?", (track["id"],)
                )
        return {"album_id": album_id, "cleared": True}

    def _save_album_sidecar_cover(self, tracks, file_bytes: bytes):
        library_root = self.repository.root.resolve()
        dirs = set()
        for track in tracks:
            track_rel = Path(track["path"])
            parent = track_rel.parent
            if re.fullmatch(r"(?i)(cd|disc|disk)[\s_-]*\d+", parent.name):
                dirs.add(parent.parent)
            else:
                dirs.add(parent)
        for rel_dir in dirs:
            target_dir = (library_root / rel_dir).resolve()
            if target_dir.is_relative_to(library_root) and target_dir.is_dir():
                try:
                    cover_file = target_dir / "cover.jpg"
                    cover_file.write_bytes(file_bytes)
                except OSError:
                    # Ignore write failures when writing album covers to non-writable directories
                    pass

    def source_roots(self):
        return [{"id": "import", "name": "导入目录", "read_only": True}]

    def source_folders(self, source_id="import", path="."):
        if source_id != "import":
            raise HTTPException(404, "source_not_found")
        relative = Path(".") if path == "." else Path(validate_folder(path))
        root = self.settings.music_dir.resolve()
        directory = (root / relative).resolve()
        if not directory.is_relative_to(root) or not directory.is_dir():
            raise HTTPException(404, "source_folder_not_found")
        policy = self.intake.preferences()["download_policy"]
        entries = []
        for entry in sorted(
            directory.iterdir(), key=lambda item: (not item.is_dir(), item.name.casefold())
        ):
            if entry.is_symlink() or entry.name.startswith("."):
                continue
            entry_path = (relative / entry.name).as_posix()
            if entry.is_dir():
                entries.append({"name": entry.name, "path": entry_path, "kind": "folder"})
                continue
            pending_download = partial(entry.name, policy)
            entries.append(
                {
                    "name": entry.name,
                    "path": entry_path,
                    "kind": "file",
                    "importable": entry.suffix.lower() in INPUT_SUFFIXES and not pending_download,
                    "pending": pending_download,
                }
            )
        return {"source_id": source_id, "path": path, "items": entries}

    def import_preview(self, body):
        if body.source_id != "import":
            raise HTTPException(404, "source_not_found")
        folder = Path(".") if body.path == "." else Path(validate_folder(body.path))
        root = self.settings.music_dir.resolve()
        directory = (root / folder).resolve()
        if not directory.is_relative_to(root) or not directory.is_dir():
            raise HTTPException(404, "source_folder_not_found")
        files = [
            relative.as_posix()
            for relative in self.intake.paths()
            if folder == Path(".") or relative == folder or folder in relative.parents
        ]
        return {
            "source_id": body.source_id,
            "path": body.path,
            "files": files,
            "count": len(files),
            "pending_markers": [
                item["path"]
                for item in self.source_folders(body.source_id, body.path)["items"]
                if item.get("pending")
            ],
        }

    def trash_album(self, album_id, *, user_id):
        library_id = self.repository.library_id()
        with self.database.connect() as connection:
            rows = connection.execute(
                "SELECT id,path FROM tracks WHERE library_id=? AND album_id=? AND status='available' ORDER BY path",
                (library_id, album_id),
            ).fetchall()
        if not rows:
            raise HTTPException(404, "album_not_found")
        identity = uuid4().hex
        trash_root = self.settings.data_dir / "trash" / identity
        root = self.settings.library_dir.resolve()
        entries = []
        moved: list[tuple[Path, Path]] = []
        trash_root.mkdir(parents=True, exist_ok=False)
        try:
            for row in rows:
                original = Path(row["path"])
                source = (root / original).resolve(strict=False)
                if not source.is_relative_to(root) or not source.is_file():
                    continue
                destination = trash_root / original
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.move(str(source), str(destination))
                moved.append((source, destination))
                entries.append({"track_id": row["id"], "path": original.as_posix()})
            if not entries:
                raise HTTPException(409, "managed_copy_missing")
            with self.database.connect(write=True) as connection:
                connection.execute("BEGIN IMMEDIATE")
                connection.execute(
                    "INSERT INTO library_trash(id,library_id,album_id,entries,created_at,created_by) VALUES (?,?,?,?,?,?)",
                    (identity, library_id, album_id, json.dumps(entries), now(), user_id),
                )
                connection.executemany(
                    "UPDATE tracks SET status='missing' WHERE id=? AND library_id=?",
                    [(entry["track_id"], library_id) for entry in entries],
                )
        except BaseException:
            for source, destination in reversed(moved):
                if destination.exists() and not source.exists():
                    source.parent.mkdir(parents=True, exist_ok=True)
                    shutil.move(str(destination), str(source))
            if trash_root.exists():
                shutil.rmtree(trash_root, ignore_errors=True)
            raise
        return {"id": identity, "album_id": album_id, "tracks": len(entries), "status": "trashed"}

    def restore_trash(self, identity):
        library_id = self.repository.library_id()
        with self.database.connect() as connection:
            row = connection.execute(
                "SELECT * FROM library_trash WHERE id=? AND library_id=? AND status='trashed'",
                (identity, library_id),
            ).fetchone()
        if row is None:
            raise HTTPException(404, "trash_not_found")
        root = self.settings.library_dir.resolve()
        trash_root = self.settings.data_dir / "trash" / identity
        entries = json.loads(row["entries"])
        moved: list[tuple[Path, Path]] = []
        for entry in entries:
            source = trash_root / entry["path"]
            destination = (root / entry["path"]).resolve(strict=False)
            if not destination.is_relative_to(root) or not source.is_file() or destination.exists():
                raise HTTPException(409, "trash_restore_conflict")
        with self.database.connect(write=True) as connection:
            try:
                connection.execute("BEGIN IMMEDIATE")
                for entry in entries:
                    source = trash_root / entry["path"]
                    destination = root / entry["path"]
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    shutil.move(str(source), str(destination))
                    moved.append((source, destination))
                    connection.execute(
                        "UPDATE tracks SET status='available' WHERE id=? AND library_id=?",
                        (entry["track_id"], library_id),
                    )
                connection.execute(
                    "UPDATE library_trash SET status='restored' WHERE id=?", (identity,)
                )
            except BaseException:
                for source, destination in reversed(moved):
                    if destination.exists() and not source.exists():
                        source.parent.mkdir(parents=True, exist_ok=True)
                        shutil.move(str(destination), str(source))
                raise
        shutil.rmtree(trash_root, ignore_errors=True)
        return {"id": identity, "status": "restored", "tracks": len(entries)}

    def purge_trash(self, identity):
        library_id = self.repository.library_id()
        with self.database.connect(write=True) as connection:
            result = connection.execute(
                "UPDATE library_trash SET status='purged' WHERE id=? AND library_id=? AND status='trashed'",
                (identity, library_id),
            )
            if not result.rowcount:
                raise HTTPException(404, "trash_not_found")
        shutil.rmtree(self.settings.data_dir / "trash" / identity, ignore_errors=True)
        return {"id": identity, "status": "purged"}

    def update_metadata_album(self, body, *, user_id="admin"):
        group = self.metadata_album(body.album_id)
        if group is None:
            raise HTTPException(404, "album_not_found")
        if body.tracks is None:
            requested = {item["track_id"]: item["metadata_version"] for item in group["tracks"]}
        else:
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
                    relative_root=job.get("scope_path", "."),
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
                        if time.monotonic() >= self.next_recommendation:
                            self.next_recommendation = time.monotonic() + 30
                            self.generate_scheduled_recommendations()
                        self.stopping.wait(0.5)
                finally:
                    self.worker_lock.release(force=True)
            except Timeout:
                self.stopping.wait(0.5)
            except (OSError, sqlite3.Error):
                logger.exception("Library worker temporarily unavailable")
                self.stopping.wait(1)
        self.worker_lock.release(force=True)

    def generate_scheduled_recommendations(self):
        """Generate each account's opted-in daily list after its local clock time."""
        platform = getattr(self, "platform", None)
        providers = getattr(platform, "providers", None) if platform else None
        if platform is None or providers is None:
            return
        current = datetime.now(DAY_ZONE)
        day = current.date().isoformat()
        clock = current.strftime("%H:%M")
        with self.database.connect() as connection:
            rows = connection.execute(
                """SELECT p.user_id,p.library_id,p.daily_time FROM recommendation_preferences p
                JOIN users u ON u.id=p.user_id
                WHERE p.library_id=? AND p.daily_enabled=1 AND u.enabled=1""",
                (self.repository.library_id(),),
            ).fetchall()
        for row in rows:
            identity = row["user_id"]
            if identity in self.recommendation_inflight or clock < row["daily_time"]:
                continue
            with self.database.connect() as connection:
                cached = connection.execute(
                    "SELECT day FROM recommendation_daily WHERE user_id=? AND library_id=?",
                    (identity, row["library_id"]),
                ).fetchone()
            if cached and cached["day"] == day:
                continue
            self.recommendation_inflight.add(identity)
            try:
                repository = self.repository.for_user(identity)
                Recommendations(repository, providers, platform).daily(repository, refresh=True)
            except Exception:
                logger.exception("Scheduled daily recommendation failed for account %s", identity)
            finally:
                self.recommendation_inflight.discard(identity)

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
            "version": get_app_version(),
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
    # The management shell is visible to librarian/editor profiles; sensitive
    # settings and account operations still have their own owner check.
    inspect = Depends(auth.require_permission("library:inspect"))
    router = APIRouter(prefix="/api/v1/manage", dependencies=[inspect])
    editor = MetadataEditor(service.repository)
    lyrics = LyricsEditor(service.repository)
    ai = AIService(service.settings.data_dir, providers)

    @router.get("/intake/settings")
    def intake_settings():
        return service.intake.preferences()

    @router.put(
        "/intake/settings",
        dependencies=[
            Depends(auth.require_client),
            Depends(auth.require_permission("library:import")),
        ],
    )
    def configure_intake(body: IntakeSettings):
        result = service.intake.configure(body)
        service.next_discovery = 0
        return result

    @router.get("/intake/items")
    def intake_items(
        limit: Annotated[int, Query(ge=1, le=100)] = 50, offset: Annotated[int, Query(ge=0)] = 0
    ):
        return service.intake.items(limit, offset)

    @router.post(
        "/intake/items/{item_id}/approve",
        dependencies=[
            Depends(auth.require_client),
            Depends(auth.require_permission("library:import")),
        ],
    )
    def approve_intake(item_id: str, body: IntakeApproval):
        result = service.intake.approve(item_id, body)
        service.next_discovery = 0
        try:
            service.submit(JobRequest(kind="import"), automatic=True)
        except HTTPException as error:
            if error.status_code != 409:
                raise
        return result

    @router.post(
        "/intake/items/{item_id}/ignore",
        dependencies=[
            Depends(auth.require_client),
            Depends(auth.require_permission("library:import")),
        ],
    )
    def ignore_intake(item_id: str, body: Annotated[dict, Body()]):
        if set(body) != {"version"} or type(body["version"]) is not int or body["version"] < 1:
            raise HTTPException(422, "invalid_version")
        return service.intake.ignore(item_id, body["version"])

    @router.post(
        "/intake/items/{item_id}/retry",
        dependencies=[
            Depends(auth.require_client),
            Depends(auth.require_permission("library:import")),
        ],
    )
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

    @router.get("/ai", dependencies=[Depends(auth.require_owner)])
    def ai_settings():
        return ai.get()

    @router.put("/ai", dependencies=[Depends(auth.require_client), Depends(auth.require_owner)])
    def update_ai(body: object = Body(...)):
        try:
            validated = AIUpdate.model_validate(body)
        except ValidationError:
            # Validation errors must not echo a submitted API key.
            raise HTTPException(422, "invalid_ai_settings") from None
        return ai.save(validated)

    @router.post(
        "/ai/test", dependencies=[Depends(auth.require_client), Depends(auth.require_owner)]
    )
    def test_ai():
        return ai.probe()

    @router.get("/overview")
    def overview(request: Request):
        result = service.overview()
        address = request.scope.get("server")
        if address:
            result["deployment"].update(host=address[0], port=address[1])
        return result

    @router.put(
        "/preferences", dependencies=[Depends(auth.require_client), Depends(auth.require_owner)]
    )
    def preferences(body: PreferencesUpdate):
        return service.update_preferences(body)

    @router.get("/jobs")
    def jobs(
        limit: Annotated[int, Query(ge=1, le=100)] = 20, offset: Annotated[int, Query(ge=0)] = 0
    ):
        return service.jobs(limit, offset)

    @router.post(
        "/jobs",
        status_code=202,
        dependencies=[
            Depends(auth.require_client),
            Depends(auth.require_permission("tasks:control")),
        ],
    )
    def submit(body: JobRequest):
        return service.submit(body)

    @router.get("/jobs/{job_id}")
    def job(job_id: str):
        return service.job(job_id)

    @router.get("/library/sources")
    def library_sources():
        return {"items": service.source_roots()}

    @router.get("/library/folders")
    def library_folders(source_id: Literal["import"] = "import", path: str = "."):
        return service.source_folders(source_id, validate_folder(path) if path != "." else ".")

    @router.post(
        "/library/import/preview",
        dependencies=[
            Depends(auth.require_client),
            Depends(auth.require_permission("library:import")),
        ],
    )
    def library_import_preview(body: SourcePathRequest):
        return service.import_preview(body)

    @router.post(
        "/library/import",
        status_code=202,
        dependencies=[
            Depends(auth.require_client),
            Depends(auth.require_permission("library:import")),
        ],
    )
    def library_import(body: SourcePathRequest):
        return service.submit(JobRequest(kind="import", path=body.path)) | {
            "source_id": body.source_id,
            "path": body.path,
        }

    @router.post(
        "/library/upload",
        dependencies=[
            Depends(auth.require_client),
            Depends(auth.require_permission("library:import")),
        ],
    )
    def library_upload(
        file: Annotated[UploadFile, File()],
        relative_path: Annotated[str, Form()] = "",
        auto_scan: Annotated[bool, Form()] = False,
        override_artist: Annotated[str, Form()] = "",
        override_album: Annotated[str, Form()] = "",
    ):
        from wildstring.library.upload import handle_upload

        return handle_upload(
            service.settings,
            service.database,
            file,
            relative_path_raw=relative_path,
            override_artist=override_artist or None,
            override_album=override_album or None,
            auto_scan=auto_scan,
        )

    @router.post(
        "/library/scan",
        dependencies=[
            Depends(auth.require_client),
            Depends(auth.require_permission("library:import")),
        ],
    )
    def library_scan():
        from wildstring.library.scanner import scan_library

        return scan_library(service.settings)

    @router.get("/library/trash")
    def library_trash():
        with service.database.connect() as connection:
            rows = connection.execute(
                "SELECT id,album_id,created_at,created_by,status,json_array_length(entries) AS tracks "
                "FROM library_trash WHERE library_id=? ORDER BY created_at DESC",
                (service.repository.library_id(),),
            ).fetchall()
        return {"items": [dict(row) for row in rows]}

    @router.post(
        "/albums/{album_id}/trash",
        status_code=202,
        dependencies=[
            Depends(auth.require_client),
            Depends(auth.require_permission("library:delete")),
        ],
    )
    def trash_album(
        album_id: str, user: Annotated[dict, Depends(auth.require_permission("library:delete"))]
    ):
        return service.trash_album(album_id, user_id=user["id"])

    @router.post(
        "/library/trash/{identity}/restore",
        dependencies=[
            Depends(auth.require_client),
            Depends(auth.require_permission("library:delete")),
        ],
    )
    def restore_trash(identity: str):
        return service.restore_trash(identity)

    @router.delete(
        "/library/trash/{identity}",
        dependencies=[Depends(auth.require_client), Depends(auth.require_owner)],
    )
    def purge_trash(identity: str):
        return service.purge_trash(identity)

    @router.get("/metadata/folders")
    def metadata_folders(
        limit: Annotated[int, Query(ge=1, le=200)] = 100,
        offset: Annotated[int, Query(ge=0)] = 0,
        folder: str | None = None,
    ):
        if folder is not None:
            folder = validate_folder(folder)
        return service.metadata_folders(limit, offset, folder)

    @router.put(
        "/metadata/folders",
        dependencies=[
            Depends(auth.require_client),
            Depends(auth.require_permission("metadata:write")),
        ],
    )
    def update_metadata_folder(
        body: FolderMetadataUpdate,
        user: Annotated[dict, Depends(auth.require_permission("metadata:write"))],
    ):
        return service.update_metadata_folder(body, user_id=user["id"])

    @router.get("/metadata/albums")
    def metadata_album(album_id: Annotated[str, Query(min_length=1, max_length=128)]):
        result = service.metadata_album(album_id)
        if result is None:
            raise HTTPException(404, "album_not_found")
        return result

    @router.put(
        "/metadata/albums",
        dependencies=[
            Depends(auth.require_client),
            Depends(auth.require_permission("metadata:write")),
        ],
    )
    def update_metadata_album(
        body: AlbumMetadataUpdate,
        user: Annotated[dict, Depends(auth.require_permission("metadata:write"))],
    ):
        return service.update_metadata_album(body, user_id=user["id"])

    @router.post(
        "/albums/{album_id}/cover",
        dependencies=[
            Depends(auth.require_client),
            Depends(auth.require_permission("metadata:write")),
        ],
    )
    async def upload_album_cover(
        album_id: str,
        file: Annotated[UploadFile, File()],
        save_sidecar: Annotated[bool, Form()] = True,
    ):
        content = await file.read()
        return service.update_album_cover(
            album_id, content, filename=file.filename or "cover.jpg", save_sidecar=save_sidecar
        )

    @router.delete(
        "/albums/{album_id}/cover",
        dependencies=[
            Depends(auth.require_client),
            Depends(auth.require_permission("metadata:write")),
        ],
    )
    def remove_album_cover(album_id: str):
        return service.remove_album_cover(album_id)

    @router.get("/tracks/{track_id}/metadata")
    def metadata(track_id: str):
        return editor.read(track_id)

    @router.put(
        "/tracks/{track_id}/metadata",
        dependencies=[
            Depends(auth.require_client),
            Depends(auth.require_permission("metadata:write")),
        ],
    )
    def update_metadata(
        track_id: str,
        body: MetadataUpdate,
        user: Annotated[dict, Depends(auth.require_permission("metadata:write"))],
    ):
        return editor.save(track_id, body, user_id=user["id"])

    @router.get("/tracks/{track_id}/file-info")
    def track_file_info(track_id: str):
        from wildstring.library.file_reorganizer import get_track_file_info

        return get_track_file_info(service.repository, track_id)

    @router.post(
        "/tracks/{track_id}/reorganize-file",
        dependencies=[
            Depends(auth.require_client),
            Depends(auth.require_permission("metadata:write")),
        ],
    )
    def reorganize_file(track_id: str):
        from wildstring.library.file_reorganizer import reorganize_track_file

        return reorganize_track_file(service.repository, track_id)

    @router.get("/albums/{album_id}/release-lock")
    def album_release_lock(album_id: str):
        with service.database.connect() as connection:
            from wildstring.album_release_locks import read

            result = read(connection, service.repository.library_id(), album_id)
        return result or {"album_id": album_id, "locked": False}

    @router.put(
        "/albums/{album_id}/release-lock",
        dependencies=[
            Depends(auth.require_client),
            Depends(auth.require_permission("release-lock:write")),
        ],
    )
    def save_album_release_lock(album_id: str, body: ReleaseLockInput):
        with service.database.connect(write=True) as connection:
            connection.execute("BEGIN IMMEDIATE")
            from wildstring.album_release_locks import save

            result = save(connection, service.repository.library_id(), album_id, body)
        return result | {"locked": True}

    @router.delete(
        "/albums/{album_id}/release-lock",
        dependencies=[
            Depends(auth.require_client),
            Depends(auth.require_permission("release-lock:write")),
        ],
    )
    def clear_album_release_lock(album_id: str, version: Annotated[int | None, Query(ge=1)] = None):
        with service.database.connect(write=True) as connection:
            connection.execute("BEGIN IMMEDIATE")
            from wildstring.album_release_locks import clear

            return clear(connection, service.repository.library_id(), album_id, version)

    @router.get("/tracks/{track_id}/lyrics")
    def read_lyrics(track_id: str):
        return lyrics.read(track_id)

    @router.post(
        "/tracks/{track_id}/lyrics/preview",
        dependencies=[
            Depends(auth.require_client),
            Depends(auth.require_permission("lyrics:write")),
        ],
    )
    def preview_lyrics(track_id: str, body: LyricsText):
        return lyrics.preview(track_id, body)

    @router.put(
        "/tracks/{track_id}/lyrics",
        dependencies=[
            Depends(auth.require_client),
            Depends(auth.require_permission("lyrics:write")),
        ],
    )
    def update_lyrics(track_id: str, body: LyricsUpdate):
        return lyrics.save(track_id, body)

    return router
