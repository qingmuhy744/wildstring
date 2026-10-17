"""Versioned lyric overrides shared by all players; never modifies music or sidecars."""

import hashlib
import json
import re

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
        lyrics = self.assets.lyrics(track_id, include_override=False)
        signature = json.dumps([record, lyrics], sort_keys=True, ensure_ascii=False).encode()
        return lyrics, hashlib.sha256(signature).hexdigest()

    def read(self, track_id):
        with self.repository.database.connect() as connection:
            observed, file_version = self.observed(track_id)
            row = connection.execute(
                "SELECT * FROM track_lyrics WHERE track_id=?", (track_id,)
            ).fetchone()
        override = row["text"] if row else None
        effective = parse_lyrics(override, "user") if override is not None else observed
        if row and row["selected_candidate"]:
            from wildstring.library.online_lyrics import selected_lyrics

            with self.repository.database.connect() as connection:
                effective = selected_lyrics(connection, row["selected_candidate"]) or effective
        return {
            "track_id": track_id,
            "version": row["version"] if row else 1,
            "file_version": file_version,
            "override": override,
            "observed": observed,
            "observed_text": lyric_text(observed),
            "effective": effective,
            "text": override if override is not None else lyric_text(observed),
        }

    def preview(self, track_id, body):
        observed, _ = self.observed(track_id)
        return parse_lyrics(body.text, "user") if body.text is not None else observed

    def save(self, track_id, body):
        with self.repository.database.connect(write=True) as connection:
            connection.execute("BEGIN IMMEDIATE")
            _, signature = self.observed(track_id)
            row = connection.execute(
                "SELECT version FROM track_lyrics WHERE track_id=?", (track_id,)
            ).fetchone()
            if signature != body.file_version or (row[0] if row else 1) != body.version:
                raise HTTPException(409, "lyrics_version_conflict")
            connection.execute(
                "INSERT INTO track_lyrics(track_id,text,version) VALUES (?,?,?) "
                "ON CONFLICT(track_id) DO UPDATE SET text=excluded.text,version=excluded.version,selected_candidate=NULL",
                (track_id, body.text, body.version + 1),
            )
        return self.read(track_id)
