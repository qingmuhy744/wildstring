"""HTTP conditional caching helpers for private authenticated image responses."""

from __future__ import annotations

import hashlib
from collections.abc import Mapping

from fastapi import Request, Response


def etag_matches(if_none_match: str | None, etag: str) -> bool:
    """Return True when If-None-Match matches the strong ETag per RFC 9110 weak comparison."""
    if not if_none_match:
        return False
    target = etag.strip()
    if target.startswith("W/"):
        target = target[2:].strip()
    for candidate in if_none_match.split(","):
        token = candidate.strip()
        if not token:
            continue
        if token == "*":
            return True
        if token.startswith("W/"):
            token = token[2:].strip()
        if token == target:
            return True
    return False


def private_image_response(
    request: Request | None,
    data: bytes,
    *,
    media_type: str = "image/jpeg",
    extra_headers: Mapping[str, str] | None = None,
) -> Response:
    """Build a private conditional-cache image response with SHA-256 ETag and 304 support."""
    etag = f'"{hashlib.sha256(data).hexdigest()}"'
    headers = {
        "Cache-Control": "private, no-cache",
        "ETag": etag,
        "Vary": "Cookie, Authorization, X-Wildstring-Library",
        "X-Content-Type-Options": "nosniff",
    }
    if extra_headers:
        headers.update(extra_headers)
    if (
        request is not None
        and request.method in ("GET", "HEAD")
        and etag_matches(request.headers.get("if-none-match"), etag)
    ):
        return Response(status_code=304, headers=headers)
    return Response(data, media_type=media_type, headers=headers)
