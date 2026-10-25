"""Durable copy-and-verify storage migration; old managed files are retained."""

import hashlib
import os
import re
import stat
import time
from pathlib import Path
from uuid import uuid4

from fastapi import HTTPException
from filelock import FileLock, Timeout
from pydantic import BaseModel, ConfigDict, Field

from wildstring.library.import_files import copy_exclusive, target_directory
from wildstring.library.scanner import SourceChangedError, open_source


class MigrationInput(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    version: int = Field(ge=1, strict=True)
    managed_root: str = Field(min_length=1, max_length=4096)


def overlapping(first, second):
    return first.is_relative_to(second) or second.is_relative_to(first)


def busy(connection, library_id):
    return (
        connection.execute(
            "SELECT 1 FROM library_migrations WHERE library_id=? AND status IN ('queued','running')",
            (library_id,),
        ).fetchone()
        is not None
    )


class LibraryStorage:
    def __init__(self, catalog):
        self.catalog = catalog
        self.database = catalog.database
        self.settings = catalog.settings

    @staticmethod
    def available(db, target, *, ignore=None):
        roots = [
            Path(r[0])
            for r in db.execute("SELECT root FROM libraries UNION SELECT root FROM library_sources")
        ]
        roots += [
            Path(r[0])
            for r in db.execute(
                "SELECT source_root FROM library_migrations WHERE status='completed'"
            )
        ]
        roots += [
            Path(r[0])
            for r in db.execute(
                "SELECT target_root FROM library_migrations WHERE status IN ('queued','running','failed') AND id<>?",
                (ignore or "",),
            )
        ]
        if any(overlapping(target, root) for root in roots):
            raise HTTPException(422, "library_target_invalid")

    def destination(self, value, sources=()):
        try:
            if not Path(value).is_absolute():
                raise ValueError
            target = Path(value).resolve()
            runtime = self.settings.data_dir.resolve()
            if runtime.is_relative_to(target) or (
                target.is_relative_to(runtime) and not target.is_relative_to(runtime / "libraries")
            ):
                raise ValueError
            reserved = [self.settings.podcasts_dir]
            if self.settings.web_dir is not None:
                reserved.append(self.settings.web_dir)
            if any(overlapping(target, root.resolve()) for root in reserved):
                raise ValueError
            with self.database.connect() as db:
                self.available(db, target)
            if any(overlapping(target, Path(root)) for root in sources):
                raise ValueError
            if target.exists() and (not target.is_dir() or any(target.iterdir())):
                raise HTTPException(409, "library_target_not_empty")
            parent = target
            while not parent.exists():
                parent = parent.parent
            if not parent.is_dir() or not os.access(parent, os.W_OK | os.X_OK):
                raise HTTPException(422, "library_target_not_writable")
            return target
        except (OSError, RuntimeError, ValueError):
            raise HTTPException(422, "library_target_invalid") from None

    def listing(self, library_id):
        self.catalog.record(library_id)
        with self.database.connect() as db:
            return {
                "items": [
                    dict(r)
                    for r in db.execute(
                        "SELECT * FROM library_migrations WHERE library_id=? ORDER BY created_at DESC LIMIT 20",
                        (library_id,),
                    )
                ]
            }

    def submit(self, library_id, body, user):
        record = self.catalog.record(library_id)
        target = self.destination(body.managed_root)
        identity, stamp = uuid4().hex, time.time()
        with self.database.connect(write=True) as db:
            db.execute("BEGIN IMMEDIATE")
            self.available(db, target)
            if busy(db, library_id):
                raise HTTPException(409, "library_migration_busy")
            if db.execute(
                "SELECT 1 FROM admin_jobs WHERE library_id=? AND status IN ('queued','running')",
                (library_id,),
            ).fetchone():
                raise HTTPException(409, "library_task_busy")
            if not db.execute(
                "UPDATE libraries SET version=version+1 WHERE id=? AND root=? AND version=?",
                (library_id, record["root"], body.version),
            ).rowcount:
                raise HTTPException(409, "library_version_conflict")
            db.execute(
                """INSERT INTO library_migrations
                (id,library_id,source_root,target_root,library_version,created_by,created_at,updated_at)
                VALUES (?,?,?,?,?,?,?,?)""",
                (
                    identity,
                    library_id,
                    record["root"],
                    str(target),
                    body.version + 1,
                    user["id"],
                    stamp,
                    stamp,
                ),
            )
        return self.listing(library_id)["items"][0]

    def retry(self, library_id, identity, user):
        with self.database.connect(write=True) as db:
            db.execute("BEGIN IMMEDIATE")
            if busy(db, library_id):
                raise HTTPException(409, "library_migration_busy")
            row = db.execute(
                "SELECT * FROM library_migrations WHERE id=? AND library_id=? AND status='failed'",
                (identity, library_id),
            ).fetchone()
            library = db.execute("SELECT * FROM libraries WHERE id=?", (library_id,)).fetchone()
            if not row or library["root"] != row["source_root"]:
                raise HTTPException(409, "library_migration_not_retryable")
            self.available(db, Path(row["target_root"]), ignore=identity)
            if db.execute(
                "SELECT 1 FROM admin_jobs WHERE library_id=? AND status IN ('queued','running')",
                (library_id,),
            ).fetchone():
                raise HTTPException(409, "library_task_busy")
            db.execute("UPDATE libraries SET version=version+1 WHERE id=?", (library_id,))
            db.execute(
                "UPDATE library_migrations SET status='queued',error=NULL,created_by=?,library_version=?,updated_at=? WHERE id=?",
                (user["id"], library["version"] + 1, time.time(), identity),
            )
        return next(r for r in self.listing(library_id)["items"] if r["id"] == identity)

    @staticmethod
    def tree(root):
        def unavailable(error):
            raise error

        result = {}
        for directory, folders, files in os.walk(root, followlinks=False, onerror=unavailable):
            for name in [*folders, *files]:
                if (Path(directory) / name).is_symlink():
                    raise ValueError("library_migration_symlink")
            for name in files:
                path = Path(directory) / name
                info = path.stat()
                if not stat.S_ISREG(info.st_mode):
                    raise ValueError("library_migration_special_file")
                with path.open("rb") as stream:
                    digest = hashlib.file_digest(stream, "sha256").hexdigest()
                    after = os.fstat(stream.fileno())
                if (info.st_size, info.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
                    raise ValueError("library_migration_source_changed")
                result[path.relative_to(root).as_posix()] = (digest, info.st_size, info.st_mtime_ns)
        return result

    def recover(self):
        with self.database.connect(write=True) as db:
            db.execute("UPDATE library_migrations SET status='queued' WHERE status='running'")

    @staticmethod
    def remove_temporary(root):
        # Only reserved importer temporaries in this job's initially empty target.
        # Published copies and all other files are retained and verified below.
        for directory, _, files in os.walk(root, followlinks=False):
            for name in files:
                if re.fullmatch(r"\.wildstring-import-[0-9a-f]{32}", name):
                    relative = (Path(directory) / name).relative_to(root)
                    with target_directory(root, relative) as descriptor:
                        os.unlink(
                            name if descriptor is not None else root / relative, dir_fd=descriptor
                        )

    def step(self):
        with self.database.connect(write=True) as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute(
                "SELECT * FROM library_migrations WHERE status='queued' ORDER BY created_at LIMIT 1"
            ).fetchone()
            if row is None:
                return False
            db.execute(
                "UPDATE library_migrations SET status='running',updated_at=? WHERE id=?",
                (time.time(), row["id"]),
            )
        job = dict(row)
        try:
            with FileLock(self.settings.data_dir / "library-scan.lock", timeout=0):
                self.copy(job)
        except Timeout:
            with self.database.connect(write=True) as db:
                db.execute(
                    "UPDATE library_migrations SET status='queued',updated_at=? WHERE id=?",
                    (time.time(), job["id"]),
                )
        except (OSError, ValueError, HTTPException, SourceChangedError) as error:
            code = (
                error.detail
                if isinstance(error, HTTPException)
                else str(error)
                if isinstance(error, ValueError)
                else "library_migration_source_changed"
                if isinstance(error, SourceChangedError)
                else "library_migration_io_failed"
            )
            with self.database.connect(write=True) as db:
                db.execute(
                    "UPDATE library_migrations SET status='failed',error=?,updated_at=? WHERE id=?",
                    (code, time.time(), job["id"]),
                )
        return True

    def authorize(self, job):
        with self.database.connect() as db:
            owner = db.execute(
                "SELECT profile,enabled FROM users WHERE id=?", (job["created_by"],)
            ).fetchone()
            if not owner or not owner["enabled"] or owner["profile"] != "owner":
                raise HTTPException(403, "library_access_required")

    def copy(self, job):
        self.authorize(job)
        source, target = Path(job["source_root"]), Path(job["target_root"])
        if source.is_symlink() or not source.is_dir() or target.is_symlink():
            raise ValueError("library_migration_source_unavailable")
        with self.database.connect() as db:
            self.available(db, target, ignore=job["id"])
        before = self.tree(source)
        target.mkdir(parents=True, exist_ok=True)
        self.remove_temporary(target)
        with self.database.connect(write=True) as db:
            db.execute(
                "UPDATE library_migrations SET total_files=?,total_bytes=?,copied_files=0,copied_bytes=0 WHERE id=?",
                (len(before), sum(v[1] for v in before.values()), job["id"]),
            )
        done = 0
        for count, (name, (digest, size, modified)) in enumerate(before.items(), 1):
            self.authorize(job)
            destination = target / name
            if destination.exists():
                with open_source(target, Path(name)) as stream:
                    if hashlib.file_digest(stream, "sha256").hexdigest() != digest:
                        raise ValueError("library_target_conflict")
            else:
                with open_source(source, Path(name)) as stream:
                    copy_exclusive(stream, target, Path(name), digest)
            with open_source(target, Path(name)) as stream:
                os.utime(stream.fileno(), ns=(modified, modified))
            done += size
            with self.database.connect(write=True) as db:
                db.execute(
                    "UPDATE library_migrations SET copied_files=?,copied_bytes=?,updated_at=? WHERE id=?",
                    (count, done, time.time(), job["id"]),
                )
        if self.tree(source) != before or self.tree(target) != before:
            raise ValueError("library_migration_source_changed")
        self.authorize(job)
        with self.database.connect(write=True) as db:
            db.execute("BEGIN IMMEDIATE")
            if not db.execute(
                "UPDATE libraries SET root=?,version=version+1 WHERE id=? AND root=? AND version=?",
                (str(target), job["library_id"], str(source), job["library_version"]),
            ).rowcount:
                raise ValueError("library_version_conflict")
            db.execute(
                "UPDATE imported_files SET target_root=? WHERE target_root=?",
                (str(target), str(source)),
            )
            db.execute(
                "UPDATE library_migrations SET status='completed',error=NULL,updated_at=? WHERE id=?",
                (time.time(), job["id"]),
            )
