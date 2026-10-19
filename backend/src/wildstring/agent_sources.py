"""Public evidence links preserve known music IDs without forwarding credentials."""

import re
from urllib.parse import parse_qs, urlencode, urlsplit, urlunsplit


def evidence_url(value):
    try:
        parts = urlsplit(value)
        if (
            parts.scheme != "https"
            or not parts.hostname
            or parts.username
            or parts.password
            or parts.port not in (None, 443)
            or any(ord(c) < 32 for c in value)
        ):
            return None
        query = fragment = ""
        if parts.hostname in {"music.163.com", "y.music.163.com"}:
            identity = parse_qs(parts.query).get("id", [""])[0]
            if re.fullmatch(r"[0-9]{1,20}", identity):
                query = urlencode({"id": identity})
        if parts.hostname in {"www.kugou.com", "kugou.com"}:
            identity = parse_qs(parts.fragment).get("hash", [""])[0]
            if re.fullmatch(r"[0-9a-fA-F]{32}", identity):
                fragment = "hash=" + identity
        return urlunsplit((parts.scheme, parts.netloc, parts.path, query, fragment))
    except (ValueError, TypeError):
        return None
