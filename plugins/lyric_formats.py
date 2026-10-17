"""Bounded normalized word timing, informed by LDDC's QRC/KRC/YRC parsers.

Format references: https://github.com/chenmozhijin/LDDC (GPL-3.0-only).
QRC/YRC word starts are absolute; KRC word starts are relative to the line.
The platform adapters handle decryption; no Qt or desktop application is loaded.
"""

import base64
import html
import json
import re

from wildstring.plugin_api import MAX_LINES, MAX_TEXT_BYTES, parse_lyrics

LINE = re.compile("^\\[(\\d+),(\\d+)\\](.*)$")
WORDS = {
    "qrc": re.compile("(.*?)\\((\\d+),(\\d+)\\)"),
    "krc": re.compile("<(\\d+),(\\d+),\\d+>(.*?)(?=<\\d+,\\d+,\\d+>|$)"),
    "yrc": re.compile("\\((\\d+),(\\d+),\\d+\\)(.*?)(?=\\(\\d+,\\d+,\\d+\\)|$)"),
}


def parse_online(text, format_name, source):
    if not isinstance(text, str) or len(text.encode()) > MAX_TEXT_BYTES or "\x00" in text:
        raise ValueError("invalid_online_lyrics")
    if format_name == "qrc":
        match = re.search('LyricContent="(.*?)"\\s*/>', text, re.DOTALL)
        if match:
            text = html.unescape(match[1])
    lines = []
    pattern = WORDS.get(format_name)
    if pattern:
        for raw_line in text.splitlines()[:MAX_LINES]:
            match = LINE.match(raw_line.strip())
            if not match:
                continue
            start, duration, body = match.groups()
            start, end = (int(start), int(start) + int(duration))
            if end > 86400000:
                raise ValueError("invalid_online_lyrics")
            words = []
            for word in pattern.finditer(body):
                a, b, c = word.groups()
                word_text, at, length = (
                    (a, int(b), int(c)) if format_name == "qrc" else (c, int(a), int(b))
                )
                if format_name == "krc":
                    at += start
                if not start <= at <= at + length <= end + 1000:
                    raise ValueError("invalid_online_lyrics")
                words.append({"start_ms": at, "end_ms": at + length, "text": word_text})
                if len(words) > 2000:
                    raise ValueError("invalid_online_lyrics")
            if words:
                lines.append(
                    {
                        "time_ms": start,
                        "end_ms": end,
                        "text": "".join(word["text"] for word in words),
                        "words": words,
                    }
                )
    result = (
        {
            "kind": "synced",
            "source": source,
            "lines": sorted(lines, key=lambda line: line["time_ms"]),
        }
        if lines
        else parse_lyrics(text, source)
    )
    result["format"] = format_name
    return result


def normalize_bundle(raw, source):
    result = parse_online(raw.get("original", ""), raw.get("format", "lrc"), source)
    result["layers"] = {}
    for field in ("translation", "romanization"):
        if raw.get(field):
            result["layers"][field] = parse_online(raw[field], raw.get("format", "lrc"), source)[
                "lines"
            ]
    if raw.get("format") == "krc":
        language = re.search("\\[language:([^\\]]+)\\]", raw.get("original", ""))
        if language:
            try:
                data = json.loads(base64.b64decode(language[1], validate=True))
                for item in data.get("content", [])[:3]:
                    field = "romanization" if item.get("type") == 0 else "translation"
                    values = item.get("lyricContent", [])
                    if isinstance(values, list) and len(values) == len(result["lines"]):
                        result["layers"][field] = [
                            {
                                "time_ms": line["time_ms"],
                                "text": "".join(str(v) for v in values[index])[:4000],
                            }
                            for index, line in enumerate(result["lines"])
                        ]
            except (ValueError, KeyError, TypeError):
                pass
    return result
