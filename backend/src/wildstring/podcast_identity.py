"""Stable identities for one podcast programme across feed hosts and directories."""

import re
from urllib.parse import urlsplit

ITUNES_ID = re.compile(r"^[1-9][0-9]{0,19}$")


def normalize_feed_url(value: str | None) -> str:
    """Return a comparison key for one feed URL, or an empty string when it is unusable.

    The key ignores the scheme, letter case in the host, default ports, a trailing slash,
    repeated slashes and fragments. The query string stays significant because many hosts
    use it to select a feed.
    """
    raw = (value or "").strip()
    if not raw:
        return ""
    try:
        parts = urlsplit(raw)
        port = parts.port
    except ValueError:
        return ""
    if parts.scheme.lower() not in {"http", "https"} or not parts.hostname:
        return ""
    host = parts.hostname.rstrip(".").lower()
    if ":" in host:
        host = f"[{host}]"
    netloc = host if port in (None, 80, 443) else f"{host}:{port}"
    path = re.sub(r"/{2,}", "/", parts.path).rstrip("/")
    return f"{netloc}{path}" + (f"?{parts.query}" if parts.query else "")


def valid_itunes_id(value: object) -> str | None:
    text = str(value).strip() if value is not None else ""
    return text if ITUNES_ID.fullmatch(text) else None


def feed_keys(*urls: str | None) -> set[str]:
    return {key for key in (normalize_feed_url(url) for url in urls) if key}
