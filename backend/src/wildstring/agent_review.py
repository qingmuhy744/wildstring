"""Album review projections and candidate-bound, atomic manual acceptance."""

import json
import sqlite3

from fastapi import HTTPException
from pydantic import Field

from wildstring.agent_common import digest, encoded
from wildstring.agent_models import Apply, DraftCreate, Evidence, Input
from wildstring.agent_sources import evidence_url


def candidate_digest(row):
    return digest(
        encoded(
            [
                row[key]
                for key in (
                    "id",
                    "track_id",
                    "metadata_version",
                    "provider",
                    "source_url",
                    "fields",
                    "cover_url",
                    "match",
                )
            ]
        )
    )


def canonical_fields(value):
    return json.dumps(json.loads(value), sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def candidate_group(row):
    return (
        row["provider"],
        row["metadata_version"],
        row["source_url"] or "",
        canonical_fields(row["fields"]),
        row["cover_url"] or "",
    )


class ReviewReject(Input):
    track_id: str = Field(min_length=1, max_length=128)
    suggestion_id: str = Field(min_length=1, max_length=128)
    metadata_version: int = Field(ge=1)
    candidate_digest: str = Field(pattern=r"^[0-9a-f]{64}$")


class ReviewItem(Input):
    track_id: str = Field(min_length=1, max_length=128)
    suggestion_id: str = Field(min_length=1, max_length=128)
    metadata_version: int = Field(ge=1)
    candidate_digest: str = Field(pattern=r"^[0-9a-f]{64}$")
    fields: list[str] = Field(min_length=1, max_length=40)


class ReviewAccept(Input):
    cover_draft_id: str | None = Field(default=None, min_length=1, max_length=128)
    items: list[ReviewItem] = Field(min_length=1, max_length=500)
    idempotency_key: str = Field(min_length=8, max_length=128, pattern=r"^[A-Za-z0-9_.:-]+$")


class Review:
    def review_albums(self, actor, limit=100, offset=0):
        actor.require("library:manage", admin=True)
        with self.database.connect() as db:
            rows = db.execute(
                "SELECT t.album_id,t.album,t.album_artists,count(*) AS count FROM tracks t "
                "WHERE t.library_id=? AND t.status='available' AND EXISTS "
                "(SELECT 1 FROM metadata_suggestions s WHERE s.track_id=t.id AND s.status='pending' "
                "AND s.metadata_version=(SELECT version FROM track_metadata WHERE track_id=t.id) "
                "AND (s.fields<>'{}' OR s.cover_url IS NOT NULL)) GROUP BY t.album_id ORDER BY t.album,t.album_id",
                (self.library_id,),
            ).fetchall()
        return {
            "items": [
                {
                    "id": r["album_id"],
                    "title": r["album"] or "未知专辑",
                    "artists": json.loads(r["album_artists"]),
                    "count": r["count"],
                }
                for r in rows[offset : offset + limit]
            ],
            "total": len(rows),
            "limit": limit,
            "offset": offset,
        }

    def review_page(self, actor, album_id=None, track_id=None, limit=100, offset=0):
        actor.require("library:manage", admin=True)
        with self.database.connect() as db:
            if track_id:
                row = db.execute(
                    "SELECT album_id FROM tracks WHERE id=? AND library_id=? AND status='available'",
                    (track_id, self.library_id),
                ).fetchone()
                if row is None:
                    raise HTTPException(404, "track_not_found")
                album_id = row[0]
            rows = db.execute(
                "SELECT t.id,t.title,t.album,t.album_id,t.artists,t.disc_number,t.track_number,t.has_cover,m.version,m.observed,m.overrides "
                "FROM tracks t JOIN track_metadata m ON m.track_id=t.id WHERE t.library_id=? AND t.status='available' AND t.album_id=? "
                "ORDER BY COALESCE(t.disc_number,1),COALESCE(t.track_number,99999),t.title,t.id LIMIT ? OFFSET ?",
                (self.library_id, album_id, limit, offset),
            ).fetchall()
            total = db.execute(
                "SELECT count(*) FROM tracks WHERE library_id=? AND status='available' AND album_id=?",
                (self.library_id, album_id),
            ).fetchone()[0]
            # Collapse repeated queries before limiting unique candidates. Different
            # releases, versions and providers remain independent evidence.
            db.create_function("review_fields", 1, canonical_fields, deterministic=True)
            suggestions = db.execute(
                """WITH grouped AS (
                    SELECT s.*,s.rowid AS observed_sequence,row_number() OVER (
                        PARTITION BY track_id,provider,metadata_version,COALESCE(source_url,''),review_fields(fields),COALESCE(cover_url,'')
                        ORDER BY s.rowid DESC) AS duplicate_position,
                        count(*) OVER (
                        PARTITION BY track_id,provider,metadata_version,COALESCE(source_url,''),review_fields(fields),COALESCE(cover_url,'')) AS duplicate_count
                    FROM metadata_suggestions s
                    WHERE s.track_id IN (SELECT value FROM json_each(?)) AND s.status='pending'
                ) SELECT * FROM (
                    SELECT *,row_number() OVER (PARTITION BY track_id ORDER BY observed_sequence DESC) AS position
                    FROM grouped WHERE duplicate_position=1
                ) WHERE position<=30""",
                (encoded([r["id"] for r in rows]),),
            ).fetchall()
        by_track = {}
        priority = self.providers.source_priority()
        for row in suggestions:
            value = {
                k: row[k] for k in ("id", "track_id", "metadata_version", "provider", "cover_url")
            }
            value.update(
                fields=json.loads(row["fields"]),
                match=json.loads(row["match"]),
                source_url=evidence_url(row["source_url"]),
                candidate_digest=candidate_digest(row),
                duplicate_count=row["duplicate_count"],
            )
            by_track.setdefault(row["track_id"], []).append(value)
        items = []
        for row in rows:
            candidates = by_track.get(row["id"], [])
            candidates.sort(
                key=lambda x: (
                    priority.index(x["provider"]) if x["provider"] in priority else len(priority),
                    -x["match"].get("score", 0),
                )
            )
            items.append(
                {
                    "id": row["id"],
                    "title": row["title"],
                    "album": row["album"],
                    "album_id": row["album_id"],
                    "artists": json.loads(row["artists"]),
                    "disc_number": row["disc_number"],
                    "track_number": row["track_number"],
                    "has_cover": bool(row["has_cover"]),
                    "metadata_version": row["version"],
                    "current": json.loads(row["observed"]) | json.loads(row["overrides"]),
                    "original": json.loads(row["observed"]),
                    "overrides": json.loads(row["overrides"]),
                    "suggestions": candidates,
                }
            )
        return {
            "items": items,
            "total": total,
            "limit": limit,
            "offset": offset,
            "album_id": album_id,
            "provider_names": {s["id"]: s["name"] for s in self.providers.sources.catalog()}
            | {"musicbrainz": "MusicBrainz", "lastfm": "Last.fm"},
        }

    def reject_metadata_review(self, actor, body):
        actor.require("library:manage", admin=True)
        with self.database.connect(write=True) as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute(
                "SELECT s.*,s.rowid AS observed_sequence,m.version AS current_version FROM metadata_suggestions s "
                "JOIN tracks t ON t.id=s.track_id JOIN track_metadata m ON m.track_id=t.id "
                "WHERE s.id=? AND s.track_id=? AND t.library_id=? AND t.status='available'",
                (body.suggestion_id, body.track_id, self.library_id),
            ).fetchone()
            if row is None:
                raise HTTPException(404, "suggestion_not_found")
            if candidate_digest(row) != body.candidate_digest:
                raise HTTPException(409, "metadata_candidate_changed")
            if row["status"] == "ignored":
                return {"status": "ignored", "ignored_count": 0, "already_ignored": True}
            if row["status"] != "pending":
                raise HTTPException(409, "suggestion_already_resolved")
            if row["current_version"] != body.metadata_version:
                raise HTTPException(409, "metadata_version_conflict")
            # Reject only the observed candidate and its older exact duplicates.
            # A concurrent/new lookup or another release must remain pending.
            older = db.execute(
                "SELECT * FROM metadata_suggestions WHERE track_id=? AND provider=? "
                "AND metadata_version=? AND status='pending' AND rowid<=?",
                (body.track_id, row["provider"], row["metadata_version"], row["observed_sequence"]),
            ).fetchall()
            identities = [r["id"] for r in older if candidate_group(r) == candidate_group(row)]
            db.execute(
                "UPDATE metadata_suggestions SET status='ignored' WHERE id IN (SELECT value FROM json_each(?))",
                (encoded(identities),),
            )
        return {"status": "ignored", "ignored_count": len(identities), "already_ignored": False}

    def accept_metadata_review(self, actor, body):
        actor.require("library:manage", admin=True)
        actor.require("drafts:apply")
        canonical = sorted(
            [{**i.model_dump(), "fields": sorted(set(i.fields))} for i in body.items],
            key=lambda x: x["track_id"],
        )
        fingerprint = digest(
            json.dumps([canonical, body.cover_draft_id], sort_keys=True, ensure_ascii=False)
        )

        def receipt():
            with self.database.connect() as db:
                row = db.execute(
                    "SELECT id FROM agent_drafts WHERE user_id=? AND idempotency_key=?",
                    (actor.user_id, body.idempotency_key),
                ).fetchone()
            if not row:
                return None
            record = self.draft(actor, row[0])
            if not any(
                e["source"] == "metadata-review/request" and e["summary"] == fingerprint
                for e in record["evidence"]
            ):
                raise HTTPException(409, "agent_idempotency_conflict")
            return record

        saved = receipt()
        if saved and saved["status"] == "applied":
            return {"status": "applied", "draft": saved}
        if len({i.track_id for i in body.items}) != len(body.items):
            raise HTTPException(422, "duplicate_track_id")
        items = []
        conflicts = []
        with self.database.connect() as db:
            for item in body.items:
                row = db.execute(
                    "SELECT s.*,t.title,m.version AS current_version FROM metadata_suggestions s JOIN tracks t ON t.id=s.track_id JOIN track_metadata m ON m.track_id=t.id WHERE s.id=? AND s.track_id=? AND t.library_id=? AND t.status='available'",
                    (item.suggestion_id, item.track_id, self.library_id),
                ).fetchone()
                code = None
                if row is None:
                    code = "suggestion_not_found"
                elif (
                    row["current_version"] != item.metadata_version
                    or row["metadata_version"] != item.metadata_version
                ):
                    code = "metadata_version_conflict"
                elif row["status"] != "pending" or candidate_digest(row) != item.candidate_digest:
                    code = "metadata_candidate_changed"
                if code:
                    conflicts.append(
                        {
                            "track_id": item.track_id,
                            "title": row["title"] if row else "歌曲不可用",
                            "error_code": code,
                        }
                    )
                    continue
                fields = json.loads(row["fields"])
                if set(item.fields) - fields.keys():
                    raise HTTPException(422, "invalid_suggestion_fields")
                items.append(
                    {
                        "track_id": item.track_id,
                        "metadata_version": item.metadata_version,
                        "overrides": {k: fields[k] for k in item.fields},
                        "source_suggestion_id": item.suggestion_id,
                        "source_digest": item.candidate_digest,
                    }
                )
        if conflicts:
            return {"status": "conflict", "conflicts": conflicts}
        if saved is None:
            proposal = DraftCreate(
                kind="metadata_batch",
                title=f"批量核对资料 · {len(items)} 首",
                payload={
                    "items": items,
                    **({"cover_draft_id": body.cover_draft_id} if body.cover_draft_id else {}),
                },
                evidence=[
                    Evidence(source="metadata-review/request", summary=fingerprint),
                    Evidence(
                        source="人工批量选择",
                        summary="仅应用已选歌曲和字段；逐曲来源及原值保留在差异快照中。",
                    ),
                ],
            )
            try:
                saved = self.create_draft(
                    actor,
                    proposal,
                    auto_apply=False,
                    application_key=body.idempotency_key,
                    notify_pending=False,
                )
            except sqlite3.IntegrityError:
                saved = receipt()
                if saved is None:
                    raise
        try:
            accepted = self.accept_draft(
                actor,
                saved["id"],
                Apply(
                    version=saved["version"],
                    preview_digest=saved["preview_digest"],
                    idempotency_key=body.idempotency_key,
                ),
            )
        except HTTPException as failure:
            if failure.status_code != 409:
                raise
            return {
                "status": "conflict",
                "draft_id": saved["id"],
                "conflicts": [
                    {
                        "track_id": i.track_id,
                        "title": "重新读取此批次",
                        "error_code": failure.detail,
                    }
                    for i in body.items
                ],
            }
        return {"status": "applied", "draft": accepted}
