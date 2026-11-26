"""Versioned, per-library LRU shared by original playback and materialization."""

import hashlib
import os
import time
from collections import Counter
from collections.abc import Iterator
from contextlib import contextmanager, suppress
from pathlib import Path
from tempfile import NamedTemporaryFile
from threading import Lock

import anyio
from fastapi import Request
from starlette.responses import Response, StreamingResponse

from wildstring.library.streaming import MEDIA_TYPES, AudioResponse, byte_range
from wildstring.storage.accounts import drive_http_error
from wildstring.storage.gdrive import DriveError
from wildstring.storage.media import RemoteObject

MIB = 1024 * 1024


class RemoteCache:
    def __init__(self, database):
        self.db = database
        self.root = database.path.parent / "remote-cache"
        self.guard = Lock()
        self.locks = {}
        self.reservations = Counter()

    def ref(self, kind, identity, *, library_id=None):
        with self.db.connect(scoped=False) as db:
            row = db.execute(
                """SELECT o.*, l.cache_max_mb FROM remote_media_objects o
                   JOIN library_remote_storage l USING(collection,library_id)
                   WHERE entity_kind=? AND entity_id=? AND (? IS NULL OR o.library_id=?)""",
                (kind, identity, library_id, library_id),
            ).fetchone()
        return dict(row) if row is not None else None

    @staticmethod
    def object(row):
        return RemoteObject(
            row["remote_file_id"],
            "",
            row["size_bytes"],
            row["remote_version"],
            row["remote_md5"],
            row["remote_modified_at"],
        )

    @staticmethod
    def key(row):
        return f"{row['entity_kind']}:{row['entity_id']}"

    @staticmethod
    def library(row):
        return row["collection"], row["library_id"]

    @contextmanager
    def singleflight(self, row):
        key = self.key(row)
        with self.guard:
            lock, users = self.locks.get(key, (None, 0))
            if lock is None:
                lock = Lock()
            self.locks[key] = lock, users + 1
        try:
            with lock:
                yield
        finally:
            with self.guard:
                _, users = self.locks[key]
                if users == 1:
                    del self.locks[key]
                else:
                    self.locks[key] = lock, users - 1

    def open_cached(self, row):
        key = self.key(row)
        with self.guard, self.db.connect(write=True) as db:
            cached = db.execute(
                """SELECT c.* FROM remote_media_cache c
                   JOIN library_remote_storage l USING(collection,library_id)
                   WHERE c.cache_key=? AND l.cache_max_mb>0""",
                (key,),
            ).fetchone()
            if cached is None:
                return None
            path = self.root / cached["filename"]
            if (cached["remote_version"], cached["remote_md5"]) == (
                row["remote_version"],
                row["remote_md5"],
            ):
                try:
                    source = path.open("rb")
                except FileNotFoundError:
                    pass
                else:
                    if os.fstat(source.fileno()).st_size == row["size_bytes"]:
                        db.execute(
                            "UPDATE remote_media_cache SET accessed_at=? WHERE cache_key=?",
                            (time.time(), key),
                        )
                        return source
                    source.close()
            path.unlink(missing_ok=True)
            db.execute("DELETE FROM remote_media_cache WHERE cache_key=?", (key,))
        return None

    def trim(self, db, library, budget):
        rows = db.execute(
            """SELECT * FROM remote_media_cache WHERE collection=? AND library_id=?
               ORDER BY accessed_at,cache_key""",
            library,
        ).fetchall()
        total = sum(row["size_bytes"] for row in rows)
        for row in rows:
            if total <= budget:
                break
            (self.root / row["filename"]).unlink(missing_ok=True)
            db.execute("DELETE FROM remote_media_cache WHERE cache_key=?", (row["cache_key"],))
            total -= row["size_bytes"]

    def configure(self, library, *, limit=None, clear=False):
        with self.guard, self.db.connect(write=True) as db:
            db.execute("BEGIN IMMEDIATE")
            if limit is not None:
                db.execute(
                    """UPDATE library_remote_storage SET cache_max_mb=?,version=version+1
                       WHERE collection=? AND library_id=?""",
                    (limit, *library),
                )
            if clear:
                # In-flight downloads keep serving their readers but cannot refill after clearing.
                db.execute(
                    """UPDATE library_remote_storage SET version=version+1
                       WHERE collection=? AND library_id=?""",
                    library,
                )
            self.trim(db, library, 0 if clear else limit * MIB)

    @contextmanager
    def writer(self, row, *, temporary=False):
        library, size = self.library(row), row["size_bytes"]
        with self.guard, self.db.connect(write=True) as db:
            binding = db.execute(
                """SELECT cache_max_mb,version FROM library_remote_storage
                   WHERE collection=? AND library_id=?""",
                library,
            ).fetchone()
            available = (
                binding["cache_max_mb"] * MIB - self.reservations[library]
                if binding is not None
                else 0
            )
            keep = binding is not None and size > 0 and size <= available
            if keep:
                self.trim(db, library, available - size)
                self.reservations[library] += size
        if not keep and not temporary:
            yield None
            return
        try:
            try:
                if keep:
                    self.root.mkdir(mode=0o700, exist_ok=True)
                partial = NamedTemporaryFile(
                    dir=self.root if keep else self.root.parent,
                    prefix=".remote-media-",
                    buffering=0,
                    delete_on_close=False,
                )
            except OSError:
                if temporary:
                    raise
                yield None
                return
            with partial:
                yield partial
                if not keep or partial.tell() != size:
                    return
                with self.guard, self.db.connect(write=True) as db:
                    db.execute("BEGIN IMMEDIATE")
                    current = db.execute(
                        """SELECT l.version FROM remote_media_objects o
                           JOIN library_remote_storage l USING(collection,library_id)
                           WHERE o.entity_kind=? AND o.entity_id=? AND o.available=1 AND o.remote_version=?
                             AND o.remote_md5 IS ?""",
                        (
                            row["entity_kind"],
                            row["entity_id"],
                            row["remote_version"],
                            row["remote_md5"],
                        ),
                    ).fetchone()
                    if (
                        current is not None
                        and current["version"] == binding["version"]
                        and partial.tell() == size
                    ):
                        partial.flush()
                        cache_key = self.key(row)
                        filename = hashlib.sha256(
                            repr((cache_key, row["remote_version"], row["remote_md5"])).encode()
                        ).hexdigest()
                        previous = db.execute(
                            "SELECT filename FROM remote_media_cache WHERE cache_key=?",
                            (cache_key,),
                        ).fetchone()
                        # Keep the open descriptor readable even if another stream evicts it.
                        try:
                            Path(partial.name).replace(self.root / filename)
                        except OSError:
                            if temporary:
                                raise
                            return
                        db.execute(
                            "INSERT OR REPLACE INTO remote_media_cache VALUES (?,?,?,?,?,?,?,?)",
                            (
                                cache_key,
                                *library,
                                row["remote_version"],
                                row["remote_md5"],
                                filename,
                                size,
                                time.time(),
                            ),
                        )
                        if previous is not None and previous["filename"] != filename:
                            (self.root / previous["filename"]).unlink(missing_ok=True)
        finally:
            if keep:
                with self.guard:
                    self.reservations[library] -= size
                    if not self.reservations[library]:
                        del self.reservations[library]

    @contextmanager
    def materialize(self, drive, ref, *, row):
        with self.singleflight(row):
            cached = self.open_cached(row)
            if cached is not None:
                with cached:
                    yield cached
                return
            with self.writer(row, temporary=True) as destination:
                for chunk in drive.iter_range(ref, 0, ref.size - 1):
                    destination.write(chunk)
                destination.flush()
                destination.seek(0)
                yield destination
                destination.seek(0, os.SEEK_END)

    def chunks(self, drive, row, start, end, fill) -> Iterator[bytes]:
        if fill:
            with self.singleflight(row):
                cached = self.open_cached(row)
                if cached is not None:
                    with cached:
                        yield from drive.chunks(cached, end + 1)
                    return
                with self.writer(row) as destination:
                    for chunk in drive.iter_range(self.object(row), start, end):
                        if destination is not None:
                            try:
                                destination.write(chunk)
                            except OSError:
                                # The original stream stays usable if the disk cannot cache it.
                                with suppress(OSError):
                                    destination.seek(0)
                                destination = None
                        yield chunk
            return
        yield from drive.iter_range(self.object(row), start, end)


class RemoteResponse(Response):
    def __init__(self, accounts, cache, row, format_name, request: Request, headers=None):
        super().__init__()
        self.accounts, self.cache, self.row = accounts, cache, row
        self.format_name, self.request, self.output_headers = format_name, request, headers or {}

    async def __call__(self, scope, receive, send):
        row = self.row
        size = row["size_bytes"]
        etag = (
            '"'
            + hashlib.sha256(
                repr((self.cache.key(row), row["remote_version"], row["remote_md5"])).encode()
            ).hexdigest()
            + '"'
        )
        headers = {
            "Accept-Ranges": "bytes",
            "ETag": etag,
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
            **self.output_headers,
        }
        requested = self.request.headers.get("range") if self.request.method == "GET" else None
        if self.request.headers.get("if-range", etag) != etag:
            requested = None
        try:
            selected = byte_range(requested, size)
        except ValueError:
            headers["Content-Range"] = f"bytes */{size}"
            await Response(status_code=416, headers=headers)(scope, receive, send)
            return
        start, end = selected or (0, size - 1)
        headers["Content-Length"] = str(end - start + 1)
        if selected:
            headers["Content-Range"] = f"bytes {start}-{end}/{size}"
        media_type = MEDIA_TYPES[self.format_name]
        if self.request.method == "HEAD" or size == 0:
            await Response(headers=headers, media_type=media_type)(scope, receive, send)
            return

        cached = (
            await anyio.to_thread.run_sync(self.cache.open_cached, row)
            if row["cache_max_mb"]
            else None
        )
        if cached is not None:
            with cached:
                await AudioResponse(
                    self.cache.root,
                    {"format": self.format_name},
                    self.request,
                    {"ETag": etag, **self.output_headers},
                ).send_audio(cached, os.fstat(cached.fileno()), scope, receive, send)
            return

        def body():
            drive = self.accounts.drive(row["account_id"])
            yield from self.cache.chunks(
                drive,
                row,
                start,
                end,
                start == 0 and end == size - 1 and size <= row["cache_max_mb"] * MIB,
            )

        stream = body()
        try:
            try:
                first = await anyio.to_thread.run_sync(next, stream, None)
            except DriveError as error:
                await anyio.to_thread.run_sync(
                    self.accounts.record_failure, row["account_id"], error
                )
                raise drive_http_error(error) from None

            async def chunks():
                if first is not None:
                    yield first
                while (data := await anyio.to_thread.run_sync(next, stream, None)) is not None:
                    yield data

            await StreamingResponse(
                chunks(),
                status_code=206 if selected else 200,
                headers=headers,
                media_type=media_type,
            )(scope, receive, send)
        finally:
            with anyio.CancelScope(shield=True):
                await anyio.to_thread.run_sync(stream.close)
