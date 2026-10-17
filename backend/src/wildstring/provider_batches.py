"""Durable refresh membership; progress never depends on the latest-jobs page."""

import json
import time
from uuid import uuid4

from fastapi import HTTPException

ITEM_LIMIT = 1000
STATUSES = ("queued", "running", "completed", "failed", "no_match", "stale")
SCHEMA = """
BEGIN IMMEDIATE;
CREATE TABLE IF NOT EXISTS provider_refresh_batches (
    id TEXT PRIMARY KEY,
    library_id TEXT NOT NULL REFERENCES libraries(id),
    created_at REAL NOT NULL,
    total INTEGER NOT NULL CHECK(total>=0)
);
CREATE INDEX IF NOT EXISTS provider_refresh_library
    ON provider_refresh_batches(library_id,created_at);
CREATE TABLE IF NOT EXISTS provider_refresh_members (
    batch_id TEXT NOT NULL REFERENCES provider_refresh_batches(id) ON DELETE CASCADE,
    job_id TEXT NOT NULL,
    track_id TEXT NOT NULL,
    title TEXT NOT NULL,
    position INTEGER NOT NULL CHECK(position>=0),
    PRIMARY KEY(batch_id,track_id),
    UNIQUE(batch_id,position)
);
CREATE INDEX IF NOT EXISTS provider_refresh_job ON provider_refresh_members(job_id);
PRAGMA user_version = 15;
COMMIT;
"""
# Job and track IDs in the member table intentionally are immutable snapshots, not
# cascading foreign keys: deleting a song/job must not make a batch look shorter or successful.
SELECTION = """
SELECT m.job_id AS id,m.track_id,COALESCE(t.title,m.title) AS title,m.position,
CASE WHEN j.id IS NULL OR t.id IS NULL THEN 'stale'
    WHEN j.status IN ('queued','running','completed','failed','no_match','stale') THEN j.status
    ELSE 'stale' END AS status,
CASE WHEN j.id IS NULL OR t.id IS NULL THEN 'refresh_target_removed' ELSE j.error END AS error,
COALESCE(j.warnings,'[]') AS warnings
FROM provider_refresh_members m
JOIN provider_refresh_batches b ON b.id=m.batch_id
LEFT JOIN tracks t ON t.id=m.track_id AND t.library_id=b.library_id
LEFT JOIN provider_jobs j ON j.id=m.job_id AND j.track_id=m.track_id
WHERE m.batch_id=?
"""


def record_batch(connection, library_id, tracks):
    """Caller holds BEGIN IMMEDIATE covering both enqueue and this membership snapshot."""
    identity = uuid4().hex
    jobs = {
        row["track_id"]: row["id"]
        for row in connection.execute(
            "SELECT id,track_id FROM provider_jobs WHERE status IN ('queued','running') "
            "AND track_id IN (SELECT value FROM json_each(?))",
            (json.dumps([track["id"] for track in tracks]),),
        )
    }
    if len(jobs) != len(tracks):
        raise RuntimeError("refresh_batch_membership_changed")
    connection.execute(
        "INSERT INTO provider_refresh_batches VALUES (?,?,?,?)",
        (identity, library_id, time.time(), len(tracks)),
    )
    connection.executemany(
        "INSERT INTO provider_refresh_members VALUES (?,?,?,?,?)",
        [
            (identity, jobs[track["id"]], track["id"], track["title"], position)
            for position, track in enumerate(tracks)
        ],
    )
    return identity


def batch_progress(repository, identity):
    with repository.database.connect() as connection:
        batch = connection.execute(
            "SELECT total FROM provider_refresh_batches WHERE id=? AND library_id=?",
            (identity, repository.library_id()),
        ).fetchone()
        if batch is None:
            raise HTTPException(404, "refresh_batch_not_found")
        counts = dict.fromkeys(STATUSES, 0)
        counts.update(
            {
                row["status"]: row["count"]
                for row in connection.execute(
                    "".join(
                        ("SELECT status,count(*) AS count FROM (", SELECTION, ") GROUP BY status")
                    ),
                    (identity,),
                )
            }
        )
        rows = connection.execute(
            SELECTION + " ORDER BY position LIMIT ?", (identity, ITEM_LIMIT)
        ).fetchall()
    items = []
    for row in rows:
        item = dict(row)
        item.pop("position")
        # Bound the response even if a historical metadata file has unusually long fields.
        item["title"] = item["title"][:1024]
        item["error"] = item["error"][:512] if item["error"] else None
        item["warnings"] = item["warnings"][:8192]
        items.append(item)
    return {
        "total": batch["total"],
        **counts,
        "items": items,
        "truncated": batch["total"] > len(items),
    }
