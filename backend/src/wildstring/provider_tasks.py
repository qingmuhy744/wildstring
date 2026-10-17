"""Task inbox and retained history; query outcomes and review decisions are independent."""

import json
import time
from typing import Literal

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field

View = Literal["active", "pending", "attention", "history"]
VIEWS = ("active", "pending", "attention", "history")
RETENTION_DAYS = 30
SCHEMA = """
BEGIN IMMEDIATE;
CREATE TABLE IF NOT EXISTS provider_task_reviews (
    job_id TEXT PRIMARY KEY REFERENCES provider_jobs(id) ON DELETE CASCADE,
    acknowledged_at REAL,
    hidden_at REAL
);
PRAGMA user_version = 16;
COMMIT;
"""

# Suggestions from an older metadata version are already non-applicable in the editor.
# Hiding history never deletes jobs: refresh batch snapshots must keep their outcomes.
SELECTION = """
WITH pending AS (
    SELECT s.job_id,count(*) AS pending_count FROM metadata_suggestions s
    JOIN track_metadata m ON m.track_id=s.track_id AND m.version=s.metadata_version
    WHERE s.status='pending' AND (s.fields<>'{}' OR s.cover_url IS NOT NULL)
    GROUP BY s.job_id
), reviewed AS (
    SELECT j.*,t.title,r.acknowledged_at,r.hidden_at,
        COALESCE(p.pending_count,0) AS pending_count,
        (j.status IN ('failed','stale') OR j.error IS NOT NULL
            OR json_array_length(j.warnings)>0) AS has_issue
    FROM provider_jobs j JOIN tracks t ON t.id=j.track_id
    LEFT JOIN pending p ON p.job_id=j.id
    LEFT JOIN provider_task_reviews r ON r.job_id=j.id
    WHERE t.library_id=?
), classified AS (
    SELECT *,CASE
        WHEN status IN ('queued','running') THEN 'active'
        WHEN pending_count>0 THEN 'pending'
        WHEN has_issue AND acknowledged_at IS NULL THEN 'attention'
        ELSE 'history' END AS bucket
    FROM reviewed
)
"""


class ReviewTasks(BaseModel):
    model_config = ConfigDict(extra="forbid")
    view: Literal["pending", "attention"]
    through: float = Field(ge=0, allow_inf_nan=False)


class HistoryClear(BaseModel):
    model_config = ConfigDict(extra="forbid")
    through: float = Field(ge=0, allow_inf_nan=False)


def statement(tail):
    """Compose fixed internal SQL fragments; every request value remains bound."""
    return "".join((SELECTION, tail))


def task_page(repository, view: View, limit=20, offset=0):
    snapshot = time.time()
    library = repository.library_id()
    with repository.database.connect() as connection:
        counts = dict.fromkeys(VIEWS, 0)
        counts.update(
            dict(
                connection.execute(
                    statement(
                        "SELECT bucket,count(DISTINCT track_id) FROM classified "
                        "WHERE bucket<>'history' OR hidden_at IS NULL GROUP BY bucket"
                    ),
                    (library,),
                ).fetchall()
            )
        )
        active = dict(
            connection.execute(
                statement(
                    "SELECT status,count(*) FROM classified WHERE bucket='active' GROUP BY status"
                ),
                (library,),
            ).fetchall()
        )
        rows = connection.execute(
            statement(""", ranked AS (
                SELECT *,row_number() OVER (
                    PARTITION BY track_id ORDER BY created_at DESC,id DESC) AS position,
                    count(*) OVER (PARTITION BY track_id) AS job_count,
                    sum(pending_count) OVER (PARTITION BY track_id) AS suggestion_count,
                    max(has_issue) OVER (PARTITION BY track_id) AS group_has_issue,
                    max(has_issue AND acknowledged_at IS NULL) OVER (PARTITION BY track_id) AS requires_attention
                FROM classified WHERE bucket=? AND (bucket<>'history' OR hidden_at IS NULL)
            ) SELECT * FROM ranked WHERE position=1 ORDER BY created_at DESC,id DESC
            LIMIT ? OFFSET ?"""),
            (library, view, limit, offset),
        ).fetchall()
        items = []
        diagnostics = {}
        for row in connection.execute(
            statement(
                "SELECT track_id,error,warnings FROM classified WHERE bucket=? "
                "AND (bucket<>'history' OR hidden_at IS NULL) "
                "AND track_id IN (SELECT value FROM json_each(?))"
            ),
            (library, view, json.dumps([row["track_id"] for row in rows])),
        ):
            codes = diagnostics.setdefault(row["track_id"], [])
            codes.extend(json.loads(row["warnings"]))
            if row["error"]:
                codes.append(row["error"])
        for row in rows:
            item = dict(row)
            item.pop("position")
            item["has_issue"] = item.pop("group_has_issue")
            item["error"] = None
            item["warnings"] = json.dumps(list(dict.fromkeys(diagnostics[item["track_id"]])))
            items.append(item)
    return {
        "items": items,
        "total": counts[view],
        "limit": limit,
        "offset": offset,
        "counts": counts,
        "queued": active.get("queued", 0),
        "running": active.get("running", 0),
        "snapshot_at": snapshot,
        "retention_days": RETENTION_DAYS,
        "view": view,
    }


def review_tasks(repository, track_id, body: ReviewTasks):
    """Only review terminal results visible at the caller's snapshot, never new work."""
    clock = time.time()
    with repository.database.connect(write=True) as connection:
        connection.execute("BEGIN IMMEDIATE")
        jobs = connection.execute(
            statement("SELECT id FROM classified WHERE track_id=? AND bucket=? AND updated_at<=?"),
            (repository.library_id(), track_id, body.view, min(body.through, clock)),
        ).fetchall()
        for job in jobs:
            if body.view == "pending":
                connection.execute(
                    "UPDATE metadata_suggestions SET status='ignored' "
                    "WHERE job_id=? AND status='pending'",
                    (job["id"],),
                )
            connection.execute(
                "INSERT INTO provider_task_reviews(job_id,acknowledged_at) VALUES (?,?) "
                "ON CONFLICT(job_id) DO UPDATE SET acknowledged_at=excluded.acknowledged_at",
                (job["id"], clock),
            )
    return {"reviewed": len(jobs)}


def clear_history(repository, through):
    clock = time.time()
    with repository.database.connect(write=True) as connection:
        connection.execute("BEGIN IMMEDIATE")
        jobs = connection.execute(
            statement(
                "SELECT id FROM classified WHERE bucket='history' AND hidden_at IS NULL "
                "AND updated_at<=?"
            ),
            (repository.library_id(), min(through, clock)),
        ).fetchall()
        connection.executemany(
            "INSERT INTO provider_task_reviews(job_id,hidden_at) VALUES (?,?) "
            "ON CONFLICT(job_id) DO UPDATE SET hidden_at=excluded.hidden_at",
            [(row["id"], clock) for row in jobs],
        )
    return {"cleared": len(jobs)}


def retry_task(service, job_id):
    snapshot = time.time()
    with service.database.connect() as connection:
        row = connection.execute(
            statement("SELECT * FROM classified WHERE id=?"),
            (service.repository.library_id(), job_id),
        ).fetchone()
    if row is None:
        raise HTTPException(404, "provider_task_not_found")
    if row["bucket"] not in {"attention", "pending"}:
        raise HTTPException(409, "provider_task_not_retryable")
    with service.database.connect() as connection:
        issue = connection.execute(
            statement(
                "SELECT refresh_mode FROM classified WHERE track_id=? AND bucket=? "
                "AND has_issue AND acknowledged_at IS NULL ORDER BY created_at DESC,id DESC LIMIT 1"
            ),
            (service.repository.library_id(), row["track_id"], row["bucket"]),
        ).fetchone()
    if issue is None:
        raise HTTPException(409, "provider_task_not_retryable")
    # Reuse recent successful source responses; failed requests were never cached.
    # Enqueue first: disabled providers or an unavailable track must not dismiss the error.
    result = service.enqueue([row["track_id"]], mode=issue["refresh_mode"], force=False)
    with service.database.connect(write=True) as connection:
        connection.execute("BEGIN IMMEDIATE")
        jobs = connection.execute(
            statement(
                "SELECT id FROM classified WHERE track_id=? AND has_issue "
                "AND bucket<>'active' AND updated_at<=?"
            ),
            (service.repository.library_id(), row["track_id"], snapshot),
        ).fetchall()
        connection.executemany(
            "INSERT INTO provider_task_reviews(job_id,acknowledged_at) VALUES (?,?) "
            "ON CONFLICT(job_id) DO UPDATE SET acknowledged_at=excluded.acknowledged_at",
            [(job["id"], time.time()) for job in jobs],
        )
    return result
