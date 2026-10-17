"""Explicit, versioned playback snapshots; reading never controls another device."""

import json
from typing import Literal

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, model_validator

from wildstring.library.repository import now


class PlaybackState(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    version: int = Field(ge=0, strict=True)
    device_id: str = Field(min_length=1, max_length=128)
    track_ids: list[str] = Field(max_length=10_000)
    index: int = Field(ge=0, strict=True)
    position_ms: int = Field(ge=0, le=86_400_000, strict=True)
    mode: Literal["sequential", "repeat_all", "repeat_one", "shuffle"] = "sequential"

    @model_validator(mode="after")
    def valid_queue(self):
        if any(not identity or len(identity) > 128 for identity in self.track_ids):
            raise ValueError("Invalid track ID")
        if (self.track_ids and self.index >= len(self.track_ids)) or (
            not self.track_ids and (self.index or self.position_ms)
        ):
            raise ValueError("Invalid queue position")
        if any(ord(character) < 32 for character in self.device_id):
            raise ValueError("Invalid device ID")
        return self


def available_tracks(repository, connection, identities):
    """Validate in chunks below SQLite's portable parameter limit."""
    found = {}
    unique = list(dict.fromkeys(identities))
    for offset in range(0, len(unique), 400):
        batch = unique[offset : offset + 400]
        rows = connection.execute(
            "SELECT id,duration_ms FROM tracks WHERE library_id=? AND status='available' "
            "AND id IN (SELECT value FROM json_each(?))",
            (repository.library_id(), json.dumps(batch)),
        ).fetchall()
        found.update({row["id"]: row["duration_ms"] for row in rows})
    return found


def get_state(repository):
    initial = {
        "version": 0,
        "device_id": "",
        "track_ids": [],
        "index": 0,
        "position_ms": 0,
        "mode": "sequential",
        "updated_at": None,
    }
    with repository.database.connect() as connection:
        row = connection.execute(
            "SELECT * FROM playback_states WHERE user_id=? AND library_id=?",
            (repository.database.user_id, repository.library_id()),
        ).fetchone()
        if not row:
            return initial
        identities = json.loads(row["track_ids"])
        available = available_tracks(repository, connection, identities)
    # A rescan or deletion may invalidate a saved queue. Keep the same playing song if possible.
    original_index = row["position_index"]
    filtered = [identity for identity in identities if identity in available]
    before = sum(identity in available for identity in identities[:original_index])
    index = min(before, max(0, len(filtered) - 1))
    same = bool(identities and identities[original_index] in available)
    return {
        "version": row["version"],
        "device_id": row["device_id"],
        "track_ids": filtered,
        "index": index,
        "position_ms": min(row["position_ms"], available.get(filtered[index], 0))
        if same and filtered
        else 0,
        "mode": row["mode"],
        "updated_at": row["updated_at"],
    }


def put_state(repository, body):
    library_id = repository.library_id(create=True)
    updated_at = now()
    with repository.database.connect(write=True) as connection:
        connection.execute("BEGIN IMMEDIATE")
        row = connection.execute(
            "SELECT version FROM playback_states WHERE user_id=? AND library_id=?",
            (repository.database.user_id, library_id),
        ).fetchone()
        version = row["version"] if row else 0
        if body.version != version:
            raise HTTPException(409, "playback_version_conflict")
        available = available_tracks(repository, connection, body.track_ids)
        if any(identity not in available for identity in body.track_ids):
            raise HTTPException(422, "playback_track_unavailable")
        if body.track_ids and body.position_ms > available[body.track_ids[body.index]]:
            raise HTTPException(422, "playback_position_invalid")
        connection.execute(
            """INSERT INTO playback_states VALUES (?,?,?,?,?,?,?,?,?)
            ON CONFLICT(user_id,library_id) DO UPDATE SET version=excluded.version,
            device_id=excluded.device_id,track_ids=excluded.track_ids,
            position_index=excluded.position_index,position_ms=excluded.position_ms,
            mode=excluded.mode,updated_at=excluded.updated_at""",
            (
                repository.database.user_id,
                library_id,
                version + 1,
                body.device_id,
                json.dumps(body.track_ids),
                body.index,
                body.position_ms,
                body.mode,
                updated_at,
            ),
        )
    return body.model_dump() | {"version": body.version + 1, "updated_at": updated_at}
