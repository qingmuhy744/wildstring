"""Durable copy-and-verify storage migration; old managed files are retained."""

import hashlib
import os
import re
import shutil
import stat
import time
from contextlib import suppress
from pathlib import Path
from typing import Literal
from uuid import uuid4

from fastapi import HTTPException
from filelock import FileLock, Timeout
from pydantic import BaseModel, ConfigDict, Field

from wildstring.library.import_files import (
    HardlinkError,
    copy_exclusive,
    link_exclusive,
    replace_managed_file,
    target_directory,
    validate_hardlink_capability,
)
from wildstring.library.scanner import SourceChangedError, open_source
from wildstring.library.sidecar import export_books, export_music


class MigrationInput(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    version: int = Field(ge=1, strict=True)
    managed_root: str | None = Field(default=None, min_length=1, max_length=4096)
    target_storage_mode: Literal["copy", "hardlink"] | None = None


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
    def __init__(self, catalog, *, book=False):
        self.book = book
        self.jobs = "book_library_migrations" if book else "library_migrations"
        self.libraries = "book_libraries" if book else "libraries"
        self.root_column = "managed_root" if book else "root"
        self.source_table = "book_library_sources" if book else "library_sources"
        self.catalog = catalog
        self.database = catalog.database
        self.settings = catalog.settings

    @staticmethod
    def managed_roots(db, *, ignore=None):
        return [
            Path(row[0]).resolve()
            for row in db.execute(
                """SELECT root FROM libraries
                UNION SELECT managed_root FROM book_libraries
                UNION SELECT source_root FROM library_migrations WHERE status='completed'
                UNION SELECT source_root FROM book_library_migrations WHERE status='completed'
                UNION SELECT target_root FROM library_migrations
                    WHERE status IN ('queued','running','failed') AND id<>?
                UNION SELECT target_root FROM book_library_migrations
                    WHERE status IN ('queued','running','failed') AND id<>?""",
                (ignore or "", ignore or ""),
            )
        ]

    @staticmethod
    def available(db, target, *, ignore=None, error="library_target_invalid"):
        resolved = Path(target).resolve()
        roots = LibraryStorage.managed_roots(db, ignore=ignore)
        roots.extend(
            Path(row[0]).resolve()
            for row in db.execute(
                "SELECT root FROM library_sources UNION SELECT root FROM book_library_sources"
            )
        )
        if any(overlapping(resolved, root) for root in roots):
            raise HTTPException(422, error)

    def reserved_roots(self):
        roots = [self.settings.podcasts_dir]
        if self.settings.web_dir is not None:
            roots.append(self.settings.web_dir)
        return [root.resolve() for root in roots]

    def destination(
        self, value, sources=(), *, collection: Literal["libraries", "books"] = "libraries"
    ):
        """Validate an owner-selected server directory on a writable mount."""
        try:
            if not Path(value).is_absolute():
                raise ValueError
            target = Path(value).resolve()
            runtime = self.settings.data_dir.resolve()
            managed_parent = runtime / collection
            if runtime.is_relative_to(target) or (
                target.is_relative_to(runtime) and not target.is_relative_to(managed_parent)
            ):
                raise ValueError
            if target == managed_parent:
                raise ValueError
            if any(overlapping(target, root) for root in self.reserved_roots()):
                raise ValueError
            with self.database.connect() as db:
                self.available(db, target)
            if any(overlapping(target, Path(root).resolve()) for root in sources):
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

    def record(self, db, library_id):
        row = db.execute(
            f"SELECT *, {self.root_column} AS storage_root FROM {self.libraries} WHERE id=?",  # nosec B608
            (library_id,),
        ).fetchone()
        if row is None:
            raise HTTPException(404, "book_library_not_found" if self.book else "library_not_found")
        return row

    def listing(self, library_id):
        with self.database.connect() as db:
            self.record(db, library_id)
            rows = db.execute(
                f"SELECT * FROM {self.jobs} WHERE library_id=? ORDER BY created_at DESC LIMIT 20",  # nosec B608
                (library_id,),
            )
            return {"items": [dict(row) for row in rows]}

    def check_busy(self, db, library_id):
        if db.execute(
            f"SELECT 1 FROM {self.jobs} WHERE library_id=? AND status IN ('queued','running')",  # nosec B608
            (library_id,),
        ).fetchone():
            raise HTTPException(409, "library_migration_busy")
        if (
            not self.book
            and db.execute(
                "SELECT 1 FROM admin_jobs WHERE library_id=? AND status IN ('queued','running')",
                (library_id,),
            ).fetchone()
        ):
            raise HTTPException(409, "library_task_busy")
        if (
            self.book
            and db.execute(
                "SELECT 1 FROM book_scan_jobs WHERE library_id=? AND status='running'",
                (library_id,),
            ).fetchone()
        ):
            raise HTTPException(409, "library_task_busy")

    def sources(self, db, library_id):
        return [
            Path(row[0])
            for row in db.execute(
                f"SELECT root FROM {self.source_table} WHERE library_id=? ORDER BY id",  # nosec B608
                (library_id,),
            )
        ]

    def submit(self, library_id, body, user):
        with self.database.connect() as db:
            record = self.record(db, library_id)
            roots = self.sources(db, library_id)
        source = Path(record["storage_root"])
        current_mode = record["storage_mode"]
        mode = body.target_storage_mode or current_mode
        if not body.managed_root or Path(body.managed_root).resolve() == source:
            if body.managed_root and not Path(body.managed_root).is_absolute():
                raise HTTPException(422, "library_target_invalid")
            if mode == current_mode:
                raise HTTPException(422, "library_target_invalid")
            target = source
        else:
            target = self.destination(
                body.managed_root, collection="books" if self.book else "libraries"
            )
        if mode == "hardlink":
            try:
                validate_hardlink_capability(roots, target, self.media_suffixes)
            except HardlinkError as error:
                raise HTTPException(422, error.code) from error
            except OSError as error:
                raise HTTPException(422, "hardlink_not_supported") from error
        elif mode == "copy" and current_mode == "hardlink":
            needed = 0
            for directory, _, files in os.walk(source, followlinks=False):
                for name in files:
                    path = Path(directory) / name
                    if path.is_symlink():
                        continue
                    try:
                        info = path.stat()
                    except OSError:
                        continue
                    if stat.S_ISREG(info.st_mode) and (target != source or info.st_nlink > 1):
                        needed += info.st_size
            probe = target
            while not probe.exists():
                probe = probe.parent
            with suppress(OSError):
                if shutil.disk_usage(probe).free < needed:
                    raise HTTPException(422, "insufficient_storage")
        identity, stamp = uuid4().hex, time.time()
        with self.database.connect(write=True) as db:
            db.execute("BEGIN IMMEDIATE")
            if target != source:
                self.available(db, target)
            self.check_busy(db, library_id)
            if not db.execute(
                f"UPDATE {self.libraries} SET version=version+1 WHERE id=? AND {self.root_column}=? AND version=?",  # nosec B608
                (library_id, str(source), body.version),
            ).rowcount:
                raise HTTPException(409, "library_version_conflict")
            db.execute(
                f"""INSERT INTO {self.jobs}
                (id,library_id,source_root,target_root,library_version,created_by,target_storage_mode,created_at,updated_at)
                VALUES (?,?,?,?,?,?,?,?,?)""",  # nosec B608
                (
                    identity,
                    library_id,
                    str(source),
                    str(target),
                    body.version + 1,
                    user["id"],
                    mode,
                    stamp,
                    stamp,
                ),
            )
        return next(row for row in self.listing(library_id)["items"] if row["id"] == identity)

    def retry(self, library_id, identity, user):
        with self.database.connect(write=True) as db:
            db.execute("BEGIN IMMEDIATE")
            self.check_busy(db, library_id)
            row = db.execute(
                f"SELECT * FROM {self.jobs} WHERE id=? AND library_id=? AND status='failed'",  # nosec B608
                (identity, library_id),
            ).fetchone()
            library = self.record(db, library_id)
            if not row or library["storage_root"] != row["source_root"]:
                raise HTTPException(409, "library_migration_not_retryable")
            if row["target_root"] != row["source_root"]:
                self.available(db, Path(row["target_root"]), ignore=identity)
            db.execute(
                f"UPDATE {self.libraries} SET version=version+1 WHERE id=?",  # nosec B608
                (library_id,),
            )
            db.execute(
                f"UPDATE {self.jobs} SET status='queued',error=NULL,created_by=?,library_version=?,updated_at=? WHERE id=?",  # nosec B608
                (user["id"], library["version"] + 1, time.time(), identity),
            )
        return next(row for row in self.listing(library_id)["items"] if row["id"] == identity)

    @property
    def media_suffixes(self):
        return (
            {".epub", ".txt", ".mp3", ".m4a", ".m4b", ".flac", ".ogg", ".opus"}
            if self.book
            else {
                ".mp3",
                ".m4a",
                ".flac",
                ".lrc",
                ".lryc",
                ".txt",
                ".jpg",
                ".jpeg",
                ".png",
                ".webp",
            }
        )

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
            db.execute(f"UPDATE {self.jobs} SET status='queued' WHERE status='running'")  # nosec B608

    @staticmethod
    def remove_temporary(root):
        # Only reserved importer temporaries in this job's initially empty target.
        # Published copies and all other files are retained and verified below.
        for directory, _, files in os.walk(root, followlinks=False):
            for name in files:
                if re.fullmatch(r"\.wildstring-(import|replace|asset)-[0-9a-f]{32}", name):
                    relative = (Path(directory) / name).relative_to(root)
                    with target_directory(root, relative) as descriptor:
                        os.unlink(
                            name if descriptor is not None else root / relative, dir_fd=descriptor
                        )

    def step(self):
        with self.database.connect(write=True) as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute(
                f"SELECT * FROM {self.jobs} WHERE status='queued' ORDER BY created_at LIMIT 1"  # nosec B608
            ).fetchone()
            if row is None:
                return False
            db.execute(
                f"UPDATE {self.jobs} SET status='running',updated_at=? WHERE id=?",  # nosec B608
                (time.time(), row["id"]),
            )
        job = dict(row)
        try:
            with FileLock(self.settings.data_dir / "library-scan.lock", timeout=0):
                self.copy(job)
        except Timeout:
            with self.database.connect(write=True) as db:
                db.execute(
                    f"UPDATE {self.jobs} SET status='queued',updated_at=? WHERE id=?",  # nosec B608
                    (time.time(), job["id"]),
                )
        except (OSError, ValueError, HTTPException, SourceChangedError) as error:
            code = (
                error.code
                if isinstance(error, HardlinkError)
                else error.detail
                if isinstance(error, HTTPException)
                else str(error)
                if isinstance(error, ValueError)
                else "library_migration_source_changed"
                if isinstance(error, SourceChangedError)
                else "library_migration_io_failed"
            )
            with self.database.connect(write=True) as db:
                db.execute(
                    f"UPDATE {self.jobs} SET status='failed',error=?,updated_at=? WHERE id=?",  # nosec B608
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

    def provenance(self, db, library_id, root):
        if self.book:
            rows = db.execute(
                """SELECT e.managed_path,e.link_mode FROM book_ebooks e JOIN books b ON b.id=e.book_id
                   WHERE b.library_id=? UNION ALL
                   SELECT f.managed_path,f.link_mode FROM book_audiobook_files f
                   JOIN books b ON b.id=f.book_id WHERE b.library_id=?""",
                (library_id, library_id),
            )
        else:
            rows = db.execute(
                """SELECT target_path,
                CASE WHEN source_root='upload' THEN 'managed_only' ELSE link_mode END
                FROM imported_files WHERE target_root=?""",
                (str(root),),
            )
        return dict(rows)

    def originals(self, roots, hashes, sizes=None, hints=None):
        indexed = {}
        if hints:
            for root, relative in hints:
                if len(indexed) >= len(hashes):
                    break
                try:
                    if (root / relative).suffix.lower() not in self.media_suffixes:
                        continue
                    with open_source(root, relative) as stream:
                        info = os.fstat(stream.fileno())
                        if sizes is not None and info.st_size not in sizes:
                            continue
                        value = hashlib.file_digest(stream, "sha256").hexdigest()
                        after = os.fstat(stream.fileno())
                    if (info.st_size, info.st_mtime_ns) == (
                        after.st_size,
                        after.st_mtime_ns,
                    ) and value in hashes:
                        indexed.setdefault(value, (root, relative, info))
                except (OSError, ValueError, SourceChangedError):
                    continue
        remaining = hashes - set(indexed)
        if not remaining:
            return indexed
        for root in roots:
            if not remaining:
                break
            for directory, folders, files in os.walk(root, followlinks=False):
                folders[:] = sorted(name for name in folders if not name.startswith("."))
                for name in sorted(files):
                    path = Path(directory) / name
                    if path.suffix.lower() not in self.media_suffixes or path.is_symlink():
                        continue
                    try:
                        stat_info = path.stat()
                    except OSError:
                        continue
                    if not stat.S_ISREG(stat_info.st_mode) or (
                        sizes is not None and stat_info.st_size not in sizes
                    ):
                        continue
                    relative = path.relative_to(root)
                    try:
                        with open_source(root, relative) as stream:
                            info = os.fstat(stream.fileno())
                            if sizes is not None and info.st_size not in sizes:
                                continue
                            value = hashlib.file_digest(stream, "sha256").hexdigest()
                            after = os.fstat(stream.fileno())
                    except (OSError, ValueError, SourceChangedError):
                        continue
                    if (info.st_size, info.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
                        continue
                    if value in remaining:
                        indexed.setdefault(value, (root, relative, info))
                        remaining.discard(value)
        return indexed

    def _source_hints(self, db, library_id, roots):
        hints = []
        root_map = {str(root): root for root in roots}
        if self.book:
            rows = db.execute(
                """SELECT e.source_path FROM book_ebooks e JOIN books b ON b.id=e.book_id
                   WHERE b.library_id=? AND e.source_path IS NOT NULL
                   UNION ALL
                   SELECT f.source_path FROM book_audiobook_files f JOIN books b ON b.id=f.book_id
                   WHERE b.library_id=? AND f.source_path IS NOT NULL""",
                (library_id, library_id),
            )
            for row in rows:
                source_file = Path(row[0])
                for root in roots:
                    if source_file.is_relative_to(root):
                        hints.append((root, source_file.relative_to(root)))
                        break
        else:
            for row in db.execute(
                "SELECT source_root, source_path FROM imported_files WHERE target_root=(SELECT root FROM libraries WHERE id=?)",
                (library_id,),
            ):
                root = root_map.get(row[0])
                if root is not None:
                    hints.append((root, Path(row[1])))
        return hints

    def copy(self, job):
        self.authorize(job)
        source, target = Path(job["source_root"]), Path(job["target_root"])
        in_place = target == source
        if source.is_symlink() or not source.is_dir() or target.is_symlink():
            raise ValueError("library_migration_source_unavailable")
        with self.database.connect() as db:
            library = self.record(db, job["library_id"])
            mode = job["target_storage_mode"] or library["storage_mode"]
            roots = self.sources(db, job["library_id"])
            original_modes = self.provenance(db, job["library_id"], source)
            hints = self._source_hints(db, job["library_id"], roots) if mode == "hardlink" else []
            if not in_place:
                self.available(db, target, ignore=job["id"])
        if mode == "hardlink":
            validate_hardlink_capability(roots, target, self.media_suffixes)
        if mode == "hardlink" and not job["sidecars_written"]:
            # Once a job has published its sidecars, retry uses that snapshot.
            export = export_books if self.book else export_music
            written = export(self.database, source, job["library_id"])
            with self.database.connect(write=True) as db:
                db.execute(
                    f"UPDATE {self.jobs} SET sidecars_written=? WHERE id=?",  # nosec B608
                    (written, job["id"]),
                )
        target.mkdir(parents=True, exist_ok=True)
        self.remove_temporary(target)
        before = self.tree(source)
        total = sum(item[1] for item in before.values())
        if mode == "copy" and library["storage_mode"] == "hardlink":
            needed = (
                sum(item[1] for name, item in before.items() if (target / name).stat().st_nlink > 1)
                if in_place
                else sum(item[1] for name, item in before.items() if not (target / name).exists())
            )
            if shutil.disk_usage(target).free < needed:
                raise ValueError("insufficient_storage")
        hashes = {item[0] for item in before.values()}
        sizes = {item[1] for item in before.values()}
        originals = (
            self.originals(roots, hashes, sizes=sizes, hints=hints) if mode == "hardlink" else {}
        )
        copied = copied_bytes = relinked = reclaimed = standalone = 0
        modes = {}
        linked_sources = {}
        for name, (value, size, modified) in before.items():
            self.authorize(job)
            relative = Path(name)
            destination = target / relative
            existed = destination.exists()
            prior = original_modes.get(name, "copy")
            original = (
                originals.get(value)
                if prior not in {"generated", "managed_only"}
                and ".wildstring" not in relative.parts
                else None
            )
            already_linked = False
            if existed:
                with open_source(target, relative) as stream:
                    current = os.fstat(stream.fileno())
                    if not in_place and hashlib.file_digest(stream, "sha256").hexdigest() != value:
                        raise ValueError("library_target_conflict")
                if original is not None and os.path.samestat(current, original[2]):
                    already_linked = True
            if original is not None:
                original_root, original_relative, expected_inode = original
                if not existed or not os.path.samestat(current, expected_inode):
                    with open_source(original_root, original_relative) as stream:
                        if existed:
                            replace_managed_file(link_exclusive, stream, target, relative, value)
                        else:
                            link_exclusive(stream, target, relative, value)
                modes[name] = "hardlink"
                linked_sources[name] = (original_root, original_relative, expected_inode, value)
                if library["storage_mode"] == "copy" or not already_linked:
                    relinked += 1
                    if in_place:
                        reclaimed += size
            elif not in_place or (mode == "copy" and current.st_nlink > 1):
                if not existed or current.st_nlink > 1:
                    with open_source(source, relative) as stream:
                        if existed:
                            replace_managed_file(copy_exclusive, stream, target, relative, value)
                        else:
                            copy_exclusive(stream, target, relative, value)
                # Preserve timestamps only on independent files.
                with open_source(target, relative) as stream:
                    os.utime(stream.fileno(), ns=(modified, modified))
                modes[name] = (
                    prior
                    if (prior == "managed_only" or (not self.book and prior == "generated"))
                    else "copy"
                )
                copied += 1
                copied_bytes += size
            if mode == "hardlink" and original is None and ".wildstring" not in relative.parts:
                modes[name] = (
                    "generated" if (not self.book and prior == "generated") else "managed_only"
                )
                if prior != "generated" and (
                    not self.book or relative.suffix.lower() in self.media_suffixes
                ):
                    standalone += 1
            elif mode == "copy" and in_place and original is None:
                modes[name] = (
                    prior
                    if (prior == "managed_only" or (not self.book and prior == "generated"))
                    else "copy"
                )
            with self.database.connect(write=True) as db:
                db.execute(
                    f"""UPDATE {self.jobs} SET total_files=?,total_bytes=?,copied_files=?,copied_bytes=?,
                        relinked_files=?,reclaimed_bytes=?,kept_standalone_files=?,updated_at=? WHERE id=?""",  # nosec B608
                    (
                        len(before),
                        total,
                        copied,
                        copied_bytes,
                        relinked,
                        reclaimed,
                        standalone,
                        time.time(),
                        job["id"],
                    ),
                )
        received = self.tree(target)
        if {name: item[:2] for name, item in received.items()} != {
            name: item[:2] for name, item in before.items()
        } or (not in_place and self.tree(source) != before):
            raise ValueError("library_migration_source_changed")
        self.authorize(job)
        with self.database.connect(write=True) as db:
            db.execute("BEGIN IMMEDIATE")
            if not db.execute(
                f"""UPDATE {self.libraries} SET {self.root_column}=?,storage_mode=?,version=version+1
                WHERE id=? AND {self.root_column}=? AND version=?""",  # nosec B608
                (str(target), mode, job["library_id"], str(source), job["library_version"]),
            ).rowcount:
                raise ValueError("library_version_conflict")
            if self.book:
                for table in ("book_ebooks", "book_audiobook_files"):
                    db.executemany(
                        f"""UPDATE {table} SET link_mode=? WHERE managed_path=?
                         AND book_id IN (SELECT id FROM books WHERE library_id=?)""",  # nosec B608
                        [(value, name, job["library_id"]) for name, value in modes.items()],
                    )
                    for name, value in modes.items():
                        if value == "hardlink" and name in linked_sources:
                            original_root, original_relative, _, _ = linked_sources[name]
                            db.execute(
                                f"""UPDATE {table} SET source_path=COALESCE(source_path, ?)
                                    WHERE managed_path=? AND book_id IN (SELECT id FROM books WHERE library_id=?)""",  # nosec B608
                                (
                                    str(original_root / original_relative),
                                    name,
                                    job["library_id"],
                                ),
                            )
            else:
                for name, value in modes.items():
                    updated = db.execute(
                        "UPDATE imported_files SET link_mode=? WHERE target_root=? AND target_path=?",
                        (value, str(source), name),
                    ).rowcount
                    if not updated and value == "hardlink" and name in linked_sources:
                        original_root, original_relative, expected_inode, file_hash = (
                            linked_sources[name]
                        )
                        db.execute(
                            """INSERT OR REPLACE INTO imported_files
                               (source_root, source_path, target_root, target_path, source_size, source_mtime, sha256, link_mode)
                               VALUES (?,?,?,?,?,?,?,?)""",
                            (
                                str(original_root),
                                original_relative.as_posix(),
                                str(source),
                                name,
                                expected_inode.st_size,
                                expected_inode.st_mtime_ns,
                                file_hash,
                                "hardlink",
                            ),
                        )
                db.executemany(
                    "UPDATE tracks SET mtime_ns=? WHERE library_id=? AND path=? AND mtime_ns<>?",
                    [
                        (item[2], job["library_id"], name, item[2])
                        for name, item in received.items()
                    ],
                )
                if not in_place:
                    db.execute(
                        "UPDATE imported_files SET target_root=? WHERE target_root=?",
                        (str(target), str(source)),
                    )
            db.execute(
                f"UPDATE {self.jobs} SET status='completed',error=NULL,updated_at=? WHERE id=?",  # nosec B608
                (time.time(), job["id"]),
            )
