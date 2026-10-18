"""Bounded AAC streaming, versioned reusable caches and administrative cleanup."""

import hashlib
import json
import math
import os
import selectors
import shutil
import sqlite3
import subprocess
import threading
import time
from contextlib import ExitStack
from dataclasses import dataclass, field
from pathlib import Path
from tempfile import TemporaryFile
from urllib.parse import urlencode
from uuid import uuid4

import anyio
from fastapi import APIRouter, Depends, HTTPException
from filelock import FileLock, Timeout
from mutagen import File, MutagenError
from mutagen.flac import FLAC
from mutagen.mp3 import MP3
from mutagen.mp4 import MP4
from pydantic import BaseModel, ConfigDict, Field
from starlette.responses import Response, StreamingResponse

from wildstring.library.scanner import fingerprint, open_source
from wildstring.library.streaming import AudioResponse

RATES = (128, 192, 256, 320)
MIB = 1024 * 1024
SLOT_WAIT_SECONDS = 5


class CacheSettings(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    version: int = Field(ge=1)
    retention_days: int = Field(ge=1, le=365)
    max_size_mb: int = Field(ge=16, le=1_048_576)
    max_concurrent: int = Field(ge=1, le=8)


@dataclass
class Plan:
    track_id: str
    record: dict
    source: dict
    bitrate: int | None
    start_ms: int
    key: str
    requested_bitrate: int | None

    def public(self, cache_state="none"):
        transcode = self.bitrate is not None
        return {
            "mode": "transcode" if transcode else "original",
            "reason": "lossless_to_aac"
            if transcode
            else "lossy_passthrough"
            if self.requested_bitrate
            else "original_requested",
            "source": self.source,
            "output": {
                "codec": "aac",
                "container": "m4a",
                "profile": "LC",
                "bitrate_kbps": self.bitrate,
                "sample_rate": 48000,
                "channels": min(self.source["channels"], 2),
            }
            if transcode
            else self.source,
            "duration_ms": self.source["duration_ms"],
            "start_ms": self.start_ms,
            "requested_bitrate_kbps": self.requested_bitrate,
            "cache_state": cache_state,
            "stream_url": f"/api/v1/tracks/{self.track_id}/stream"
            + (
                "?"
                + urlencode(
                    {
                        "format": "aac",
                        "bitrate_kbps": self.requested_bitrate,
                        "start_ms": self.start_ms,
                    }
                )
                if transcode
                else ""
            ),
        }


@dataclass
class Entry:
    key: str
    path: Path
    final: Path
    plan: Plan | None = None
    size: int = 0
    readers: int = 0
    complete: bool = False
    purge: bool = False
    error: str | None = None
    ready: threading.Event = field(default_factory=threading.Event)
    done: threading.Event = field(default_factory=threading.Event)
    lock: FileLock | None = None
    thread: threading.Thread | None = None


class Transcoding:
    def __init__(self, repository):
        self.repository = repository
        self.database = repository.database
        self.root = self.database.path.parent / "cache" / "transcoding"
        self.lock = threading.RLock()
        self.entries: dict[str, Entry] = {}
        self.retired: list[Entry] = []
        self.stopping = threading.Event()
        self.thread = None
        self.probes = {}

    def settings(self):
        with self.database.connect() as connection:
            return dict(
                connection.execute("SELECT * FROM transcoding_settings WHERE id=1").fetchone()
            )

    def start(self):
        self.root.mkdir(parents=True, exist_ok=True)
        # Never remove a partial file still owned by another application instance.
        for path in [*self.root.glob("*.part"), *self.root.glob("*.m4a")]:
            try:
                with FileLock(self.root / (path.name.split(".")[0] + ".lock"), timeout=0):
                    with self.database.connect() as connection:
                        cached = connection.execute(
                            "SELECT 1 FROM transcoding_cache WHERE filename=?", (path.name,)
                        ).fetchone()
                    if not cached:
                        path.unlink(missing_ok=True)
            except Timeout:
                continue
        self.thread = threading.Thread(
            target=self.housekeep, name="wildstring-transcode-cache", daemon=True
        )
        self.thread.start()

    def stop(self):
        self.stopping.set()
        if self.thread:
            self.thread.join(timeout=3)
        with self.lock:
            workers = [
                entry.thread for entry in [*self.entries.values(), *self.retired] if entry.thread
            ]
        for worker in workers:
            worker.join(timeout=3)

    def housekeep(self):
        while not self.stopping.wait(60):
            try:
                self.cleanup()
            except (OSError, sqlite3.Error):
                # A lost data mount must not be recreated by background cleanup.
                continue

    def plan(self, track_id, format_name=None, bitrate=None, start_ms=0):
        if (format_name is None and (bitrate is not None or start_ms)) or (
            format_name == "aac" and bitrate not in RATES
        ):
            raise HTTPException(422, "invalid_transcoding_parameters")
        record = self.repository.source(track_id)
        if record is None:
            raise HTTPException(404, "track_not_found")
        if record["status"] != "available":
            raise HTTPException(409, "track_unavailable")
        try:
            with open_source(self.repository.root, Path(record["path"])) as source:
                stat = os.fstat(source.fileno())
                if (stat.st_size, stat.st_mtime_ns) != (record["size_bytes"], record["mtime_ns"]):
                    raise HTTPException(409, "file_changed_rescan_required")
                signature = json.dumps([track_id, record, fingerprint(stat)], sort_keys=True)
                with self.lock:
                    observed = self.probes.get(signature)
                if observed is None:
                    audio = File(source)
                    if isinstance(audio, FLAC):
                        codec, lossless = "flac", True
                    elif isinstance(audio, MP3):
                        codec, lossless = "mp3", False
                    elif isinstance(audio, MP4):
                        codec = getattr(audio.info, "codec", "").lower()
                        codec = "aac" if codec.startswith("mp4a") else codec
                        lossless = codec == "alac"
                        if codec not in {"aac", "alac", "ac-3", "ec-3", "opus", "mp3"}:
                            raise HTTPException(409, "unsupported_audio_codec")
                    else:
                        raise HTTPException(409, "unsupported_audio_codec")
                    duration = float(audio.info.length)
                    if not math.isfinite(duration) or duration <= 0:
                        raise HTTPException(409, "audio_unavailable")
                    observed = {
                        "codec": codec,
                        "container": record["format"],
                        "lossless": lossless,
                        "bitrate_kbps": round(getattr(audio.info, "bitrate", 0) / 1000) or None,
                        "sample_rate": getattr(audio.info, "sample_rate", None),
                        "channels": getattr(audio.info, "channels", 2) or 2,
                        "bit_depth": getattr(audio.info, "bits_per_sample", None),
                        "duration_ms": round(duration * 1000),
                    }
                    if fingerprint(os.fstat(source.fileno())) != fingerprint(stat):
                        raise HTTPException(409, "file_changed_rescan_required")
                    with self.lock:
                        if len(self.probes) >= 512:
                            self.probes.clear()
                        self.probes[signature] = observed
        except (OSError, MutagenError, ValueError, TypeError) as error:
            raise HTTPException(409, "audio_unavailable") from error
        encode = format_name == "aac" and observed["lossless"]
        if encode and start_ms >= observed["duration_ms"]:
            raise HTTPException(416, "playback_position_out_of_range")
        # Native AAC's per-channel limits need a lower ceiling for mono output.
        target = min(bitrate, 256 if observed["channels"] == 1 else 320) if encode else None
        offset = start_ms if encode else 0
        key = (
            hashlib.sha256(
                json.dumps(
                    [
                        signature,
                        target,
                        offset,
                        48000,
                        min(observed["channels"], 2),
                        1,
                        self.settings()["generation"],
                    ]
                ).encode()
            ).hexdigest()
            if encode
            else ""
        )
        return Plan(track_id, record, observed, target, offset, key, bitrate)

    def cache_state(self, plan):
        if not plan.bitrate:
            return "none"
        with self.lock:
            entry = self.entries.get(plan.key)
            if entry and not entry.purge:
                return "hit" if entry.complete else "encoding"
            with self.database.connect() as connection:
                row = connection.execute(
                    "SELECT filename,accessed_at FROM transcoding_cache WHERE key=?", (plan.key,)
                ).fetchone()
            if (
                row
                and row["accessed_at"] >= time.time() - self.settings()["retention_days"] * 86400
                and (self.root / row["filename"]).is_file()
            ):
                return "hit"
        return "miss"

    def usage(self):
        with self.database.connect() as connection:
            total = connection.execute(
                "SELECT COALESCE(sum(size_bytes),0) FROM transcoding_cache"
            ).fetchone()[0]
        return (
            total
            + sum(entry.size for entry in self.entries.values() if not entry.complete)
            + sum(entry.size for entry in self.retired)
        )

    def discard(self, entry):
        if entry.readers or not entry.done.is_set():
            return
        entry.path.unlink(missing_ok=True)
        entry.final.unlink(missing_ok=True)
        self.retired = [item for item in self.retired if item is not entry]
        if self.entries.get(entry.key) is entry:
            self.entries.pop(entry.key)

    def cleanup(self, *, clear=False, required=0):
        with self.lock:
            settings = self.settings()
            freed = removed = deferred = 0
            with self.database.connect(write=True) as connection:
                rows = connection.execute(
                    "SELECT * FROM transcoding_cache ORDER BY accessed_at"
                ).fetchall()
                if clear:
                    connection.execute(
                        "UPDATE transcoding_settings SET generation=generation+1,version=version+1 WHERE id=1"
                    )
                total = (
                    sum(row["size_bytes"] for row in rows)
                    + sum(entry.size for entry in self.entries.values() if not entry.complete)
                    + sum(entry.size for entry in self.retired)
                )
                for row in rows:
                    if (
                        not clear
                        and row["accessed_at"] > time.time() - settings["retention_days"] * 86400
                        and total + required <= settings["max_size_mb"] * MIB
                    ):
                        continue
                    entry = self.entries.pop(row["key"], None)
                    connection.execute("DELETE FROM transcoding_cache WHERE key=?", (row["key"],))
                    removed += 1
                    if entry and entry.readers:
                        entry.purge = True
                        self.retired.append(entry)
                        deferred += 1
                    else:
                        path = self.root / row["filename"]
                        path.unlink(missing_ok=True)
                        freed += row["size_bytes"]
                        total -= row["size_bytes"]
                if clear:
                    for key, entry in list(self.entries.items()):
                        entry.purge = True
                        self.entries.pop(key)
                        self.retired.append(entry)
                        deferred += 1
            for entry in list(self.retired):
                self.discard(entry)
            return {"freed_bytes": freed, "removed": removed, "deferred": deferred}

    def acquire(self, plan):
        with self.lock:
            self.cleanup()
            entry = self.entries.get(plan.key)
            if entry and not entry.purge:
                entry.readers += 1
                self.touch(plan.key)
                return entry
            with self.database.connect() as connection:
                row = connection.execute(
                    "SELECT * FROM transcoding_cache WHERE key=?", (plan.key,)
                ).fetchone()
            if row:
                path = self.root / row["filename"]
                if (
                    path.is_file()
                    and not path.is_symlink()
                    and path.stat().st_size == row["size_bytes"]
                ):
                    entry = Entry(
                        plan.key, path, path, size=row["size_bytes"], readers=1, complete=True
                    )
                    entry.ready.set()
                    entry.done.set()
                    self.entries[plan.key] = entry
                    self.touch(plan.key)
                    return entry
                with self.database.connect(write=True) as connection:
                    connection.execute("DELETE FROM transcoding_cache WHERE key=?", (plan.key,))
            if self.stopping.is_set() or not self.root.is_dir():
                raise HTTPException(503, "transcoding_unavailable")
            if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
                raise HTTPException(503, "ffmpeg_unavailable")
            active = sum(
                not entry.done.is_set() for entry in [*self.entries.values(), *self.retired]
            )
            if active >= self.settings()["max_concurrent"]:
                raise HTTPException(429, "transcoding_busy", headers={"Retry-After": "2"})
            producer = FileLock(self.root / (plan.key + ".lock"), timeout=0, thread_local=False)
            try:
                producer.acquire()
            except Timeout:
                raise HTTPException(503, "transcoding_busy", headers={"Retry-After": "2"}) from None
            stem = plan.key + "." + uuid4().hex
            entry = Entry(
                plan.key,
                self.root / (stem + ".part"),
                self.root / (stem + ".m4a"),
                plan=plan,
                readers=1,
                lock=producer,
            )
            self.entries[plan.key] = entry
            entry.thread = threading.Thread(
                target=self.encode, args=(entry,), name="wildstring-aac", daemon=True
            )
            entry.thread.start()
            return entry

    def touch(self, key):
        with self.database.connect(write=True) as connection:
            connection.execute(
                "UPDATE transcoding_cache SET accessed_at=? WHERE key=?", (time.time(), key)
            )

    def release(self, entry):
        with self.lock:
            entry.readers -= 1
            if entry.purge or entry.error:
                self.discard(entry)

    def command(self, source, plan):
        return [
            shutil.which("ffmpeg"),
            "-nostdin",
            "-v",
            "error",
            "-xerror",
            "-threads",
            "1",
            "-protocol_whitelist",
            "file,pipe",
            "-ss",
            f"{plan.start_ms / 1000:.3f}",
            "-i",
            f"/dev/fd/{source.fileno()}",
            "-map",
            "0:a:0",
            "-vn",
            "-sn",
            "-dn",
            "-map_metadata",
            "-1",
            "-c:a",
            "aac",
            "-profile:a",
            "aac_low",
            "-b:a",
            f"{plan.bitrate}k",
            "-ar",
            "48000",
            "-ac",
            str(min(plan.source["channels"], 2)),
            "-threads",
            "1",
            "-movflags",
            "+empty_moov+default_base_moof+frag_keyframe",
            "-frag_duration",
            "1000000",
            "-f",
            "mp4",
            "pipe:1",
        ]

    def verify(self, entry):
        result = subprocess.run(
            [
                shutil.which("ffprobe"),
                "-v",
                "error",
                "-select_streams",
                "a:0",
                "-show_entries",
                "stream=codec_name,duration,sample_rate,channels",
                "-of",
                "json",
                str(entry.path),
            ],
            capture_output=True,
            timeout=15,
            check=True,
        )
        stream = json.loads(result.stdout)["streams"][0]
        duration = float(stream["duration"])
        expected = (entry.plan.source["duration_ms"] - entry.plan.start_ms) / 1000
        if (
            stream["codec_name"] != "aac"
            or stream["sample_rate"] != "48000"
            or not math.isfinite(duration)
            or abs(duration - expected) > 0.3
        ):
            raise ValueError("Invalid AAC output")

    def encode(self, entry):
        process = None
        try:
            plan = entry.plan
            with (
                open_source(self.repository.root, Path(plan.record["path"])) as source,
                TemporaryFile() as errors,
            ):
                before = os.fstat(source.fileno())
                if (before.st_size, before.st_mtime_ns) != (
                    plan.record["size_bytes"],
                    plan.record["mtime_ns"],
                ):
                    raise ValueError("Source changed")
                with entry.path.open("xb", buffering=0) as output:
                    process = subprocess.Popen(
                        self.command(source, plan),
                        stdout=subprocess.PIPE,
                        stderr=errors,
                        pass_fds=(source.fileno(),),
                    )
                    deadline = time.monotonic() + min(
                        3600, max(60, plan.source["duration_ms"] / 500)
                    )
                    with selectors.DefaultSelector() as selector:
                        selector.register(process.stdout, selectors.EVENT_READ)
                        while True:
                            if self.stopping.is_set() or time.monotonic() > deadline:
                                raise TimeoutError("Encoder stopped")
                            if not selector.select(timeout=0.5):
                                continue
                            chunk = os.read(process.stdout.fileno(), 64 * 1024)
                            if not chunk:
                                break
                            with self.lock:
                                settings = self.settings()
                                if self.usage() + len(chunk) > settings["max_size_mb"] * MIB:
                                    self.cleanup(required=len(chunk))
                                if (
                                    self.usage() + len(chunk) > settings["max_size_mb"] * MIB
                                    or shutil.disk_usage(self.root).free < len(chunk) + 8 * MIB
                                ):
                                    raise OSError("Cache storage exhausted")
                                output.write(chunk)
                                entry.size += len(chunk)
                                if entry.size > 1024:
                                    entry.ready.set()
                    if process.wait(timeout=5) != 0 or entry.size <= 1024:
                        raise ValueError("Encoding failed")
                if fingerprint(os.fstat(source.fileno())) != fingerprint(before):
                    raise ValueError("Source changed")
                self.verify(entry)
            with self.lock:
                entry.path.replace(entry.final)
                entry.path = entry.final
                entry.complete = True
                if not entry.purge:
                    with self.database.connect(write=True) as connection:
                        connection.execute(
                            "INSERT OR REPLACE INTO transcoding_cache VALUES (?,?,?,?,?)",
                            (entry.key, entry.final.name, plan.track_id, entry.size, time.time()),
                        )
        except (
            OSError,
            ValueError,
            IndexError,
            KeyError,
            subprocess.SubprocessError,
            sqlite3.Error,
        ):
            entry.error = "transcoding_failed"
            entry.purge = True
        finally:
            if process is not None:
                if process.poll() is None:
                    process.kill()
                process.wait()
                process.stdout.close()
            with self.lock:
                entry.done.set()
                entry.ready.set()
                entry.lock.release()
                if entry.purge:
                    self.discard(entry)

    def response(self, plan, request):
        if not plan.bitrate:
            return AudioResponse(
                self.repository.root,
                plan.record,
                request,
                headers={
                    "X-Wildstring-Playback": "original",
                    "X-Wildstring-Codec": plan.source["codec"],
                },
            )
        headers = {
            "X-Wildstring-Playback": "transcode",
            "X-Wildstring-Codec": "aac",
            "X-Wildstring-Bitrate-Kbps": str(plan.bitrate),
            "X-Wildstring-Start-Ms": str(plan.start_ms),
            "X-Wildstring-Duration-Ms": str(plan.source["duration_ms"]),
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
        }
        if request.method == "HEAD":
            with self.lock:
                self.cleanup()
                if self.cache_state(plan) == "hit":
                    return AACResponse(self, self.acquire(plan), request, headers)
            response = Response(
                headers={
                    **headers,
                    "Accept-Ranges": "none",
                    "X-Wildstring-Cache": self.cache_state(plan),
                },
                media_type="audio/mp4",
            )
            del response.headers["content-length"]
            return response
        # Fast seek/quality switches may briefly overlap the previous bounded job.
        # Wait a little for admission without increasing the CPU concurrency limit.
        deadline = time.monotonic() + SLOT_WAIT_SECONDS
        while True:
            try:
                entry = self.acquire(plan)
                break
            except HTTPException as error:
                if error.status_code != 429 or time.monotonic() >= deadline:
                    raise
                if self.stopping.wait(0.05):
                    raise HTTPException(503, "transcoding_unavailable") from None
        return AACResponse(self, entry, request, headers)

    def overview(self):
        with self.lock:
            settings = self.settings()
            settings.pop("id")
            settings.pop("generation")
            with self.database.connect() as connection:
                count = connection.execute("SELECT count(*) FROM transcoding_cache").fetchone()[0]
            return {
                **settings,
                "cache_bytes": self.usage(),
                "cache_entries": count,
                "active_jobs": sum(
                    not entry.done.is_set() for entry in [*self.entries.values(), *self.retired]
                ),
                "ffmpeg_available": bool(shutil.which("ffmpeg") and shutil.which("ffprobe")),
            }

    def router(self, auth):
        router = APIRouter(
            prefix="/api/v1/manage/transcoding", dependencies=[Depends(auth.require_admin)]
        )

        @router.get("")
        def overview():
            return self.overview()

        @router.put("", dependencies=[Depends(auth.require_client)])
        def configure(body: CacheSettings):
            with self.lock, self.database.connect(write=True) as connection:
                result = connection.execute(
                    "UPDATE transcoding_settings SET retention_days=?,max_size_mb=?,max_concurrent=?,version=version+1 WHERE id=1 AND version=?",
                    (body.retention_days, body.max_size_mb, body.max_concurrent, body.version),
                )
                if result.rowcount != 1:
                    raise HTTPException(409, "settings_version_conflict")
            self.cleanup()
            return self.overview()

        @router.delete("/cache", dependencies=[Depends(auth.require_client)])
        def clear():
            return {**self.cleanup(clear=True), "cache": self.overview()}

        return router


class AACResponse(Response):
    def __init__(self, service, entry, request, headers):
        super().__init__()
        self.service, self.entry, self.request, self.output_headers = (
            service,
            entry,
            request,
            headers,
        )

    async def __call__(self, scope, receive, send):
        entry = self.entry
        try:
            await anyio.to_thread.run_sync(entry.ready.wait)
            if entry.error:
                raise HTTPException(503, entry.error)
            with ExitStack() as stack:
                with self.service.lock:
                    if entry.complete:
                        info = entry.final.stat()
                        record = {
                            "path": entry.final.name,
                            "size_bytes": info.st_size,
                            "mtime_ns": info.st_mtime_ns,
                            "format": "m4a",
                        }
                        cached = AudioResponse(
                            self.service.root,
                            record,
                            self.request,
                            headers={**self.output_headers, "X-Wildstring-Cache": "hit"},
                        )
                        source = None
                    else:
                        cached = None
                        source = stack.enter_context(
                            open_source(self.service.root, Path(entry.path.name))
                        )
                if cached:
                    await cached(scope, receive, send)
                    return

                async def chunks():
                    while True:
                        # Observe completion BEFORE reading: EOF can race the final write.
                        # If the writer finishes after an empty read, read again next turn.
                        finished = entry.done.is_set()
                        chunk = await anyio.to_thread.run_sync(source.read, 64 * 1024)
                        if chunk:
                            yield chunk
                        elif finished:
                            if entry.error:
                                raise OSError("Transcoding interrupted")
                            break
                        else:
                            await anyio.sleep(0.03)

                await StreamingResponse(
                    chunks(),
                    media_type="audio/mp4",
                    headers={
                        **self.output_headers,
                        "Accept-Ranges": "none",
                        "X-Wildstring-Cache": "encoding",
                    },
                )(scope, receive, send)
        finally:
            self.service.release(entry)
