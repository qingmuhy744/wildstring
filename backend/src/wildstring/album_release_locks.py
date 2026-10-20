"""Album-level release locks used by metadata refresh and curation."""

import json
from datetime import UTC, datetime

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field

SCHEMA = """
BEGIN IMMEDIATE;
CREATE TABLE IF NOT EXISTS album_release_locks (
    album_id TEXT PRIMARY KEY,
    library_id TEXT NOT NULL REFERENCES libraries(id),
    provider TEXT NOT NULL,
    release_id TEXT NOT NULL,
    source_url TEXT NOT NULL DEFAULT '',
    snapshot TEXT NOT NULL DEFAULT '{}',
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS album_release_locks_library
    ON album_release_locks(library_id, updated_at);
PRAGMA user_version = 24;
COMMIT;
"""


class ReleaseLockInput(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    provider: str = Field(min_length=1, max_length=100)
    release_id: str = Field(min_length=1, max_length=256)
    source_url: str = Field(default="", max_length=2048)
    snapshot: dict = Field(default_factory=dict)
    version: int | None = Field(default=None, ge=1, strict=True)


def _public(row):
    if row is None:
        return None
    result = dict(row)
    result["snapshot"] = json.loads(result["snapshot"] or "{}")
    return result


def read(connection, library_id, album_id):
    row = connection.execute(
        "SELECT * FROM album_release_locks WHERE library_id=? AND album_id=?",
        (library_id, album_id),
    ).fetchone()
    return _public(row)


def ensure_album(connection, library_id, album_id):
    if not connection.execute(
        "SELECT 1 FROM tracks WHERE library_id=? AND album_id=? AND status='available' LIMIT 1",
        (library_id, album_id),
    ).fetchone():
        raise HTTPException(404, "album_not_found")


def save(connection, library_id, album_id, body: ReleaseLockInput):
    ensure_album(connection, library_id, album_id)
    current = read(connection, library_id, album_id)
    if body.version is not None and (current is None or current["version"] != body.version):
        raise HTTPException(409, "release_lock_version_conflict")
    timestamp = datetime.now(UTC).isoformat()
    if current is None:
        connection.execute(
            """INSERT INTO album_release_locks
            (album_id,library_id,provider,release_id,source_url,snapshot,version,created_at,updated_at)
            VALUES (?,?,?,?,?,?,1,?,?)""",
            (
                album_id,
                library_id,
                body.provider,
                body.release_id,
                body.source_url,
                json.dumps(body.snapshot, ensure_ascii=False),
                timestamp,
                timestamp,
            ),
        )
    else:
        connection.execute(
            """UPDATE album_release_locks
            SET provider=?,release_id=?,source_url=?,snapshot=?,version=version+1,updated_at=?
            WHERE library_id=? AND album_id=?""",
            (
                body.provider,
                body.release_id,
                body.source_url,
                json.dumps(body.snapshot, ensure_ascii=False),
                timestamp,
                library_id,
                album_id,
            ),
        )
    return read(connection, library_id, album_id)


def clear(connection, library_id, album_id, version=None):
    current = read(connection, library_id, album_id)
    if current is None:
        raise HTTPException(404, "release_lock_not_found")
    if version is not None and current["version"] != version:
        raise HTTPException(409, "release_lock_version_conflict")
    connection.execute(
        "DELETE FROM album_release_locks WHERE library_id=? AND album_id=?",
        (library_id, album_id),
    )
    return {"album_id": album_id, "cleared": True}


def transfer(connection, library_id, old_album_id, new_album_id):
    """Keep a lock attached when an explicit album rename changes its derived ID."""
    if old_album_id == new_album_id:
        return
    if not connection.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='album_release_locks'"
    ).fetchone():
        # Schema 12 backfills effective metadata before the schema24 table exists.
        return
    current = connection.execute(
        "SELECT * FROM album_release_locks WHERE library_id=? AND album_id=?",
        (library_id, old_album_id),
    ).fetchone()
    if current is None:
        return
    target = connection.execute(
        "SELECT * FROM album_release_locks WHERE library_id=? AND album_id=?",
        (library_id, new_album_id),
    ).fetchone()
    remaining = connection.execute(
        "SELECT count(*) FROM tracks WHERE library_id=? AND album_id=? AND status='available'",
        (library_id, old_album_id),
    ).fetchone()[0]
    if remaining > 1 and target is None:
        # A single-track edit creates a split. Keep the old group protected and
        # copy the lock to the new group until the last old member moves.
        connection.execute(
            """INSERT INTO album_release_locks
            (album_id,library_id,provider,release_id,source_url,snapshot,version,created_at,updated_at)
            SELECT ?,library_id,provider,release_id,source_url,snapshot,version,created_at,updated_at
            FROM album_release_locks WHERE library_id=? AND album_id=?""",
            (new_album_id, library_id, old_album_id),
        )
        return
    if target is not None:
        if (
            target["provider"] != current["provider"]
            or target["release_id"] != current["release_id"]
        ):
            # A caller can still explicitly clear or replace the lock; a scan must not
            # silently choose between two release identities.
            return
        connection.execute(
            "DELETE FROM album_release_locks WHERE library_id=? AND album_id=?",
            (library_id, old_album_id),
        )
        return
    connection.execute(
        "UPDATE album_release_locks SET album_id=?,updated_at=? WHERE library_id=? AND album_id=?",
        (new_album_id, datetime.now(UTC).isoformat(), library_id, old_album_id),
    )


def candidate_release(row):
    """Return a provider release identity from a stored candidate, if present."""
    match = json.loads(row["match"] or "{}") if isinstance(row["match"], str) else row["match"]
    release_id = match.get("release_id") if isinstance(match, dict) else None
    if release_id:
        return str(row["provider"]), str(release_id)
    fields = json.loads(row["fields"] or "{}") if isinstance(row["fields"], str) else row["fields"]
    external = fields.get("external_ids", {}) if isinstance(fields, dict) else {}
    release_id = external.get("release") if isinstance(external, dict) else None
    return (str(row["provider"]), str(release_id)) if release_id else None


ALBUM_FIELDS = frozenset(
    {
        "album",
        "album_artists",
        "track_total",
        "disc_total",
        "release_date",
        "original_date",
        "external_ids",
    }
)


def candidate_conflict(connection, library_id, album_id, candidate, fields):
    """Return a stable warning when a candidate crosses a locked release."""
    if not ALBUM_FIELDS.intersection(fields):
        return None
    lock = read(connection, library_id, album_id)
    if lock is None:
        return None
    release = candidate_release(candidate)
    if release == (lock["provider"], lock["release_id"]):
        return None
    return {
        "code": "album_release_lock_conflict",
        "provider": lock["provider"],
        "release_id": lock["release_id"],
        "candidate_provider": release[0] if release else candidate["provider"],
        "candidate_release_id": release[1] if release else None,
    }
