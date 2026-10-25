"""Durable episode bookmarks, independent of the live music queue.

A new listening session compares the revision it observed. Subsequent checkpoints
are ordered within that session; retrying an old session cannot acquire ownership.
"""

from typing import Literal

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field

from wildstring.library.repository import now

SCHEMA = """
BEGIN IMMEDIATE;
ALTER TABLE podcast_progress ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE podcast_progress ADD COLUMN session_id TEXT NOT NULL DEFAULT '';
ALTER TABLE podcast_progress ADD COLUMN device_id TEXT NOT NULL DEFAULT '';
ALTER TABLE podcast_progress ADD COLUMN sequence INTEGER NOT NULL DEFAULT 0;
PRAGMA user_version = 34;
COMMIT;
"""


class ProgressWrite(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    session_id: str = Field(min_length=16, max_length=128)
    device_id: str = Field(min_length=1, max_length=128)
    base_version: int = Field(ge=0, strict=True)
    sequence: int = Field(ge=1, strict=True)
    position_seconds: int = Field(ge=0, le=31_536_000, strict=True)
    duration_seconds: int = Field(ge=0, le=31_536_000, strict=True)
    event: Literal["play", "progress", "pause", "seek", "stop", "ended"]


class ProgressState(BaseModel):
    episode_id: str
    version: int = 0
    session_id: str = ""
    device_id: str = ""
    sequence: int = 0
    position_seconds: int = 0
    duration_seconds: int = 0
    completed: bool = False
    updated_at: str | None = None


def state(connection, user_id, episode_id):
    if not connection.execute(
        "SELECT 1 FROM podcast_episodes WHERE id=?", (episode_id,)
    ).fetchone():
        raise HTTPException(404, "podcast_episode_not_found")
    row = connection.execute(
        "SELECT * FROM podcast_progress WHERE user_id=? AND episode_id=?", (user_id, episode_id)
    ).fetchone()
    if row is None:
        return ProgressState(episode_id=episode_id)
    return ProgressState(**dict(row), updated_at=row["last_listened_at"])


def get_progress(database, user_id, episode_id):
    with database.connect() as connection:
        return state(connection, user_id, episode_id)


def save_progress(manager, user_id, episode_id, body: ProgressWrite):
    with manager.database.connect(write=True) as connection:
        connection.execute("BEGIN IMMEDIATE")
        current = state(connection, user_id, episode_id)
        same_session = current.session_id == body.session_id and current.device_id == body.device_id
        if not same_session and body.base_version != current.version:
            raise HTTPException(
                409, {"code": "podcast_progress_conflict", "current": current.model_dump()}
            )
        if same_session and body.sequence <= current.sequence:
            return current
        # Position is intentionally not monotonic: a newer seek can rewind.
        duration = body.duration_seconds or current.duration_seconds
        position = min(body.position_seconds, duration) if duration else body.position_seconds
        completed = body.event == "ended" and (not duration or position >= duration - 2)
        if same_session and current.completed and body.event in ("pause", "stop", "progress"):
            completed = completed or position == current.position_seconds
        connection.execute(
            """INSERT INTO podcast_progress
            (user_id,episode_id,position_seconds,duration_seconds,completed,last_listened_at,
             version,session_id,device_id,sequence) VALUES (?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(user_id,episode_id) DO UPDATE SET
              position_seconds=excluded.position_seconds,duration_seconds=excluded.duration_seconds,
              completed=excluded.completed,last_listened_at=excluded.last_listened_at,
              version=excluded.version,session_id=excluded.session_id,
              device_id=excluded.device_id,sequence=excluded.sequence""",
            (
                user_id,
                episode_id,
                position,
                duration,
                int(completed),
                now(),
                current.version + 1,
                body.session_id,
                body.device_id,
                body.sequence,
            ),
        )
        return state(connection, user_id, episode_id)
