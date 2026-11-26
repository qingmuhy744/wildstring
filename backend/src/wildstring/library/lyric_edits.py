"""Versioned lyric overrides shared by all players; never modifies music or sidecars."""

import hashlib
import json
import re
from contextlib import suppress

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, model_validator

from wildstring.library.assets import TrackAssets
from wildstring.library.lyrics import MAX_LINES, MAX_TEXT_BYTES, META, TIMESTAMP, parse_lyrics


class LyricsText(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    text: str | None = Field(max_length=MAX_TEXT_BYTES)

    @model_validator(mode="after")
    def bounded_lyrics(self):
        if self.text is None:
            return self
        try:
            size = len(self.text.encode("utf-8"))
        except UnicodeError:
            raise ValueError("Invalid lyric encoding") from None
        self.text = self.text.replace("\r\n", "\n").replace("\r", "\n")
        lines = self.text.splitlines()
        if size > MAX_TEXT_BYTES or len(lines) > MAX_LINES or "\x00" in self.text:
            raise ValueError("Lyrics exceed limits or contain null bytes")
        timestamps = list(TIMESTAMP.finditer(self.text))
        if len(timestamps) > MAX_LINES:
            raise ValueError("Too many timed lines")
        for line in lines:
            line = line.strip().lstrip("\ufeff")
            if re.match(r"^\[\d+:", line) and not TIMESTAMP.search(line):
                raise ValueError("Invalid lyric timestamp")
            if timestamps and line and not TIMESTAMP.search(line) and not META.fullmatch(line):
                raise ValueError("Each lyric line must have a timestamp")
        return self


class LyricsUpdate(LyricsText):
    version: int = Field(ge=1, strict=True)
    file_version: str = Field(pattern=r"^[0-9a-f]{64}$")


def lyric_text(lyrics):
    lines = []
    for line in lyrics["lines"]:
        timestamp = line["time_ms"]
        prefix = ""
        if timestamp is not None:
            minutes, rest = divmod(timestamp, 60_000)
            seconds, milliseconds = divmod(rest, 1000)
            prefix = f"[{minutes:02}:{seconds:02}.{milliseconds:03}]"
        lines.extend(prefix + text for text in line["text"].split("\n"))
    return "\n".join(lines)


class LyricsEditor:
    def __init__(self, repository):
        self.repository = repository
        self.assets = TrackAssets(repository)

    def observed(self, track_id):
        record = self.repository.source(track_id)
        if record is None:
            raise HTTPException(404, "track_not_found")
        stable = {key: value for key, value in record.items() if key != "sha256"}
        lyrics = self.assets.lyrics(track_id, include_override=False)
        signature = json.dumps([stable, lyrics], sort_keys=True, ensure_ascii=False).encode()
        return lyrics, hashlib.sha256(signature).hexdigest()

    def read(self, track_id):
        with self.repository.database.connect() as connection:
            observed, file_version = self.observed(track_id)
            row = connection.execute(
                "SELECT * FROM track_lyrics WHERE track_id=?", (track_id,)
            ).fetchone()
        override = row["text"] if row else None
        effective = parse_lyrics(override, "user") if override is not None else observed
        resolved_candidate = False
        if row and row["selected_candidate"]:
            from wildstring.library.online_lyrics import selected_lyrics

            with self.repository.database.connect() as connection:
                candidate = selected_lyrics(connection, row["selected_candidate"])
                if candidate is not None:
                    effective = candidate
                    resolved_candidate = True
        if not resolved_candidate and row and row["portable_bundle"]:
            from wildstring.library.online_lyrics import display_lyrics

            with suppress(ValueError, KeyError, TypeError):
                effective = display_lyrics(json.loads(row["portable_bundle"]))
        return {
            "track_id": track_id,
            "version": row["version"] if row else 1,
            "file_version": file_version,
            "override": override,
            "selected_candidate": row["selected_candidate"] if row else None,
            "observed": observed,
            "observed_text": lyric_text(observed),
            "effective": effective,
            "text": override if override is not None else lyric_text(effective),
        }

    def preview(self, track_id, body):
        observed, _ = self.observed(track_id)
        return parse_lyrics(body.text, "user") if body.text is not None else observed

    def save(self, track_id, body):
        with self.repository.database.connect(write=True) as connection:
            connection.execute("BEGIN IMMEDIATE")
            _, signature = self.observed(track_id)
            row = connection.execute(
                "SELECT version, text, selected_candidate, portable_bundle FROM track_lyrics WHERE track_id=?",
                (track_id,),
            ).fetchone()
            current_ver = row["version"] if row else 1
            if signature != body.file_version or current_ver != body.version:
                raise HTTPException(409, "lyrics_version_conflict")

            keep_candidate = False
            keep_bundle = False
            if body.text is not None and row and row["selected_candidate"]:
                from wildstring.library.online_lyrics import selected_lyrics

                cand_lyrics = selected_lyrics(connection, row["selected_candidate"])
                if cand_lyrics and lyric_text(cand_lyrics) == body.text:
                    keep_candidate = True
            if body.text is not None and not keep_candidate and row and row["portable_bundle"]:
                with suppress(ValueError, KeyError, TypeError):
                    existing_bundle = json.loads(row["portable_bundle"])
                    if lyric_text(existing_bundle) == body.text:
                        keep_bundle = True

            cand_val = row["selected_candidate"] if (keep_candidate and row) else None
            bundle_val = (
                row["portable_bundle"] if ((keep_candidate or keep_bundle) and row) else None
            )
            connection.execute(
                "INSERT INTO track_lyrics(track_id,text,version,selected_candidate,portable_bundle) VALUES (?,?,?,?,?) "
                "ON CONFLICT(track_id) DO UPDATE SET text=excluded.text,version=excluded.version,"
                "selected_candidate=excluded.selected_candidate,portable_bundle=excluded.portable_bundle",
                (track_id, body.text, body.version + 1, cand_val, bundle_val),
            )
        return self.read(track_id)
