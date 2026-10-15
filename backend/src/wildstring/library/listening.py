"""Idempotent listening reports and per-user favorites."""

import time
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from wildstring.library.repository import LibraryRepository, now


class FavoriteUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    loved: bool = Field(strict=True)


class ListeningReport(BaseModel):
    model_config = ConfigDict(extra="forbid")
    session_id: UUID
    track_id: str = Field(min_length=1, max_length=128)
    listened_ms: int = Field(ge=0, le=86_400_000, strict=True)


def listening_router(repository, auth):
    router = APIRouter(prefix="/api/v1", dependencies=[Depends(auth.require_session)])

    def scoped(user: Annotated[dict, Depends(auth.require_session)]):
        return repository.for_user(user["id"])

    @router.put("/tracks/{track_id}/favorite", dependencies=[Depends(auth.require_client)])
    def favorite(
        track_id: str, body: FavoriteUpdate, current: Annotated[LibraryRepository, Depends(scoped)]
    ):
        with current.database.connect(write=True) as connection:
            connection.execute("BEGIN IMMEDIATE")
            if (
                connection.execute(
                    "SELECT 1 FROM tracks WHERE id=? AND library_id=?",
                    (track_id, current.library_id()),
                ).fetchone()
                is None
            ):
                raise HTTPException(404, "track_not_found")
            connection.execute(
                """INSERT INTO user_track_state(user_id,track_id,loved,loved_at) VALUES (?,?,?,?)
                ON CONFLICT(user_id,track_id) DO UPDATE SET loved=excluded.loved,
                loved_at=CASE WHEN excluded.loved THEN COALESCE(user_track_state.loved_at,excluded.loved_at) ELSE NULL END""",
                (current.database.user_id, track_id, body.loved, now() if body.loved else None),
            )
        return {"track_id": track_id, "loved": body.loved}

    @router.post("/listening", dependencies=[Depends(auth.require_client)])
    def report(body: ListeningReport, current: Annotated[LibraryRepository, Depends(scoped)]):
        with current.database.connect(write=True) as connection:
            connection.execute("BEGIN IMMEDIATE")
            track = connection.execute(
                "SELECT * FROM personal_tracks WHERE id = ? AND library_id = ?",
                (body.track_id, current.library_id()),
            ).fetchone()
            if track is None:
                raise HTTPException(404, "track_not_found")
            session_id, clock = str(body.session_id), time.time()
            session = connection.execute(
                "SELECT * FROM listening_sessions WHERE id = ?", (session_id,)
            ).fetchone()
            if session is None:
                # Allow one heartbeat of initial buffering/network latency, not an offline bulk upload.
                connection.execute(
                    "INSERT INTO listening_sessions(id, track_id, started_at, user_id) VALUES (?, ?, ?, ?)",
                    (
                        session_id,
                        body.track_id,
                        clock - min(body.listened_ms, 10_000) / 1000,
                        current.database.user_id,
                    ),
                )
                session = connection.execute(
                    "SELECT * FROM listening_sessions WHERE id = ?", (session_id,)
                ).fetchone()
            if (
                session["track_id"] != body.track_id
                or session["user_id"] != current.database.user_id
            ):
                raise HTTPException(409, "listening_session_conflict")
            elapsed = max(0, int((clock - session["started_at"]) * 1000)) + 1000
            accepted = max(session["reported_ms"], min(body.listened_ms, elapsed, 21_600_000))
            delta = accepted - session["reported_ms"]
            counted = bool(session["counted"]) or accepted >= min(track["duration_ms"] / 2, 240_000)
            increment = int(counted and not session["counted"])
            connection.execute(
                "UPDATE listening_sessions SET reported_ms = ?, counted = ? WHERE id = ?",
                (accepted, counted, session_id),
            )
            if delta:
                connection.execute(
                    """INSERT INTO user_track_state(user_id,track_id,listened_ms,play_count,last_played_at)
                    VALUES (?,?,?,?,?) ON CONFLICT(user_id,track_id) DO UPDATE SET
                    listened_ms=user_track_state.listened_ms+excluded.listened_ms,
                    play_count=user_track_state.play_count+excluded.play_count,last_played_at=excluded.last_played_at""",
                    (current.database.user_id, body.track_id, delta, increment, now()),
                )
            return {
                "play_count": track["play_count"] + increment,
                "listened_ms": track["listened_ms"] + delta,
                "accepted_ms": accepted,
            }

    @router.get("/listening/summary")
    def summary(current: Annotated[LibraryRepository, Depends(scoped)]):
        with current.database.connect() as connection:
            row = connection.execute(
                """SELECT COALESCE(sum(play_count), 0) AS play_count,
                COALESCE(sum(listened_ms), 0) AS listened_ms,
                sum(CASE WHEN last_played_at IS NOT NULL THEN 1 ELSE 0 END) AS tracks_played,
                sum(CASE WHEN loved AND status = 'available' THEN 1 ELSE 0 END) AS favorites,
                max(last_played_at) AS last_played_at FROM personal_tracks WHERE library_id = ?""",
                (current.library_id(),),
            ).fetchone()
        return {
            key: value if value is not None or key == "last_played_at" else 0
            for key, value in dict(row).items()
        }

    @router.get("/favorites/ids")
    def favorite_ids(current: Annotated[LibraryRepository, Depends(scoped)]):
        with current.database.connect() as connection:
            rows = connection.execute(
                "SELECT id FROM personal_tracks WHERE library_id = ? AND loved = 1",
                (current.library_id(),),
            ).fetchall()
        return {"ids": [row["id"] for row in rows]}

    return router
