"""Per-user programme policies retain one shared copy of each audio file."""

import time
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime
from typing import Literal

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field

from wildstring.podcast_access import require_programme


class DownloadSettingsUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: int = Field(ge=1, strict=True)
    download_policy: Literal["none", "latest_3", "latest_5", "latest_10", "unplayed", "all"]
    retention_policy: Literal["keep", "delete_after_played"] = "keep"


def date_value(value):
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        try:
            parsed = parsedate_to_datetime(value)
        except (TypeError, ValueError, AttributeError, IndexError):
            return None
    try:
        return (parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)).timestamp()
    except (OSError, ValueError, OverflowError):
        return None


def ordered_episodes(db, podcast_id, user_id=None):
    rows = db.execute(
        """SELECT e.rowid AS arrival,e.id,e.pub_date,e.created_at,e.episode_number,
        e.local_path,e.download_status,COALESCE(pr.completed,0) AS completed
        FROM podcast_episodes e LEFT JOIN podcast_progress pr ON pr.episode_id=e.id AND pr.user_id=?
        WHERE e.podcast_id=?""",
        (user_id, podcast_id),
    ).fetchall()

    def order(row):
        created = date_value(row["created_at"]) or 0
        published = date_value(row["pub_date"])
        return (
            published if published is not None else created,
            row["episode_number"] or 0,
            created,
            -row["arrival"],
        )

    return sorted(rows, key=order, reverse=True)


class PodcastAutoDownloads:
    def __init__(self, manager):
        self.manager, self.database = manager, manager.database

    def policies_for(self, user_id):
        with self.database.connect() as db:
            return {
                r["podcast_id"]: dict(r)
                for r in db.execute(
                    "SELECT podcast_id,download_policy,retention_policy FROM podcast_user_settings WHERE user_id=?",
                    (user_id,),
                )
            }

    def settings(self, user_id, podcast_id):
        with self.database.connect() as db:
            row = db.execute(
                "SELECT download_policy,retention_policy,version FROM podcast_user_settings WHERE user_id=? AND podcast_id=?",
                (user_id, podcast_id),
            ).fetchone()
            active = db.execute(
                "SELECT 1 FROM podcast_follows f JOIN users u ON u.id=f.user_id WHERE f.user_id=? AND f.podcast_id=? AND u.enabled=1",
                (user_id, podcast_id),
            ).fetchone()
        return {
            "download_policy": row[0] if row else "none",
            "retention_policy": row[1] if row else "keep",
            "version": row[2] if row else 1,
            "active": bool(active),
        }

    def configure(self, user_id, podcast_id, body):
        with self.database.connect(write=True) as db:
            db.execute("BEGIN IMMEDIATE")
            require_programme(db, user_id, podcast_id)
            if (
                body.download_policy != "none"
                and not db.execute(
                    "SELECT 1 FROM podcast_follows WHERE user_id=? AND podcast_id=?",
                    (user_id, podcast_id),
                ).fetchone()
            ):
                raise HTTPException(409, "podcast_follow_required")
            db.execute(
                "INSERT OR IGNORE INTO podcast_user_settings(user_id,podcast_id) VALUES (?,?)",
                (user_id, podcast_id),
            )
            changed = db.execute(
                "UPDATE podcast_user_settings SET download_policy=?,retention_policy=?,version=version+1 WHERE user_id=? AND podcast_id=? AND version=?",
                (body.download_policy, body.retention_policy, user_id, podcast_id, body.version),
            ).rowcount
            if not changed:
                raise HTTPException(409, "podcast_download_settings_conflict")
        self.reconcile(user_id, podcast_id)
        return self.settings(user_id, podcast_id)

    @staticmethod
    def release(db, user_id, podcast_id):
        db.execute(
            "UPDATE podcast_resource_refs SET automatic=0 WHERE user_id=? AND episode_id IN (SELECT id FROM podcast_episodes WHERE podcast_id=?)",
            (user_id, podcast_id),
        )
        db.execute(
            "DELETE FROM podcast_resource_refs WHERE user_id=? AND manual=0 AND automatic=0",
            (user_id,),
        )

    def reconcile(self, user_id, podcast_id):
        candidates = []
        with self.database.connect(write=True) as db:
            db.execute("BEGIN IMMEDIATE")
            policy = db.execute(
                "SELECT s.* FROM podcast_user_settings s JOIN podcast_follows f ON f.user_id=s.user_id AND f.podcast_id=s.podcast_id JOIN users u ON u.id=s.user_id AND u.enabled=1 WHERE s.user_id=? AND s.podcast_id=?",
                (user_id, podcast_id),
            ).fetchone()
            previous = {
                r[0]
                for r in db.execute(
                    "SELECT r.episode_id FROM podcast_resource_refs r JOIN podcast_episodes e ON e.id=r.episode_id WHERE r.user_id=? AND e.podcast_id=? AND r.automatic=1",
                    (user_id, podcast_id),
                )
            }
            rows = (
                ordered_episodes(db, podcast_id, user_id)
                if policy and policy["download_policy"] != "none"
                else []
            )
            if policy and policy["download_policy"].startswith("latest_"):
                rows = rows[: int(policy["download_policy"].split("_")[1])]
            if policy and (
                policy["download_policy"] == "unplayed"
                or policy["retention_policy"] == "delete_after_played"
            ):
                rows = [row for row in rows if not row["completed"]]
            self.release(db, user_id, podcast_id)
            for row in rows:
                identity = row["id"]
                db.execute(
                    "INSERT INTO podcast_resource_refs(user_id,episode_id,created_at,manual,automatic) VALUES (?,?,?,0,1) ON CONFLICT(user_id,episode_id) DO UPDATE SET automatic=1",
                    (user_id, identity, time.time()),
                )
                db.execute(
                    "INSERT OR IGNORE INTO podcast_resource_state(episode_id) VALUES (?)",
                    (identity,),
                )
                db.execute(
                    "UPDATE podcast_resource_state SET zero_since=NULL WHERE episode_id=?",
                    (identity,),
                )
                if self.manager.resources.cached_path(row["local_path"]) is None:
                    if row["download_status"] == "downloaded":
                        db.execute(
                            "UPDATE podcast_episodes SET local_path=NULL,download_status='none' WHERE id=?",
                            (identity,),
                        )
                    candidates.append(identity)
            removed = previous - {row["id"] for row in rows}
            for identity in removed:
                db.execute(
                    "UPDATE podcast_resource_state SET zero_since=COALESCE(zero_since,?) WHERE episode_id=? AND NOT EXISTS(SELECT 1 FROM podcast_resource_refs WHERE episode_id=?)",
                    (time.time(), identity, identity),
                )
        return sum(bool(self.manager.queue_download_episode(identity)) for identity in candidates)

    def reconcile_programme(self, podcast_id):
        with self.database.connect() as db:
            users = {
                r[0]
                for r in db.execute(
                    "SELECT user_id FROM podcast_user_settings WHERE podcast_id=? UNION SELECT r.user_id FROM podcast_resource_refs r JOIN podcast_episodes e ON e.id=r.episode_id WHERE e.podcast_id=? AND r.automatic=1",
                    (podcast_id, podcast_id),
                )
            }
        return sum(self.reconcile(user, podcast_id) for user in users)

    def reconcile_all(self):
        with self.database.connect() as db:
            ids = {
                r[0]
                for r in db.execute(
                    "SELECT podcast_id FROM podcast_user_settings UNION SELECT e.podcast_id FROM podcast_resource_refs r JOIN podcast_episodes e ON e.id=r.episode_id WHERE r.automatic=1"
                )
            }
        return sum(self.reconcile_programme(identity) for identity in ids)
