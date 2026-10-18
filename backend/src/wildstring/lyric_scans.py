"""Resumable, explicitly requested lyric completion and upgrade batches."""

import hashlib
import json
import threading
import time
from collections import Counter
from typing import Literal
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field, model_validator

from wildstring.library.lyric_edits import LyricsEditor
from wildstring.library.online_lyrics import normalize_bundle
from wildstring.lyric_quality import improves, matched, quality, rank, reaches
from wildstring.source_models import LyricChoice
from wildstring.source_plugins import PluginError


class ScanOptions(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    scope: Literal["library", "album"] = "library"
    scope_id: str | None = Field(default=None, max_length=200)
    mode: Literal["missing", "upgrade"] = "upgrade"
    goal: int = Field(default=5, ge=1, le=5)
    preference: Literal["timing", "bilingual"] = "timing"
    rate_profile: Literal["low", "medium", "high", "custom"] | None = None
    interval_seconds: int = Field(default=10, ge=1, le=120)
    force: bool = False


class ScanControl(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    action: Literal["pause", "resume", "cancel", "retry_failed"]


class ScanApply(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    item_ids: list[str] = Field(min_length=1, max_length=100)


class LyricLock(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    locked: bool
    version: int = Field(ge=1)


class ScanSettings(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    default_profile: Literal["low", "medium", "high"] = "low"
    low_seconds: int = Field(default=10, ge=1, le=120)
    medium_seconds: int = Field(default=5, ge=1, le=120)
    high_seconds: int = Field(default=2, ge=1, le=120)
    version: int = Field(ge=1)

    @model_validator(mode="after")
    def ordered(self):
        if not self.low_seconds >= self.medium_seconds >= self.high_seconds:
            raise ValueError("frequency_intervals_must_be_ordered")
        return self


def signature(track, record):
    value = [
        track["title"],
        track.get("artists"),
        track.get("album"),
        track.get("duration_ms"),
        record["file_version"],
        record["version"],
    ]
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


class LyricScans:
    def __init__(self, sources):
        self.sources, self.database = sources, sources.database
        self.exit = threading.Event()
        self.thread = None
        self.lifecycle_lock = threading.Lock()

    def settings(self, body=None):
        with self.database.connect(write=body is not None) as db:
            if body is not None:
                db.execute("BEGIN IMMEDIATE")
                changed = db.execute(
                    "UPDATE lyric_scan_settings SET default_profile=?,low_seconds=?,medium_seconds=?,high_seconds=?,version=version+1 WHERE id=1 AND version=?",
                    (
                        body.default_profile,
                        body.low_seconds,
                        body.medium_seconds,
                        body.high_seconds,
                        body.version,
                    ),
                ).rowcount
                if not changed:
                    raise HTTPException(409, "lyric_scan_settings_conflict")
            row = dict(db.execute("SELECT * FROM lyric_scan_settings WHERE id=1").fetchone())
        row.pop("id")
        return row

    def start(self):
        with self.lifecycle_lock:
            if self.sources.providers.exit.is_set() or (self.thread and self.thread.is_alive()):
                return
            self.exit.clear()
            with self.database.connect(write=True) as db:
                db.execute("UPDATE lyric_scan_items SET status='queued' WHERE status='running'")
            thread = threading.Thread(target=self.run, daemon=True, name="lyric-scans")
            thread.start()
            self.thread = thread

    def stop(self):
        with self.lifecycle_lock:
            self.exit.set()
            thread = self.thread
        if thread:
            thread.join(timeout=2)

    def run(self):
        while not self.exit.wait(0.5):
            try:
                self.sources.providers.check_storage()
                self.step()
            except Exception as error:
                from wildstring.diagnostics import record_event

                record_event(
                    "lyric.scan.worker.failed",
                    level="WARNING",
                    code="lyric_scan_worker_failed",
                    exception_type=type(error).__name__,
                )

    def tracks(self, options):
        query = "SELECT id,title FROM tracks WHERE library_id=? AND status='available'"
        args = [self.sources.providers.repository.library_id()]
        if options.scope == "album":
            if not options.scope_id:
                raise HTTPException(422, "lyric_scan_album_required")
            query += " AND album_id=?"
            args.append(options.scope_id)
        elif options.scope_id is not None:
            raise HTTPException(422, "lyric_scan_invalid_scope")
        with self.database.connect() as db:
            return [
                dict(row)
                for row in db.execute(
                    query + " ORDER BY album_id,disc_number,track_number,id", args
                )
            ]

    def create(self, body):
        defaults = self.settings()
        profile = body.rate_profile or defaults["default_profile"]
        body = body.model_copy(
            update={
                "rate_profile": profile,
                "interval_seconds": body.interval_seconds
                if profile == "custom"
                else defaults[profile + "_seconds"],
            }
        )
        tracks = self.tracks(body)
        configs = [
            c
            for c in self.sources.catalog()
            if c["enabled"] and c["lyrics_enabled"] and c["available"]
        ]
        if not configs:
            raise HTTPException(409, "source_plugins_disabled")
        plugins = self.sources.plugins
        options = body.model_dump() | {
            "providers": [
                {"id": c["id"], "version": c["version"], "sha256": plugins[c["id"]].sha256}
                for c in configs
            ]
        }
        identity, now = uuid4().hex, time.time()
        with self.database.connect(write=True) as db:
            db.execute("BEGIN IMMEDIATE")
            if (
                db.execute(
                    "SELECT count(*) FROM lyric_scan_batches WHERE status IN ('running','paused')"
                ).fetchone()[0]
                >= 10
            ):
                raise HTTPException(409, "lyric_scan_queue_full")
            db.execute(
                "INSERT INTO lyric_scan_batches VALUES (?,?,?,?,?,?,?)",
                (
                    identity,
                    self.sources.providers.repository.library_id(),
                    json.dumps(options),
                    "running" if tracks else "completed",
                    len(tracks),
                    now,
                    now,
                ),
            )
            db.executemany(
                "INSERT INTO lyric_scan_items(id,batch_id,track_id,title,updated_at) VALUES (?,?,?,?,?)",
                [(uuid4().hex, identity, t["id"], t["title"], now) for t in tracks],
            )
        return self.read(identity)

    def batch(self, identity, db):
        row = db.execute(
            "SELECT * FROM lyric_scan_batches WHERE id=? AND library_id=?",
            (identity, self.sources.providers.repository.library_id()),
        ).fetchone()
        if not row:
            raise HTTPException(404, "lyric_scan_not_found")
        return dict(row)

    def read(self, identity, offset=0, limit=50):
        with self.database.connect() as db:
            batch = self.batch(identity, db)
            counts = {
                row["status"]: row["n"]
                for row in db.execute(
                    "SELECT status,count(*) AS n FROM lyric_scan_items WHERE batch_id=? GROUP BY status",
                    (identity,),
                )
            }
            rows = [
                dict(row)
                for row in db.execute(
                    "SELECT * FROM lyric_scan_items WHERE batch_id=? ORDER BY rowid LIMIT ? OFFSET ?",
                    (identity, limit, offset),
                )
            ]
            gates = [
                dict(row)
                for row in db.execute(
                    "SELECT plugin_id,cooldown_until,reason FROM plugin_request_gates WHERE cooldown_until>?",
                    (time.time(),),
                )
            ]
        for row in rows:
            row.pop("previous")
            row.pop("fingerprint")
            for field in ("baseline", "quality", "results"):
                row[field] = json.loads(row[field]) if row[field] else None
        return batch | {
            "options": json.loads(batch["options"]),
            "counts": counts,
            "items": rows,
            "offset": offset,
            "limit": limit,
            "cooldowns": gates,
        }

    def control(self, identity, action):
        with self.database.connect(write=True) as db:
            db.execute("BEGIN IMMEDIATE")
            batch = self.batch(identity, db)
            if action == "pause" and batch["status"] == "running":
                db.execute(
                    "UPDATE lyric_scan_batches SET status='paused',updated_at=? WHERE id=?",
                    (time.time(), identity),
                )
                db.execute(
                    "UPDATE lyric_lookup_jobs SET status='paused' WHERE id IN (SELECT job_id FROM lyric_scan_items WHERE batch_id=?) AND status='running'",
                    (identity,),
                )
            elif action == "resume" and batch["status"] == "paused":
                db.execute(
                    "UPDATE lyric_scan_batches SET status='running',updated_at=? WHERE id=?",
                    (time.time(), identity),
                )
            elif action == "cancel" and batch["status"] in {"running", "paused"}:
                db.execute(
                    "UPDATE lyric_scan_batches SET status='cancelled',updated_at=? WHERE id=?",
                    (time.time(), identity),
                )
                db.execute(
                    "UPDATE lyric_scan_items SET status='cancelled' WHERE batch_id=? AND status IN ('queued','running')",
                    (identity,),
                )
                db.execute(
                    "UPDATE lyric_lookup_jobs SET status='cancelled' WHERE id IN (SELECT job_id FROM lyric_scan_items WHERE batch_id=?) AND status IN ('running','paused')",
                    (identity,),
                )
            elif action == "retry_failed" and batch["status"] != "running":
                db.execute(
                    "UPDATE lyric_scan_items SET status='queued',provider_index=0,attempts=0,next_at=0,error=NULL,results='{}' WHERE batch_id=? AND (status='failed' OR error IS NOT NULL) AND status NOT IN ('applied','restored')",
                    (identity,),
                )
                db.execute(
                    "UPDATE lyric_scan_batches SET status='running',updated_at=? WHERE id=?",
                    (time.time(), identity),
                )
            else:
                raise HTTPException(409, "lyric_scan_state_conflict")
        return self.read(identity)

    def lock(self, track_id, body=None):
        if self.sources.providers.repository.track(track_id) is None:
            raise HTTPException(404, "track_not_found")
        with self.database.connect(write=body is not None) as db:
            if body is not None:
                db.execute("BEGIN IMMEDIATE")
            row = db.execute(
                "SELECT locked,version FROM lyric_locks WHERE track_id=?", (track_id,)
            ).fetchone()
            locked, version = row if row else (0, 1)
            if body is not None:
                if body.version != version:
                    raise HTTPException(409, "lyric_lock_version_conflict")
                locked, version = body.locked, version + 1
                db.execute(
                    "INSERT INTO lyric_locks VALUES (?,?,?) ON CONFLICT(track_id) DO UPDATE SET locked=excluded.locked,version=excluded.version",
                    (track_id, locked, version),
                )
        return {"locked": bool(locked), "version": version}

    def checkpoint(self, db, batch_id):
        row = db.execute("SELECT status FROM lyric_scan_batches WHERE id=?", (batch_id,)).fetchone()
        if not row or row[0] != "running" or self.exit.is_set():
            raise PluginError("lyric_scan_paused")

    def finish_item(self, item, status):
        with self.database.connect(write=True) as db:
            self.checkpoint(db, item["batch_id"])
            db.execute(
                "UPDATE lyric_scan_items SET status=?,updated_at=? WHERE id=?",
                (status, time.time(), item["id"]),
            )
            if item.get("job_id"):
                db.execute(
                    "UPDATE lyric_lookup_jobs SET status=?,updated_at=? WHERE id=?",
                    (
                        "completed"
                        if item.get("candidate_id")
                        else "failed"
                        if item.get("error")
                        else "no_match",
                        time.time(),
                        item["job_id"],
                    ),
                )

    def complete(self, identity):
        with self.database.connect(write=True) as db:
            db.execute("BEGIN IMMEDIATE")
            remaining = db.execute(
                "SELECT 1 FROM lyric_scan_items WHERE batch_id=? AND status IN ('queued','running')",
                (identity,),
            ).fetchone()
            if remaining:
                return
            changed = db.execute(
                "UPDATE lyric_scan_batches SET status='completed',updated_at=? WHERE id=? AND status='running'",
                (time.time(), identity),
            ).rowcount
            platform = getattr(self.sources.providers, "platform", None)
            if changed and platform:
                from wildstring.task_notifications import admins

                counts = Counter(
                    {
                        r[0]: r[1]
                        for r in db.execute(
                            "SELECT status,count(*) FROM lyric_scan_items WHERE batch_id=? GROUP BY status",
                            (identity,),
                        )
                    }
                )
                for owner in admins(db):
                    platform.emit(
                        db,
                        owner,
                        "lyrics.scan.completed",
                        f"lyrics:{identity}:{owner}",
                        "歌词补全与洗版扫描结束",
                        f"可升级 {counts['ready']} 首，待核对 {counts['review']} 首，未匹配 {counts['no_match']} 首，失败 {counts['failed']} 首。请到歌词补全查看并确认。",
                        counts=dict(counts),
                    )

    def step(self):
        now = time.time()
        with self.database.connect(write=True) as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute(
                "SELECT i.*,b.options FROM lyric_scan_items i JOIN lyric_scan_batches b ON b.id=i.batch_id WHERE b.status='running' AND i.status='queued' AND i.next_at<=? ORDER BY i.updated_at,i.rowid LIMIT 1",
                (now,),
            ).fetchone()
            if not row:
                batches = [
                    r[0]
                    for r in db.execute("SELECT id FROM lyric_scan_batches WHERE status='running'")
                ]
            else:
                db.execute("UPDATE lyric_scan_items SET status='running' WHERE id=?", (row["id"],))
                batches = []
        if not row:
            for identity in batches:
                self.complete(identity)
            return False
        item, options = dict(row), json.loads(row["options"])
        try:
            self.process(item, options)
        except PluginError as error:
            if error.code == "lyric_scan_paused":
                with self.database.connect(write=True) as db:
                    db.execute(
                        "UPDATE lyric_scan_items SET status='queued',updated_at=? WHERE id=? AND status='running'",
                        (time.time(), item["id"]),
                    )
            else:
                self.failed(item, error.code)
        except HTTPException as error:
            self.finish_item(item, "stale" if error.status_code == 404 else "failed")
        except Exception as error:
            from wildstring.diagnostics import record_event

            record_event(
                "lyric.scan.item.failed",
                level="WARNING",
                code="lyric_scan_failed",
                exception_type=type(error).__name__,
            )
            self.failed(item, "lyric_scan_failed")
        self.complete(item["batch_id"])
        return True

    def failed(self, item, code):
        with self.database.connect(write=True) as db:
            db.execute(
                "UPDATE lyric_scan_items SET error=?,status='failed',updated_at=? WHERE id=? AND status='running'",
                (code, time.time(), item["id"]),
            )
            if item.get("job_id"):
                db.execute(
                    "UPDATE lyric_lookup_jobs SET status='failed',error=? WHERE id=? AND status='running'",
                    (code, item["job_id"]),
                )

    def process(self, item, options):
        track = self.sources.providers.repository.track(item["track_id"])
        editor = LyricsEditor(self.sources.providers.repository)
        record = editor.read(item["track_id"])
        if self.lock(item["track_id"])["locked"]:
            self.finish_item(item, "locked")
            return
        fingerprint = signature(track, record)
        before = quality(record["effective"])
        if not item["baseline"]:
            item["baseline"] = json.dumps(
                before | {"version": record["version"], "file_version": record["file_version"]}
            )
            item["fingerprint"] = fingerprint
            with self.database.connect(write=True) as db:
                db.execute(
                    "UPDATE lyric_scan_items SET baseline=?,fingerprint=? WHERE id=?",
                    (item["baseline"], fingerprint, item["id"]),
                )
        elif (
            item["fingerprint"] != fingerprint
            or json.loads(item["baseline"])["version"] != record["version"]
        ):
            self.finish_item(item, "stale")
            return
        if (options["mode"] == "missing" and before["level"] > 0) or reaches(
            before, options["goal"]
        ):
            self.finish_item(item, "skipped_goal")
            return
        providers = options["providers"]
        if item["provider_index"] >= len(providers):
            result = json.loads(item["results"])
            status = (
                "ready"
                if item["candidate_id"]
                else "review"
                if any(v["status"] == "review" for v in result.values())
                else "failed"
                if item["error"]
                else "skipped_scanned"
                if result and all(v["status"] == "skipped_scanned" for v in result.values())
                else "no_match"
            )
            self.finish_item(item, status)
            return
        provider = providers[item["provider_index"]]
        identity = provider["id"]
        config = self.sources.current(identity, provider["version"])
        if (
            not config["lyrics_enabled"]
            or self.sources.plugins[identity].sha256 != provider["sha256"]
        ):
            raise PluginError("source_plugin_configuration_changed")
        target = json.dumps(
            [options["goal"], options["preference"], provider["version"], provider["sha256"]]
        )
        with self.database.connect() as db:
            covered = db.execute(
                "SELECT * FROM lyric_scan_coverage WHERE track_id=? AND plugin_id=? AND fingerprint=? AND target=?",
                (track["id"], identity, fingerprint, target),
            ).fetchone()
        if covered and not options["force"]:
            self.advance(item, identity, "skipped_scanned", covered["candidate_id"])
            return
        if not self.claim_job(item):
            return
        try:
            self.lookup(item, track, record, provider, options, target)
        except PluginError as error:
            if error.code == "lyric_scan_paused":
                raise
            with self.database.connect() as db:
                gate = db.execute(
                    "SELECT cooldown_until FROM plugin_request_gates WHERE plugin_id=?", (identity,)
                ).fetchone()
            transient = error.code not in {
                "source_plugin_auth_or_rejected",
                "source_plugin_dependency_missing",
                "source_plugin_configuration_changed",
            }
            if transient and item["attempts"] < 2:
                due = max(time.time() + 30 * (2 ** item["attempts"]), gate[0] if gate else 0)
                with self.database.connect(write=True) as db:
                    db.execute(
                        "UPDATE lyric_scan_items SET status='queued',attempts=attempts+1,next_at=?,error=?,updated_at=? WHERE id=? AND status='running'",
                        (due, error.code, time.time(), item["id"]),
                    )
            else:
                self.advance(item, identity, "failed", error=error.code)

    def claim_job(self, item):
        with self.database.connect(write=True) as db:
            db.execute("BEGIN IMMEDIATE")
            self.checkpoint(db, item["batch_id"])
            other = db.execute(
                "SELECT id FROM lyric_lookup_jobs WHERE track_id=? AND status IN ('queued','running') AND id!=?",
                (item["track_id"], item["job_id"] or ""),
            ).fetchone()
            if other:
                db.execute(
                    "UPDATE lyric_scan_items SET status='queued',next_at=? WHERE id=?",
                    (time.time() + 5, item["id"]),
                )
                return False
            if not item["job_id"]:
                item["job_id"] = uuid4().hex
                db.execute(
                    "INSERT INTO lyric_lookup_jobs VALUES (?,?,'running',NULL,'[]',?,?)",
                    (item["job_id"], item["track_id"], time.time(), time.time()),
                )
                db.execute(
                    "UPDATE lyric_scan_items SET job_id=? WHERE id=?", (item["job_id"], item["id"])
                )
            else:
                db.execute(
                    "UPDATE lyric_lookup_jobs SET status='running' WHERE id=?", (item["job_id"],)
                )
        return True

    def lookup(self, item, track, record, provider, options, target):
        identity = provider["id"]
        candidates, context = self.sources.candidates(
            track,
            identity,
            force=options["force"],
            batch_id=item["batch_id"],
            interval_seconds=options["interval_seconds"],
        )
        outcome, best_id, best_quality = "no_match", None, None
        before = json.loads(item["baseline"])
        for candidate in candidates[:2]:
            try:
                raw = self.sources.plugins[identity].lyrics(context, candidate)
            except PluginError as error:
                if error.code == "source_plugin_no_lyrics":
                    continue
                if best_id or outcome == "review":
                    self.advance(
                        item,
                        identity,
                        "found" if best_id else "review",
                        best_id,
                        best_quality,
                        error=error.code,
                    )
                    return
                raise
            if (
                len(json.dumps(raw).encode()) > 2 * 1024 * 1024
                or len(json.dumps({k: v for k, v in raw.items() if k != "normalized"}).encode())
                > 512 * 1024
            ):
                raise PluginError("source_plugin_response_too_large")
            normalized = normalize_bundle(raw, identity)
            candidate_quality = quality(normalized)
            if not candidate_quality["level"]:
                continue
            good = matched(candidate) and improves(before, candidate_quality, options["preference"])
            candidate_id = uuid4().hex
            with self.database.connect(write=True) as db:
                self.checkpoint(db, item["batch_id"])
                self.sources.current(identity, provider["version"])
                db.execute(
                    "INSERT INTO lyric_candidates VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                    (
                        candidate_id,
                        item["job_id"],
                        track["id"],
                        identity,
                        str(candidate["id"]),
                        candidate["source_url"],
                        json.dumps(candidate["match"]),
                        json.dumps({k: v for k, v in raw.items() if k != "normalized"}),
                        json.dumps(normalized),
                        record["version"],
                        record["file_version"],
                        time.time(),
                    ),
                )
            if good and (
                best_quality is None
                or rank(candidate_quality["level"], options["preference"])
                > rank(best_quality["level"], options["preference"])
            ):
                best_id, best_quality = candidate_id, candidate_quality
                outcome = "found"
            elif outcome != "found":
                outcome = "review"
            if best_quality and reaches(best_quality, options["goal"]):
                break
        with self.database.connect(write=True) as db:
            self.checkpoint(db, item["batch_id"])
            db.execute(
                "INSERT INTO lyric_scan_coverage VALUES (?,?,?,?,?,?,?) ON CONFLICT(track_id,plugin_id,fingerprint,target) DO UPDATE SET outcome=excluded.outcome,candidate_id=excluded.candidate_id,updated_at=excluded.updated_at",
                (track["id"], identity, item["fingerprint"], target, outcome, best_id, time.time()),
            )
        self.advance(item, identity, outcome, best_id, best_quality)
        if best_quality and reaches(best_quality, options["goal"]):
            item["candidate_id"] = best_id
            self.finish_item(item, "ready")

    def advance(
        self, item, identity, status, candidate_id=None, candidate_quality=None, error=None
    ):
        results = json.loads(item["results"])
        results[identity] = {"status": status, "error": error}
        current = json.loads(item["quality"]) if item["quality"] else None
        options = json.loads(item["options"])
        if candidate_id and candidate_quality is None:
            with self.database.connect() as db:
                row = db.execute(
                    "SELECT normalized,match FROM lyric_candidates WHERE id=?", (candidate_id,)
                ).fetchone()
            if row:
                candidate_quality = quality(json.loads(row[0]))
                if not matched({"match": json.loads(row[1])}) or not improves(
                    json.loads(item["baseline"]), candidate_quality, options["preference"]
                ):
                    candidate_quality = None
        if candidate_quality and (
            current is None
            or rank(candidate_quality["level"], options["preference"])
            > rank(current["level"], options["preference"])
        ):
            item["candidate_id"], item["quality"] = candidate_id, json.dumps(candidate_quality)
        with self.database.connect(write=True) as db:
            self.checkpoint(db, item["batch_id"])
            db.execute(
                "UPDATE lyric_scan_items SET status='queued',provider_index=provider_index+1,attempts=0,next_at=0,candidate_id=?,quality=?,results=?,error=?,updated_at=? WHERE id=?",
                (
                    item["candidate_id"],
                    item["quality"],
                    json.dumps(results),
                    next((v["error"] for v in results.values() if v.get("error")), None),
                    time.time(),
                    item["id"],
                ),
            )

    def apply(self, identity, item_ids):
        output = []
        with self.database.connect() as db:
            self.batch(identity, db)
            rows = {
                r["id"]: dict(r)
                for r in db.execute(
                    "SELECT * FROM lyric_scan_items WHERE batch_id=? AND id IN (SELECT value FROM json_each(?))",
                    (identity, json.dumps(item_ids)),
                )
            }
        if len(rows) != len(set(item_ids)):
            raise HTTPException(404, "lyric_scan_item_not_found")
        for item_id in dict.fromkeys(item_ids):
            item = rows[item_id]
            try:
                if item["status"] != "ready":
                    raise HTTPException(409, "lyric_scan_item_not_ready")
                baseline = json.loads(item["baseline"])
                self.sources.apply(
                    item["candidate_id"],
                    LyricChoice(version=baseline["version"], file_version=baseline["file_version"]),
                    scan_item=item_id,
                )
                output.append({"id": item_id, "status": "applied"})
            except HTTPException as error:
                output.append({"id": item_id, "status": "conflict", "error": str(error.detail)})
        return {"items": output}

    def restore(self, item_id):
        with self.database.connect(write=True) as db:
            db.execute("BEGIN IMMEDIATE")
            item = db.execute("SELECT * FROM lyric_scan_items WHERE id=?", (item_id,)).fetchone()
            if not item:
                raise HTTPException(404, "lyric_scan_item_not_found")
            self.batch(item["batch_id"], db)
            row = db.execute(
                "SELECT * FROM track_lyrics WHERE track_id=?", (item["track_id"],)
            ).fetchone()
            if item["status"] != "applied" or not row or row["version"] != item["applied_version"]:
                raise HTTPException(409, "lyrics_version_conflict")
            previous = json.loads(item["previous"])
            _, file_version = LyricsEditor(self.sources.providers.repository).observed(
                item["track_id"]
            )
            if file_version != json.loads(item["baseline"])["file_version"]:
                raise HTTPException(409, "lyrics_version_conflict")
            db.execute(
                "UPDATE track_lyrics SET text=?,selected_candidate=?,version=version+1 WHERE track_id=?",
                (
                    previous["text"],
                    json.dumps(previous["selected_candidate"])
                    if previous["selected_candidate"]
                    else None,
                    item["track_id"],
                ),
            )
            db.execute(
                "UPDATE lyric_scan_items SET status='restored',updated_at=? WHERE id=?",
                (time.time(), item_id),
            )
        return {"ok": True}

    def router(self, auth):
        router = APIRouter(prefix="/api/v1/manage")
        admin, mutation = Depends(auth.require_admin), [Depends(auth.require_client)]

        @router.get("/lyric-scan-settings")
        def read_settings(user=admin):
            return self.settings()

        @router.put("/lyric-scan-settings", dependencies=mutation)
        def save_settings(body: ScanSettings, user=admin):
            return self.settings(body)

        @router.get("/lyric-scans")
        def batches(user=admin):
            with self.database.connect() as db:
                ids = [
                    r[0]
                    for r in db.execute(
                        "SELECT id FROM lyric_scan_batches WHERE library_id=? ORDER BY created_at DESC LIMIT 30",
                        (self.sources.providers.repository.library_id(),),
                    )
                ]
            return {"items": [self.read(i, limit=0) for i in ids]}

        @router.post("/lyric-scans/preview", dependencies=mutation)
        def preview(body: ScanOptions, user=admin):
            return {"total": len(self.tracks(body)), "options": body.model_dump()}

        @router.post("/lyric-scans", dependencies=mutation)
        def create(body: ScanOptions, user=admin):
            return self.create(body)

        @router.get("/lyric-scans/{identity}")
        def read(
            identity: str,
            offset: int = Query(0, ge=0),
            limit: int = Query(50, ge=1, le=100),
            user=admin,
        ):
            return self.read(identity, offset, limit)

        @router.post("/lyric-scans/{identity}/control", dependencies=mutation)
        def control(identity: str, body: ScanControl, user=admin):
            return self.control(identity, body.action)

        @router.post("/lyric-scans/{identity}/apply", dependencies=mutation)
        def apply(identity: str, body: ScanApply, user=admin):
            return self.apply(identity, body.item_ids)

        @router.post("/lyric-scan-items/{identity}/restore", dependencies=mutation)
        def restore(identity: str, user=admin):
            return self.restore(identity)

        @router.get("/tracks/{track_id}/lyric-lock")
        def read_lock(track_id: str, user=admin):
            return self.lock(track_id)

        @router.put("/tracks/{track_id}/lyric-lock", dependencies=mutation)
        def save_lock(track_id: str, body: LyricLock, user=admin):
            return self.lock(track_id, body)

        return router
