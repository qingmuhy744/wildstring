"""Seekable original audio, read from the same verified descriptor for the whole request."""

import hashlib
import os
import re
from email.utils import formatdate
from pathlib import Path

import anyio
from fastapi import HTTPException, Request
from starlette.responses import Response, StreamingResponse

from wildstring.library.scanner import open_source

MEDIA_TYPES = {"mp3": "audio/mpeg", "flac": "audio/flac", "m4a": "audio/mp4"}


def byte_range(value: str | None, size: int) -> tuple[int, int] | None:
    # Unknown units and multipart ranges are ignored and receive the full representation.
    if value is None or not value.startswith("bytes=") or "," in value:
        return None
    match = re.fullmatch(r"bytes=(\d*)-(\d*)", value)
    if not match or not any(match.groups()) or size == 0:
        raise ValueError("Unsatisfiable range")
    first, last = match.groups()
    # Bound integer parsing (including Python's integer-string limit).
    if max(len(first), len(last)) > 20:
        raise ValueError("Unsatisfiable range")
    if not first:
        length = int(last)
        if length == 0:
            raise ValueError("Unsatisfiable range")
        return max(0, size - length), size - 1
    start = int(first)
    end = min(int(last), size - 1) if last else size - 1
    if start >= size or start > end:
        raise ValueError("Unsatisfiable range")
    return start, end


class AudioResponse(Response):
    def __init__(self, root: Path, record: dict, request: Request, headers: dict | None = None):
        super().__init__()
        self.root = root
        self.record = record
        self.request = request
        self.output_headers = headers or {}

    async def __call__(self, scope, receive, send):
        try:
            with open_source(self.root, Path(self.record["path"])) as source:
                info = os.fstat(source.fileno())
                if (info.st_size, info.st_mtime_ns) != (
                    self.record["size_bytes"],
                    self.record["mtime_ns"],
                ):
                    raise HTTPException(409, "file_changed_rescan_required")
                await self.send_audio(source, info, scope, receive, send)
        except (FileNotFoundError, NotADirectoryError) as error:
            raise HTTPException(404, "audio_not_found") from error
        except OSError as error:
            # Errors after response start (e.g. disconnect) must propagate without a second response.
            if getattr(self, "started", False):
                raise
            raise HTTPException(409, "audio_unavailable") from error

    async def send_audio(self, source, info, scope, receive, send):
        stamp = f"{info.st_dev}:{info.st_ino}:{info.st_size}:{info.st_mtime_ns}"
        etag = f'"{hashlib.sha256(stamp.encode()).hexdigest()}"'
        modified = formatdate(info.st_mtime, usegmt=True)
        headers = {
            "Accept-Ranges": "bytes",
            "ETag": etag,
            "Last-Modified": modified,
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
            **self.output_headers,
        }
        requested = self.request.headers.get("range") if self.request.method == "GET" else None
        if self.request.headers.get("if-range", etag) not in {etag, modified}:
            requested = None
        try:
            selected = byte_range(requested, info.st_size)
        except ValueError:
            headers["Content-Range"] = f"bytes */{info.st_size}"
            await Response(status_code=416, headers=headers)(scope, receive, send)
            return
        start, end = selected if selected is not None else (0, info.st_size - 1)
        length = end - start + 1
        headers["Content-Length"] = str(length)
        if selected is not None:
            headers["Content-Range"] = f"bytes {start}-{end}/{info.st_size}"
        if self.request.method == "HEAD":
            response = Response(headers=headers, media_type=MEDIA_TYPES[self.record["format"]])
        else:
            source.seek(start)

            async def chunks():
                remaining = length
                while remaining:
                    chunk = await anyio.to_thread.run_sync(source.read, min(256 * 1024, remaining))
                    if not chunk:
                        raise OSError("Audio changed while streaming")
                    remaining -= len(chunk)
                    yield chunk

            response = StreamingResponse(
                chunks(),
                status_code=206 if selected is not None else 200,
                headers=headers,
                media_type=MEDIA_TYPES[self.record["format"]],
            )
        self.started = True
        await response(scope, receive, send)
