"""Retained selected lyrics; community codecs live inside independently importable ZIPs."""

import json

from wildstring.library.lyrics import MAX_LINES, MAX_TEXT_BYTES, parse_lyrics


def normalize_bundle(raw, source):
    value = raw.get("normalized")
    if value is None:
        value = parse_lyrics(raw.get("original", ""), source)
        value["format"] = raw.get("format", "lrc")
    if (
        not isinstance(value, dict)
        or value.get("kind") not in {"none", "plain", "synced"}
        or not isinstance(value.get("lines"), list)
        or len(value["lines"]) > MAX_LINES
        or len(json.dumps(value).encode()) > 2 * 1024 * 1024
    ):
        raise ValueError("invalid_online_lyrics")

    def validate_lines(lines, synced=False):
        if not isinstance(lines, list) or len(lines) > MAX_LINES:
            raise ValueError("invalid_online_lyrics")
        for line in lines:
            if not isinstance(line, dict) or not isinstance(line.get("text"), str):
                raise ValueError("invalid_online_lyrics")
            if len(line["text"].encode()) > MAX_TEXT_BYTES:
                raise ValueError("invalid_online_lyrics")
            at = line.setdefault("time_ms", None)
            if (synced and at is None) or (
                at is not None and (type(at) is not int or not 0 <= at <= 86_400_000)
            ):
                raise ValueError("invalid_online_lyrics")
            end = line.get("end_ms")
            if end is not None and (
                type(end) is not int or at is None or not at <= end <= 86_400_000
            ):
                raise ValueError("invalid_online_lyrics")
            words = line.get("words", [])
            if not isinstance(words, list) or len(words) > 2000:
                raise ValueError("invalid_online_lyrics")
            for word in words:
                if (
                    not isinstance(word, dict)
                    or not isinstance(word.get("text"), str)
                    or type(word.get("start_ms")) is not int
                    or type(word.get("end_ms")) is not int
                    or not 0 <= word["start_ms"] <= word["end_ms"] <= 86_400_000
                ):
                    raise ValueError("invalid_online_lyrics")

    validate_lines(value["lines"], value["kind"] == "synced")
    if not isinstance(value.get("format", "lrc"), str) or len(value.get("format", "lrc")) > 32:
        raise ValueError("invalid_online_lyrics")
    layers = value.get("layers", {})
    if not isinstance(layers, dict) or set(layers) - {"translation", "romanization"}:
        raise ValueError("invalid_online_lyrics")
    for lines in layers.values():
        validate_lines(lines)
    value["source"] = source
    return value


def selected_lyrics(connection, selection):
    if not selection:
        return None
    try:
        selection = json.loads(selection)
        row = connection.execute(
            "SELECT normalized,source_id,source_url,plugin_id,created_at FROM lyric_candidates WHERE id=?",
            (selection["id"],),
        ).fetchone()
        if not row:
            return None
        result = json.loads(row["normalized"])
        offset = selection.get("offset_ms", 0)
        for line in result["lines"]:
            if line["time_ms"] is not None:
                line["time_ms"] = max(0, line["time_ms"] + offset)
            if "end_ms" in line:
                line["end_ms"] = max(0, line["end_ms"] + offset)
            for word in line.get("words", []):
                word["start_ms"] = max(0, word["start_ms"] + offset)
                word["end_ms"] = max(0, word["end_ms"] + offset)
        for layer in result.get("layers", {}).values():
            for line in layer:
                if line["time_ms"] is not None:
                    line["time_ms"] = max(0, line["time_ms"] + offset)
        return result | {
            "source_id": row["source_id"],
            "source_url": row["source_url"],
            "offset_ms": offset,
        }
    except (ValueError, KeyError, TypeError):
        return None
