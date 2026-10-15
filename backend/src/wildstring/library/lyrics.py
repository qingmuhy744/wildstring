"""Bounded local lyrics with line-level LRC timestamps; never synthesize timing."""

import re
from collections import defaultdict

MAX_TEXT_BYTES = 512 * 1024
MAX_LINES = 5000
TIMESTAMP = re.compile(r"\[(\d{1,4}):([0-5]\d)(?:[.:](\d{1,3}))?\]")
META = re.compile(r"^\[[a-zA-Z][a-zA-Z0-9_]*:.*\]$")
OFFSET = re.compile(r"\[offset:([+-]?\d{1,8})\]", re.IGNORECASE)
WORD_TIME = re.compile(r"<\d{1,4}:[0-5]\d(?:[.:]\d{1,3})?>")


def no_lyrics() -> dict:
    return {"kind": "none", "source": None, "lines": []}


def decode_text(data: bytes) -> str | None:
    if len(data) > MAX_TEXT_BYTES:
        return None
    encodings = (
        ["utf-16"] if data.startswith((b"\xff\xfe", b"\xfe\xff")) else ["utf-8-sig", "gb18030"]
    )
    for encoding in encodings:
        try:
            text = data.decode(encoding)
            if "\x00" not in text:
                return text
        except UnicodeError:
            continue
    return None


def synced_lines(entries: list[tuple[int, str]], source: str) -> dict:
    if (
        sum(len(text.encode("utf-8", errors="replace")) for _, text in entries[:MAX_LINES])
        > MAX_TEXT_BYTES
    ):
        return no_lyrics()
    grouped: dict[int, list[str]] = defaultdict(list)
    for timestamp, text in entries[:MAX_LINES]:
        if text not in grouped[max(0, timestamp)]:
            grouped[max(0, timestamp)].append(text)
    return {
        "kind": "synced",
        "source": source,
        "lines": [
            {"time_ms": timestamp, "text": "\n".join(text)}
            for timestamp, text in sorted(grouped.items())
        ],
    }


def parse_lyrics(text: str, source: str) -> dict:
    if len(text.encode("utf-8", errors="replace")) > MAX_TEXT_BYTES:
        return no_lyrics()
    entries: list[tuple[int, str]] = []
    plain: list[dict] = []
    offsets = OFFSET.findall(text)
    offset = int(offsets[-1]) if offsets else 0
    for line in text.splitlines()[:MAX_LINES]:
        line = line.strip().lstrip("\ufeff")
        if not line:
            continue
        matches = list(TIMESTAMP.finditer(line))
        if matches:
            body = WORD_TIME.sub("", TIMESTAMP.sub("", line)).strip()
            for match in matches:
                minute, second, fraction = match.groups()
                milliseconds = (int(minute) * 60 + int(second)) * 1000 + int(
                    (fraction or "0").ljust(3, "0")
                )
                # LRC positive offset advances lyric display.
                entries.append((milliseconds - offset, body))
                if len(entries) >= MAX_LINES:
                    break
        elif not META.fullmatch(line):
            plain.append({"time_ms": None, "text": line})
        if len(entries) >= MAX_LINES:
            break
    if entries:
        return synced_lines(entries, source)
    return {"kind": "plain", "source": source, "lines": plain} if plain else no_lyrics()
