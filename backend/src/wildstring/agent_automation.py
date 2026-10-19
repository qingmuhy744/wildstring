"""SQLite leases and incremental read-only inspection; approved changes are never automatic."""

import json
import threading
import time
from collections import Counter
from uuid import uuid4

from fastapi import HTTPException

from wildstring.agent_common import encoded, future, validate
from wildstring.agent_models import Inspection
from wildstring.library.repository import now

RESUMABLE = {
    "paused_authorization",
    "paused_budget",
    "interrupted",
    "failed",
    "partial",
    "cancelled",
    "retry_wait",
}


def inspection_evidence(results, counts):
    """Explain exceptions across the whole inspection, without exporting clean tracks."""
    affected = [
        r for r in results if r.get("track_id") and (r.get("issues") or r.get("error_code"))
    ]
    issues = Counter(issue for r in affected for issue in r.get("issues", []))
    items = []
    for record in affected:
        item = {key: record[key] for key in ("track_id", "metadata_version") if key in record}
        item["title"] = str(record.get("title", ""))[:200]
        item["issues"] = record.get("issues", [])[:20]
        if record.get("error_code"):
            item["error_code"] = str(record["error_code"])[:100]
        if len(encoded(items + [item])) > 16000 or len(items) >= 20:
            break
        items.append(item)
    return {
        "counts": counts,
        "issue_counts": dict(issues),
        "affected": len(affected),
        "items": items,
    }


class Automation:
    def submit_task(self, actor, body, *, schedule_key=None, manual=False):
        actor.require("tasks:write")
        actor.require("library:read")
        parameters = body.model_dump()
        # Only the authenticated UI route grants a one-task authorization. Tool and
        # scheduled submissions cannot supply this internal field in Inspection.
        manual_ai = manual and schedule_key is None and actor.credential_id is None
        configuration = None
        if body.use_ai:
            if not body.connection_id:
                raise HTTPException(422, "ai_connection_required")
            configuration = self.connection_for(actor, body.connection_id, background=not manual_ai)
            parameters["_manual_ai_authorized"] = manual_ai
        identities = body.track_ids
        if identities is None:
            identities = [
                track["id"]
                for track in self.repository_for(actor).tracks(limit=body.max_tracks)["items"]
            ]
        if len(identities) > body.max_tracks or len(identities) != len(set(identities)):
            raise HTTPException(422, "inspection_limit")
        for identity in identities:
            if not isinstance(identity, str) or not self.repository_for(actor).track(identity):
                raise HTTPException(404, "track_not_found")
        parameters["track_ids"] = identities
        parameters["metadata_versions"] = {
            identity: self.get_track(actor, identity)["metadata_version"] for identity in identities
        }
        from wildstring.diagnostics import trace_id as current_trace

        identity, trace_id = uuid4().hex, current_trace()
        connection_version = configuration["version"] if configuration is not None else None
        with self.database.connect(write=True) as connection:
            connection.execute(
                "INSERT OR IGNORE INTO agent_tasks(id,user_id,auth_version,credential_id,parameters,created_at,updated_at,trace_id,schedule_key,connection_version) VALUES (?,?,?,?,?,?,?,?,?,?)",
                (
                    identity,
                    actor.user_id,
                    actor.version,
                    actor.credential_id,
                    encoded(parameters),
                    now(),
                    now(),
                    trace_id,
                    schedule_key,
                    connection_version,
                ),
            )
            if schedule_key:
                identity = connection.execute(
                    "SELECT id FROM agent_tasks WHERE schedule_key=?", (schedule_key,)
                ).fetchone()[0]
        self.log("agent.task.queued", actor, task_id=identity, trace_id=trace_id)
        self.wake.set()
        return self.task(actor, identity)

    def task(self, actor, identity):
        with self.database.connect() as connection:
            row = connection.execute(
                "SELECT * FROM agent_tasks WHERE id=? AND user_id=?", (identity, actor.user_id)
            ).fetchone()
        if row is None:
            raise HTTPException(404, "agent_task_not_found")
        result = {
            key: row[key]
            for key in row.keys()
            if key
            not in {"user_id", "auth_version", "credential_id", "lease_token", "connection_version"}
        }
        for key in ("parameters", "counts", "results"):
            result[key] = json.loads(result[key])
        result["parameters"].pop("_manual_ai_authorized", None)
        return result

    def tasks(self, actor, limit=50, offset=0):
        with self.database.connect() as connection:
            rows = connection.execute(
                "SELECT id FROM agent_tasks WHERE user_id=? ORDER BY created_at DESC,id LIMIT ? OFFSET ?",
                (actor.user_id, limit, offset),
            ).fetchall()
            total = connection.execute(
                "SELECT count(*) FROM agent_tasks WHERE user_id=?", (actor.user_id,)
            ).fetchone()[0]
        return {
            "items": [self.task(actor, row["id"]) for row in rows],
            "total": total,
            "limit": limit,
            "offset": offset,
        }

    def cancel_task(self, actor, identity):
        actor.require("tasks:write")
        self.task(actor, identity)
        with self.database.connect(write=True) as connection:
            connection.execute(
                "UPDATE agent_tasks SET status=CASE WHEN status='running' THEN 'cancel_requested' ELSE 'cancelled' END,cancel_requested=1,version=version+1,updated_at=? WHERE id=? AND status NOT IN ('succeeded','partial','failed','cancelled')",
                (now(), identity),
            )
        return self.task(actor, identity)

    def resume_task(self, actor, identity):
        actor.require("tasks:write")
        self.task(actor, identity)
        with self.database.connect(write=True) as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                "SELECT * FROM agent_tasks WHERE id=? AND user_id=?", (identity, actor.user_id)
            ).fetchone()
            if row["status"] not in RESUMABLE:
                raise HTTPException(409, "agent_task_not_resumable")
            parameters = json.loads(row["parameters"])
            connection_version = row["connection_version"]
            if parameters.get("connection_id"):
                connection_version = self.connection_for(actor, parameters["connection_id"])[
                    "version"
                ]
            connection.execute(
                "UPDATE agent_tasks SET status='queued',stage='rules',cancel_requested=0,auth_version=?,credential_id=?,connection_version=?,lease_token=NULL,lease_until=NULL,error_code=NULL,version=version+1,updated_at=? WHERE id=?",
                (actor.version, actor.credential_id, connection_version, now(), identity),
            )
        self.wake.set()
        return self.task(actor, identity)

    def claim_task(self):
        with self.database.connect(write=True) as connection:
            connection.execute("BEGIN IMMEDIATE")
            expired = connection.execute(
                "SELECT id,stage FROM agent_tasks WHERE status IN ('running','cancel_requested') AND lease_until<?",
                (now(),),
            ).fetchall()
            for row in expired:
                # A request may have consumed model budget even if its response was lost.
                status = "paused_budget" if row["stage"] == "model_call" else "queued"
                code = "model_outcome_unknown" if row["stage"] == "model_call" else "lease_expired"
                connection.execute(
                    "UPDATE agent_tasks SET status=?,error_code=?,lease_token=NULL,lease_until=NULL WHERE id=?",
                    (status, code, row["id"]),
                )
            row = connection.execute(
                "SELECT * FROM agent_tasks WHERE status='queued' ORDER BY created_at,id LIMIT 1"
            ).fetchone()
            if row is None:
                return None
            token = uuid4().hex
            connection.execute(
                "UPDATE agent_tasks SET status='running',attempts=attempts+1,lease_token=?,lease_until=?,heartbeat_at=?,updated_at=?,version=version+1 WHERE id=?",
                (token, future(180), now(), now(), row["id"]),
            )
            return dict(row) | {"lease_token": token}

    def validate_task_actor(self, job):
        actor = self.current_actor(job["user_id"], credential_id=job["credential_id"])
        if actor.version != job["auth_version"]:
            raise HTTPException(403, "agent_authorization_changed")
        if actor.credential_id:
            with self.database.connect() as connection:
                row = connection.execute(
                    "SELECT scopes FROM agent_credentials WHERE id=? AND revoked_at IS NULL AND expires_at>?",
                    (actor.credential_id, now()),
                ).fetchone()
            if row is None or "tasks:write" not in json.loads(row["scopes"]):
                raise HTTPException(403, "agent_authorization_revoked")
        return self.refresh_actor(actor)

    def check_task_continuation(self, job):
        """Recheck cooperative cancellation and authority before another external/tool step."""
        if self.stop_event.is_set():
            raise HTTPException(409, "service_stopping")
        self.validate_task_actor(job)
        with self.database.connect() as connection:
            current = connection.execute(
                "SELECT cancel_requested,lease_token FROM agent_tasks WHERE id=? AND user_id=?",
                (job["id"], job["user_id"]),
            ).fetchone()
        if current is None or current["lease_token"] != job["lease_token"]:
            raise HTTPException(409, "agent_task_lease_lost")
        if current["cancel_requested"]:
            raise HTTPException(409, "agent_task_cancelled")

    def checkpoint_task(self, job, checkpoint, results, counts, *, stage="rules"):
        with self.database.connect(write=True) as connection:
            result = connection.execute(
                "UPDATE agent_tasks SET checkpoint=?,results=?,counts=?,stage=?,heartbeat_at=?,lease_until=?,updated_at=?,version=version+1 WHERE id=? AND lease_token=?",
                (
                    checkpoint,
                    encoded(results),
                    encoded(counts),
                    stage,
                    now(),
                    future(180),
                    now(),
                    job["id"],
                    job["lease_token"],
                ),
            )
            if not result.rowcount:
                raise HTTPException(409, "agent_task_lease_lost")

    def finish_task(self, job, status, counts, *, error_code=None, results=None):
        with self.database.connect(write=True) as connection:
            connection.execute("BEGIN IMMEDIATE")
            result = connection.execute(
                "UPDATE agent_tasks SET status=?,stage=CASE WHEN ?='succeeded' THEN 'completed' ELSE stage END,counts=?,error_code=?,lease_until=NULL,lease_token=NULL,updated_at=?,version=version+1 WHERE id=? AND lease_token=?",
                (
                    status,
                    status,
                    encoded(counts),
                    error_code,
                    now(),
                    job["id"],
                    job["lease_token"],
                ),
            )
            if result.rowcount:
                scheduled = bool(job["schedule_key"])
                # Unchanged scheduled inspections are quiet. Results still remain in task history.
                if not (scheduled and status == "succeeded" and not counts.get("issues")):
                    event = (
                        "task.completed"
                        if status == "succeeded"
                        else "task.partial"
                        if status == "partial"
                        else "task.failed"
                        if status == "failed"
                        else "task.paused"
                    )
                    self.emit(
                        connection,
                        job["user_id"],
                        event,
                        f"task:{job['id']}:{job['attempts'] + 1}:{status}",
                        "曲库巡检完成" if status == "succeeded" else "曲库巡检需要处理",
                        f"已检查 {counts.get('processed', 0)} 首，发现 {counts.get('issues', 0)} 项，失败 {counts.get('failed', 0)} 首。"
                        + (f" 错误：{error_code}" if error_code else ""),
                        severity="error"
                        if status == "failed"
                        else "warning"
                        if status in {"partial", "paused_authorization", "paused_budget"}
                        else "info",
                        task_id=job["id"],
                        trace_id=job["trace_id"],
                        counts=counts,
                    )
        self.log(
            "agent.task.finished",
            task_id=job["id"],
            trace_id=job["trace_id"],
            status=status,
            error_code=error_code,
        )

    def execute_task(self, job):
        from wildstring.diagnostics import trace_context

        with trace_context(
            job["trace_id"], user_id=job["user_id"], task_id=job["id"], sink=self.diagnostics
        ):
            return self._execute_task(job)

    def _execute_task(self, job):
        parameters = json.loads(job["parameters"])
        background_ai = not (
            parameters.get("_manual_ai_authorized") is True
            and job["schedule_key"] is None
            and job["credential_id"] is None
        )
        results = json.loads(job["results"])
        counts = {"processed": 0, "issues": 0, "failed": 0, "skipped": 0, "calls": 0} | json.loads(
            job["counts"]
        )
        try:
            actor = self.validate_task_actor(job)
            identities = parameters["track_ids"]
            from wildstring.library.inspection import InspectionIndex

            inspection_index = InspectionIndex(self.repository_for(actor))
            started = time.monotonic()
            for index in range(job["checkpoint"], len(identities)):
                if time.monotonic() - started > 1800:
                    raise HTTPException(429, "agent_task_time_budget_exhausted")
                if self.stop_event.is_set():
                    self.finish_task(job, "interrupted", counts, error_code="service_stopping")
                    return
                actor = self.validate_task_actor(job)
                current = self.task(actor, job["id"])
                if current["cancel_requested"]:
                    self.finish_task(job, "cancelled", counts)
                    return
                identity = identities[index]
                try:
                    record = self.inspect(
                        actor, [identity], 1, rules=parameters.get("rules"), index=inspection_index
                    )["items"][0]
                    if record["metadata_version"] != parameters.get("metadata_versions", {}).get(
                        identity
                    ):
                        record["issues"].append("object_version_changed")
                        counts["skipped"] += 1
                    counts["issues"] += len(record["issues"])
                except HTTPException as failure:
                    record = {"track_id": identity, "issues": [], "error_code": failure.detail}
                    counts["failed"] += 1
                results.append(record)
                counts["processed"] += 1
                self.checkpoint_task(job, index + 1, results, counts)
            if parameters.get("use_ai"):
                if not parameters.get("connection_id"):
                    raise HTTPException(403, "background_connection_required")
                configuration = self.connection_for(actor, parameters["connection_id"])
                if configuration["version"] != job["connection_version"] or (
                    background_ai and not configuration.get("background_allowed")
                ):
                    raise HTTPException(403, "background_authorization_changed")
                self.check_task_continuation(job)
                evidence = inspection_evidence(results, counts)
                if not evidence["affected"] and not counts["failed"] and not counts["skipped"]:
                    results.append(
                        {
                            "analysis": f"本地规则已检查 {counts['processed']} 首，未发现待解释的问题，已跳过本次 AI 分析。规则检查不能证明音乐元数据或发行归属完全正确；需要考证时，可在助手中指定歌曲并核对来源。",
                            "draft_ids": [],
                            "ai_skipped": True,
                        }
                    )
                    self.checkpoint_task(
                        job, len(identities), results, counts, stage="analysis_complete"
                    )
                    self.check_task_continuation(job)
                    self.finish_task(job, "succeeded", counts)
                    return
                if parameters.get("max_calls", 0) <= counts["calls"]:
                    raise HTTPException(429, "agent_task_budget_exhausted")
                self.checkpoint_task(job, len(identities), results, counts, stage="model_call")
                # Explicit opt-in sends only a bounded projection, never local paths, audio or lyrics.
                prompt = (
                    "只解释这些实际规则巡检证据及可行的下一步，按问题类型汇总，回答不超过600字，不逐曲重复正常项。"
                    "统计覆盖整个巡检，items只是最多20首异常样本；未列出的歌曲不能视为已完成AI考证。"
                    "不要编造音乐事实或把缺失字段猜成已知。需要修改时仅生成待确认草案。\n"
                    + encoded(evidence)
                )

                def account_call():
                    counts["calls"] += 1
                    self.checkpoint_task(job, len(identities), results, counts, stage="model_call")

                model_result_index = len(results)

                def save_model_progress(progress):
                    summary = {
                        "analysis": f"已完成 {progress['tool_calls']} 次受控工具调用，已有草案仍需站内确认。",
                        "draft_ids": progress["draft_ids"],
                        "partial": True,
                    }
                    if len(results) == model_result_index:
                        results.append(summary)
                    else:
                        results[model_result_index] = summary
                    self.checkpoint_task(job, len(identities), results, counts, stage="model_call")

                outcome = self.model_loop(
                    actor,
                    configuration,
                    [{"role": "user", "content": prompt}],
                    max_calls=min(parameters["max_calls"] - counts["calls"], 8),
                    background=background_ai,
                    heartbeat=lambda iteration: self.checkpoint_task(
                        job,
                        len(identities),
                        results,
                        counts,
                        stage="model_call",
                    ),
                    on_call=account_call,
                    check_cancel=lambda: self.check_task_continuation(job),
                    on_progress=save_model_progress,
                    finalize=True,
                )
                complete = {"analysis": outcome["content"], "draft_ids": outcome["draft_ids"]}
                if len(results) == model_result_index:
                    results.append(complete)
                else:
                    results[model_result_index] = complete
                self.checkpoint_task(
                    job, len(identities), results, counts, stage="analysis_complete"
                )
            cancelled = self.task(actor, job["id"])["cancel_requested"]
            self.finish_task(
                job,
                "cancelled"
                if cancelled
                else "partial"
                if counts["failed"] or counts["skipped"]
                else "succeeded",
                counts,
            )
        except HTTPException as failure:
            status = (
                "cancelled"
                if failure.detail == "agent_task_cancelled"
                else "interrupted"
                if failure.detail == "service_stopping"
                else "paused_budget"
                if failure.status_code == 429
                else "paused_authorization"
                if failure.status_code in {401, 403}
                else "failed"
            )
            self.finish_task(job, status, counts, error_code=str(failure.detail))
        except Exception:
            self.finish_task(job, "failed", counts, error_code="agent_task_internal_error")

    def schedules(self, actor):
        with self.database.connect() as connection:
            rows = connection.execute(
                "SELECT * FROM agent_schedules WHERE user_id=? ORDER BY created_at DESC",
                (actor.user_id,),
            ).fetchall()
        return [
            dict(row)
            | {"parameters": json.loads(row["parameters"]), "enabled": bool(row["enabled"])}
            for row in rows
        ]

    def save_schedule(self, actor, body, identity=None):
        actor.require("tasks:write")
        if body.parameters.use_ai:
            if not body.parameters.connection_id:
                raise HTTPException(422, "background_connection_required")
            configuration = self.connection_for(actor, body.parameters.connection_id)
            if not configuration.get("background_allowed"):
                raise HTTPException(403, "background_authorization_required")
        with self.database.connect(write=True) as connection:
            if identity:
                result = connection.execute(
                    "UPDATE agent_schedules SET name=?,enabled=?,interval_hours=?,timezone=?,parameters=?,version=version+1,next_run_at=? WHERE id=? AND user_id=? AND version=?",
                    (
                        body.name,
                        body.enabled,
                        body.interval_hours,
                        body.timezone,
                        body.parameters.model_dump_json(),
                        future(body.interval_hours * 3600),
                        identity,
                        actor.user_id,
                        body.version,
                    ),
                )
                if not result.rowcount:
                    raise HTTPException(409, "schedule_version_conflict")
            else:
                identity = uuid4().hex
                connection.execute(
                    "INSERT INTO agent_schedules(id,user_id,name,enabled,interval_hours,timezone,parameters,next_run_at,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
                    (
                        identity,
                        actor.user_id,
                        body.name,
                        body.enabled,
                        body.interval_hours,
                        body.timezone,
                        body.parameters.model_dump_json(),
                        future(body.interval_hours * 3600),
                        now(),
                    ),
                )
        self.wake.set()
        return next(item for item in self.schedules(actor) if item["id"] == identity)

    def delete_schedule(self, actor, identity):
        with self.database.connect(write=True) as connection:
            result = connection.execute(
                "DELETE FROM agent_schedules WHERE id=? AND user_id=?", (identity, actor.user_id)
            )
            if not result.rowcount:
                raise HTTPException(404, "schedule_not_found")
        return {"ok": True}

    def schedule_due(self):
        # Claim one logical scheduled occurrence by moving its next due time atomically;
        # insert a unique task in the same transaction, with no network/file I/O held open.
        with self.database.connect() as connection:
            rows = connection.execute(
                "SELECT * FROM agent_schedules WHERE enabled=1 AND next_run_at<=? ORDER BY next_run_at LIMIT 20",
                (now(),),
            ).fetchall()
        for row in rows:
            try:
                actor = self.current_actor(row["user_id"])
                body = validate(Inspection, json.loads(row["parameters"]))
                identity = self.submit_task(
                    actor, body, schedule_key=f"{row['id']}:{row['next_run_at']}"
                )["id"]
                with self.database.connect(write=True) as connection:
                    connection.execute(
                        "UPDATE agent_schedules SET next_run_at=? WHERE id=? AND next_run_at=?",
                        (future(row["interval_hours"] * 3600), row["id"], row["next_run_at"]),
                    )
                self.log("agent.schedule.triggered", actor, task_id=identity)
            except HTTPException:
                # Stop repeated attempts until the user re-enables the invalid schedule.
                with self.database.connect(write=True) as connection:
                    connection.execute(
                        "UPDATE agent_schedules SET enabled=0,version=version+1 WHERE id=?",
                        (row["id"],),
                    )

    def work(self):
        last_cleanup = 0
        while not self.stop_event.is_set():
            try:
                if time.monotonic() - last_cleanup > 3600:
                    self.cleanup_notifications()
                    self.cleanup_conversations()
                    last_cleanup = time.monotonic()
                with self.database.connect(write=True) as connection:
                    connection.execute(
                        "UPDATE agent_runs SET status='interrupted',error_code='model_outcome_unknown',updated_at=? WHERE status='running' AND lease_until<?",
                        (now(), now()),
                    )
                self.schedule_due()
                job = self.claim_task()
                if job:
                    self.execute_task(job)
                sent = self.deliver_one()
                if not job and not sent:
                    self.wake.wait(2)
                    self.wake.clear()
            except Exception:
                self.log(
                    "agent.worker.error", level="ERROR", error_code="agent_worker_iteration_failed"
                )
                self.wake.wait(2)
                self.wake.clear()

    def start(self):
        self.stop_event.clear()
        self.wake.clear()
        with self.database.connect(write=True) as connection:
            # A synchronous model response may be lost if the process exited mid-call.
            connection.execute(
                "UPDATE agent_runs SET status='interrupted',error_code='model_outcome_unknown',updated_at=? WHERE status='running' AND (lease_until IS NULL OR lease_until<?)",
                (now(), now()),
            )
        self.thread = threading.Thread(target=self.work, name="wildstring-agent", daemon=True)
        self.thread.start()

    def stop(self):
        self.stop_event.set()
        self.wake.set()
        if self.thread:
            self.thread.join(timeout=130)
