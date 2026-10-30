"""Personal saves and conservative collection of shared podcast audio."""

import json
import time
from typing import Annotated
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field
from starlette.background import BackgroundTask
from starlette.responses import FileResponse

from wildstring.podcast_access import admit, require_episode


class ResourceSettings(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: int = Field(ge=1, strict=True)
    enabled: bool
    retention_days: int = Field(ge=0, le=3650, strict=True)


class ProtectionUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: int = Field(ge=1, strict=True)
    protected: bool


class CleanupInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    dry_run: bool = True
    podcast_id: str | None = Field(default=None, max_length=128)


class PodcastResources:
    def __init__(self, manager):
        self.manager = manager
        self.database = manager.database

    def settings(self):
        with self.database.connect() as db:
            row = dict(
                db.execute(
                    "SELECT enabled,retention_days,version FROM podcast_resource_settings WHERE id=1"
                ).fetchone()
            )
        row["enabled"] = bool(row["enabled"])
        return row

    def configure(self, body):
        with self.database.connect(write=True) as db:
            if not db.execute(
                "UPDATE podcast_resource_settings SET enabled=?,retention_days=?,version=version+1 WHERE id=1 AND version=?",
                (body.enabled, body.retention_days, body.version),
            ).rowcount:
                raise HTTPException(409, "podcast_resource_version_conflict")
        return self.settings()

    def _episode(self, db, identity):
        row = db.execute("SELECT * FROM podcast_episodes WHERE id=?", (identity,)).fetchone()
        if row is None:
            raise HTTPException(404, "episode_not_found")
        return row

    def cached_path(self, raw):
        path = self.manager._safe_local_path(raw)
        try:
            if path is not None and path.is_file():
                with path.open("rb") as stream:
                    if stream.read(1):
                        return path
        except OSError:
            # A registered cache file can disappear or become unreadable between probes.
            # Treat it as a cache miss so a personal save can request a fresh download.
            return None
        return None

    def save(self, identity, user_id):
        with self.database.connect(write=True) as db:
            db.execute("BEGIN IMMEDIATE")
            row = self._episode(db, identity)
            podcast_id = require_episode(db, user_id, identity)
            admit(db, user_id, podcast_id)
            reused = self.cached_path(row["local_path"]) is not None
            db.execute(
                "INSERT INTO podcast_resource_refs(user_id,episode_id,created_at,manual,automatic) VALUES (?,?,?,1,0) ON CONFLICT(user_id,episode_id) DO UPDATE SET manual=1",
                (user_id, identity, time.time()),
            )
            db.execute(
                "INSERT OR IGNORE INTO podcast_resource_state(episode_id) VALUES (?)", (identity,)
            )
            db.execute(
                "UPDATE podcast_resource_state SET zero_since=NULL WHERE episode_id=?", (identity,)
            )
            if reused:
                db.execute(
                    "UPDATE podcast_episodes SET download_status='downloaded' WHERE id=?",
                    (identity,),
                )
            elif row["download_status"] == "downloaded":
                db.execute(
                    "UPDATE podcast_episodes SET local_path=NULL,download_status='none' WHERE id=?",
                    (identity,),
                )
        if not reused:
            self.manager.queue_download_episode(identity)
        return {
            "id": identity,
            "status": "reused" if reused else "downloading",
            "saved": True,
            "reused": reused,
        }

    def release(self, identity, user_id):
        with self.database.connect(write=True) as db:
            db.execute("BEGIN IMMEDIATE")
            db.execute(
                "UPDATE podcast_resource_refs SET manual=0 WHERE user_id=? AND episode_id=?",
                (user_id, identity),
            )
            db.execute(
                "DELETE FROM podcast_resource_refs WHERE user_id=? AND episode_id=? AND manual=0 AND automatic=0",
                (user_id, identity),
            )
            db.execute(
                "UPDATE podcast_resource_state SET zero_since=COALESCE(zero_since,?) WHERE episode_id=? AND NOT EXISTS(SELECT 1 FROM podcast_resource_refs WHERE episode_id=?)",
                (time.time(), identity, identity),
            )
        return {"id": identity, "saved": False, "status": "released"}

    def saved_ids(self, user_id):
        with self.database.connect() as db:
            return {
                r[0]
                for r in db.execute(
                    "SELECT episode_id FROM podcast_resource_refs WHERE user_id=? AND manual=1",
                    (user_id,),
                )
            }

    def automatic_ids(self, user_id):
        with self.database.connect() as db:
            return {
                r[0]
                for r in db.execute(
                    "SELECT episode_id FROM podcast_resource_refs WHERE user_id=? AND automatic=1",
                    (user_id,),
                )
            }

    def playback_ids(self, user_id):
        with self.database.connect() as db:
            return {
                r[0]
                for r in db.execute(
                    "SELECT episode_id FROM podcast_playback_cache WHERE user_id=?", (user_id,)
                )
            }

    def downloaded(self, db, identity):
        db.execute(
            "INSERT OR IGNORE INTO podcast_resource_state(episode_id) VALUES (?)", (identity,)
        )
        db.execute(
            "UPDATE podcast_resource_state SET zero_since=CASE WHEN EXISTS(SELECT 1 FROM podcast_resource_refs WHERE episode_id=?) THEN NULL ELSE ? END WHERE episode_id=?",
            (identity, time.time(), identity),
        )

    def acquire(self, db, identity):
        token = uuid4().hex
        db.execute(
            "INSERT INTO podcast_resource_leases VALUES (?,?,?)",
            (token, identity, time.time() + 86400),
        )
        return token

    def release_lease(self, token):
        with self.database.connect(write=True) as db:
            db.execute("DELETE FROM podcast_resource_leases WHERE id=?", (token,))

    def local_response(self, identity):
        # Lease acquisition and collection use the same SQLite writer lock.
        with self.database.connect(write=True) as db:
            db.execute("BEGIN IMMEDIATE")
            row = self._episode(db, identity)
            path = self.cached_path(row["local_path"])
            if path is None:
                return None
            lease = self.acquire(db, identity)
        return FileResponse(
            path,
            media_type="audio/mpeg",
            background=BackgroundTask(self.release_lease, lease),
            headers={
                "X-Content-Type-Options": "nosniff",
                "Content-Security-Policy": "sandbox; default-src 'none'",
            },
        )

    def synchronize(self, db):
        stamp = time.time()
        db.execute("DELETE FROM podcast_resource_leases WHERE expires_at<?", (stamp,))
        # Register existing files under the same rules as newly downloaded audio.
        db.execute(
            "INSERT OR IGNORE INTO podcast_resource_state(episode_id,protected,zero_since) SELECT id,0,? FROM podcast_episodes WHERE local_path IS NOT NULL AND local_path<>''",
            (stamp,),
        )
        db.execute(
            "UPDATE podcast_resource_state SET zero_since=NULL WHERE zero_since IS NOT NULL AND EXISTS(SELECT 1 FROM podcast_resource_refs r WHERE r.episode_id=podcast_resource_state.episode_id)"
        )
        db.execute(
            "UPDATE podcast_resource_state SET zero_since=COALESCE(zero_since,?) WHERE zero_since IS NULL AND NOT EXISTS(SELECT 1 FROM podcast_resource_refs r WHERE r.episode_id=podcast_resource_state.episode_id)",
            (stamp,),
        )

    def rows(self, db, paths=None):
        encoded = json.dumps(paths) if paths is not None else None
        return [
            dict(r)
            for r in db.execute(
                """SELECT e.id,e.podcast_id,e.title,e.local_path,e.download_status,p.title AS podcast_title,
            COALESCE(s.protected,0) AS protected,s.zero_since,COALESCE(s.version,1) AS version,
            (SELECT count(*) FROM podcast_resource_refs r WHERE r.episode_id=e.id) AS reference_count,
            EXISTS(SELECT 1 FROM podcast_resource_leases x WHERE x.episode_id=e.id AND x.expires_at>?) AS leased
            FROM podcast_episodes e JOIN podcasts p ON p.id=e.podcast_id LEFT JOIN podcast_resource_state s ON s.episode_id=e.id
            WHERE e.local_path IS NOT NULL AND e.local_path<>''
            AND (? IS NULL OR e.local_path IN (SELECT value FROM json_each(?))) ORDER BY e.id""",
                (time.time(), encoded, encoded),
            )
        ]

    def listing(self, offset=0, limit=100):
        with self.database.connect(write=True) as db:
            self.synchronize(db)
            rows = self.rows(db)
        items, total_bytes = [], 0
        for row in rows:
            path = self.manager._safe_local_path(row.pop("local_path"))
            try:
                size = path.stat().st_size if path and path.is_file() else 0
            except OSError:
                size = 0
            total_bytes += size
            row.update(
                size_bytes=size,
                protected=bool(row["protected"]),
                active=bool(row.pop("leased")) or row["id"] in self.manager._active_downloads,
            )
            items.append(row)
        return {
            "items": items[offset : offset + limit],
            "total": len(items),
            "total_bytes": total_bytes,
            "offset": offset,
            "limit": limit,
        }

    def protect(self, identity, body):
        with self.database.connect(write=True) as db:
            db.execute("BEGIN IMMEDIATE")
            self._episode(db, identity)
            self.synchronize(db)
            if not db.execute(
                "UPDATE podcast_resource_state SET protected=?,version=version+1 WHERE episode_id=? AND version=?",
                (body.protected, identity, body.version),
            ).rowcount:
                raise HTTPException(409, "podcast_resource_version_conflict")
        return {"id": identity, "protected": body.protected, "version": body.version + 1}

    def cleanup(self, *, dry_run=True, podcast_id=None, automatic=False):
        settings = self.settings()
        if automatic and not settings["enabled"]:
            return {
                "deleted_count": 0,
                "freed_bytes": 0,
                "candidate_count": 0,
                "candidate_bytes": 0,
                "failed_count": 0,
                "dry_run": dry_run,
            }
        candidate_count = candidate_bytes = deleted_count = freed_bytes = failed_count = 0
        # Do not retain one database write transaction for the full directory traversal.
        with self.database.connect(write=True) as db:
            self.synchronize(db)
            snapshot = self.rows(db)
        groups = {}
        for row in snapshot:
            path = self.manager._safe_local_path(row["local_path"])
            if path is not None:
                groups.setdefault(path, []).append(row)
        for path, previous in groups.items():
            if podcast_id is not None and not any(r["podcast_id"] == podcast_id for r in previous):
                continue
            with self.database.connect(write=True) as db:
                db.execute("BEGIN IMMEDIATE")
                # Re-read refs/leases under the writer lock immediately before unlink.
                aliases = self.rows(db, list({r["local_path"] for r in previous} | {str(path)}))
                if not aliases:
                    continue
                if any(
                    r["reference_count"]
                    or r["protected"]
                    or r["leased"]
                    or r["download_status"] in {"queued", "downloading"}
                    or r["id"] in self.manager._active_downloads
                    or r["id"] in self.manager._queued_episodes
                    for r in aliases
                ):
                    continue
                if podcast_id is not None and any(r["podcast_id"] != podcast_id for r in aliases):
                    continue
                if automatic and any(
                    r["zero_since"] is None
                    or r["zero_since"] > time.time() - settings["retention_days"] * 86400
                    for r in aliases
                ):
                    continue
                try:
                    size = path.stat().st_size if path.is_file() else 0
                    candidate_count += 1
                    candidate_bytes += size
                    if not dry_run:
                        path.unlink(missing_ok=True)
                        for alias in aliases:
                            db.execute(
                                "UPDATE podcast_episodes SET local_path=NULL,download_status='none' WHERE id=?",
                                (alias["id"],),
                            )
                            db.execute(
                                "DELETE FROM podcast_playback_cache WHERE episode_id=?",
                                (alias["id"],),
                            )
                        deleted_count += 1
                        freed_bytes += size
                except OSError:
                    failed_count += 1
        return {
            "dry_run": dry_run,
            "candidate_count": candidate_count,
            "candidate_bytes": candidate_bytes,
            "deleted_count": deleted_count,
            "freed_bytes": freed_bytes,
            "failed_count": failed_count,
        }

    def router(self, auth):
        router = APIRouter(
            prefix="/api/v1/podcasts/resources",
            tags=["podcast-resources"],
            dependencies=[Depends(auth.require_owner)],
        )

        @router.get("")
        def listing(
            offset: Annotated[int, Query(ge=0)] = 0,
            limit: Annotated[int, Query(ge=1, le=200)] = 100,
        ):
            return self.listing(offset, limit)

        @router.get("/settings")
        def settings():
            return self.settings()

        @router.put("/settings", dependencies=[Depends(auth.require_client)])
        def configure(body: ResourceSettings):
            return self.configure(body)

        @router.put("/{identity}/protection", dependencies=[Depends(auth.require_client)])
        def protect(identity: str, body: ProtectionUpdate):
            return self.protect(identity, body)

        @router.post("/cleanup", dependencies=[Depends(auth.require_client)])
        def cleanup(body: CleanupInput):
            return self.cleanup(dry_run=body.dry_run, podcast_id=body.podcast_id)

        return router
