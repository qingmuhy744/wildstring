"""Transactional inbox and a separate, recoverable external notification outbox."""

import json
import secrets
from datetime import UTC, datetime, timedelta
from uuid import uuid4
from zoneinfo import ZoneInfo

from fastapi import HTTPException

from wildstring.agent_common import digest, encoded, future
from wildstring.agent_models import NotificationPreferences
from wildstring.library.repository import now

SEVERITY = {"info": 0, "warning": 1, "error": 2}


class Notifications:
    def preferences(self, actor):
        with self.database.connect() as connection:
            row = connection.execute(
                "SELECT value FROM agent_preferences WHERE user_id=?", (actor.user_id,)
            ).fetchone()
        return json.loads(row[0]) if row else NotificationPreferences().model_dump()

    def set_preferences(self, actor, body):
        current = self.preferences(actor)
        current.update(body.model_dump())
        with self.database.connect(write=True) as connection:
            connection.execute(
                "INSERT INTO agent_preferences VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET value=excluded.value",
                (actor.user_id, encoded(current)),
            )
            if not current["telegram_enabled"]:
                connection.execute(
                    "UPDATE agent_deliveries SET status='cancelled',error_code='subscription_disabled' WHERE status IN ('queued','retry_wait') AND target_id IN (SELECT id FROM agent_telegram_targets WHERE user_id=?)",
                    (actor.user_id,),
                )
        return current

    def emit(
        self,
        connection,
        user_id,
        kind,
        dedupe_key,
        title,
        summary,
        *,
        severity="info",
        task_id=None,
        draft_id=None,
        trace_id=None,
        counts=None,
    ):
        identity, trace_id = uuid4().hex, trace_id or uuid4().hex
        inserted = connection.execute(
            "INSERT OR IGNORE INTO agent_events(id,user_id,kind,dedupe_key,title,summary,severity,task_id,draft_id,trace_id,counts,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                identity,
                user_id,
                kind,
                dedupe_key,
                title[:200],
                summary[:2000],
                severity,
                task_id,
                draft_id,
                trace_id,
                encoded(counts or {}),
                now(),
            ),
        )
        if not inserted.rowcount:
            return None
        notification = uuid4().hex
        connection.execute(
            "INSERT INTO agent_notifications(id,event_id,user_id,created_at) VALUES (?,?,?,?)",
            (notification, identity, user_id, now()),
        )
        self.notification_changed(connection, notification, user_id)
        preference = connection.execute(
            "SELECT value FROM agent_preferences WHERE user_id=?", (user_id,)
        ).fetchone()
        pref = json.loads(preference[0]) if preference else NotificationPreferences().model_dump()
        if (
            pref.get("telegram_enabled")
            and (not pref.get("event_types") or kind in pref["event_types"])
            and SEVERITY[severity] >= SEVERITY[pref.get("min_severity", "info")]
        ):
            targets = connection.execute(
                "SELECT id,version FROM agent_telegram_targets WHERE user_id=? AND enabled=1 AND verified=1 AND deleted_at IS NULL",
                (user_id,),
            ).fetchall()
            for target in targets:
                connection.execute(
                    "INSERT OR IGNORE INTO agent_deliveries(id,event_id,target_id,target_version,next_attempt_at,trace_id) VALUES (?,?,?,?,?,?)",
                    (uuid4().hex, identity, target["id"], target["version"], now(), trace_id),
                )
        return identity

    @staticmethod
    def notification_changed(connection, identity, user_id):
        change = connection.execute(
            "INSERT INTO agent_notification_changes(notification_id,user_id) VALUES (?,?)",
            (identity, user_id),
        ).lastrowid
        connection.execute(
            "UPDATE agent_notifications SET changed_seq=? WHERE id=?", (change, identity)
        )

    def notifications(self, actor, *, limit=50, offset=0, cursor=None):
        actor.require("notifications:read")
        with self.database.connect() as connection:
            watermark = connection.execute(
                "SELECT COALESCE(max(seq),0) FROM agent_notification_changes WHERE user_id=?",
                (actor.user_id,),
            ).fetchone()[0]
            floor_row = connection.execute(
                "SELECT expired_through FROM agent_inbox_state WHERE user_id=?", (actor.user_id,)
            ).fetchone()
            floor = floor_row[0] if floor_row else 0
            seq = 0
            if cursor is not None:
                try:
                    prefix, raw = cursor.split(":")
                    seq = int(raw)
                    if (
                        prefix != digest(actor.user_id)[:12]
                        or seq < 0
                        or seq > watermark
                        or seq < floor
                    ):
                        raise ValueError
                except (ValueError, TypeError):
                    raise HTTPException(410, "notification_cursor_expired") from None
            query = "SELECT n.*,e.kind AS event_type,e.title,e.summary,e.severity,e.task_id,e.draft_id,e.trace_id,e.counts FROM agent_notifications n JOIN agent_events e ON e.id=n.event_id WHERE n.user_id=?"
            if cursor is not None:
                query += " AND n.changed_seq>? ORDER BY n.changed_seq,n.id LIMIT ?"
                rows = connection.execute(query, (actor.user_id, seq, limit)).fetchall()
                end = rows[-1]["changed_seq"] if len(rows) == limit else watermark
            else:
                rows = connection.execute(
                    query + " ORDER BY n.created_at DESC,n.id DESC LIMIT ? OFFSET ?",
                    (actor.user_id, limit, offset),
                ).fetchall()
                end = watermark
            total = connection.execute(
                "SELECT count(*) FROM agent_notifications WHERE user_id=?", (actor.user_id,)
            ).fetchone()[0]
            unread = connection.execute(
                "SELECT count(*) FROM agent_notifications WHERE user_id=? AND read_at IS NULL",
                (actor.user_id,),
            ).fetchone()[0]
        items = []
        for row in rows:
            item = {
                key: row[key]
                for key in row.keys()
                if key not in {"user_id", "changed_seq", "counts"}
            }
            item["counts"] = json.loads(row["counts"])
            item["detail_route"] = (
                f"drafts/{row['draft_id']}"
                if row["draft_id"]
                else f"tasks/{row['task_id']}"
                if row["task_id"]
                else "notifications"
            )
            items.append(item)
        return {
            "items": items,
            "total": total,
            "limit": limit,
            "offset": offset,
            "next_cursor": f"{digest(actor.user_id)[:12]}:{end}",
            "unread_count": unread,
            "high_watermark": watermark,
        }

    def mark_read(self, actor, *, identities=None, high_watermark=None):
        with self.database.connect(write=True) as connection:
            connection.execute("BEGIN IMMEDIATE")
            if high_watermark is not None:
                rows = connection.execute(
                    "SELECT id FROM agent_notifications WHERE user_id=? AND read_at IS NULL AND changed_seq<=?",
                    (actor.user_id, high_watermark),
                ).fetchall()
            else:
                rows = connection.execute(
                    "SELECT id FROM agent_notifications WHERE user_id=? AND read_at IS NULL AND id IN (SELECT value FROM json_each(?))",
                    (actor.user_id, encoded(identities)),
                ).fetchall()
            for row in rows:
                connection.execute(
                    "UPDATE agent_notifications SET read_at=?,version=version+1 WHERE id=?",
                    (now(), row["id"]),
                )
                self.notification_changed(connection, row["id"], actor.user_id)
        return {"updated": len(rows)}

    def targets(self, actor):
        with self.database.connect() as connection:
            rows = connection.execute(
                "SELECT * FROM agent_telegram_targets WHERE user_id=? AND deleted_at IS NULL ORDER BY created_at DESC",
                (actor.user_id,),
            ).fetchall()
        return [self.target_public(row) for row in rows]

    @staticmethod
    def target_public(row):
        return {
            key: bool(row[key]) if key in {"enabled", "verified"} else row[key]
            for key in ("id", "name", "enabled", "verified", "version", "created_at", "proxy_mode")
        } | {"has_token": bool(row["secret_ref"])}

    def target(self, actor, identity):
        with self.database.connect() as connection:
            row = connection.execute(
                "SELECT * FROM agent_telegram_targets WHERE id=? AND user_id=? AND deleted_at IS NULL",
                (identity, actor.user_id),
            ).fetchone()
        if row is None:
            raise HTTPException(404, "telegram_target_not_found")
        return dict(row)

    def create_target(self, actor, body):
        if body.chat_id.startswith("-") and actor.role != "admin":
            raise HTTPException(403, "admin_required")
        identity = uuid4().hex
        secret_ref = self.put_secret(identity, body.bot_token.get_secret_value())
        with self.database.connect(write=True) as connection:
            connection.execute(
                "INSERT INTO agent_telegram_targets(id,user_id,name,chat_id,topic_id,secret_ref,proxy_mode,created_at) VALUES (?,?,?,?,?,?,?,?)",
                (
                    identity,
                    actor.user_id,
                    body.name,
                    body.chat_id,
                    body.topic_id,
                    secret_ref,
                    body.proxy_mode,
                    now(),
                ),
            )
        return self.target_public(self.target(actor, identity))

    def send_telegram(self, target, text):
        token = self.read_secret(target["secret_ref"])
        if not token:
            raise HTTPException(409, "telegram_token_unavailable")
        from wildstring.outbound import json_request

        payload = {
            "chat_id": target["chat_id"],
            "text": text[:4000],
            "disable_web_page_preview": True,
            "protect_content": True,
        }
        if target.get("topic_id"):
            payload["message_thread_id"] = target["topic_id"]
        mode, proxy = self.network_policy(target["proxy_mode"])
        response = (self.transport or json_request)(
            f"https://api.telegram.org/bot{token}/sendMessage",
            payload=payload,
            timeout=20,
            service="telegram",
            proxy_mode=mode,
            proxy_url=proxy,
            error_payload=True,
        )
        if not response.get("ok"):
            code = response.get("error_code")
            parameters = response.get("parameters") or {}
            if "migrate_to_chat_id" in parameters:
                raise TelegramFailure("telegram_chat_migrated", permanent=True)
            raise TelegramFailure(
                f"telegram_http_{code}" if isinstance(code, int) else "telegram_invalid_response",
                permanent=code in {400, 401, 403, 404},
                retry_after=parameters.get("retry_after"),
            )
        result = response.get("result")
        if not isinstance(result, dict) or not isinstance(result.get("message_id"), int):
            raise TelegramFailure("telegram_invalid_response", unknown=True)
        return str(result["message_id"])

    def verify_send(self, actor, identity):
        target = self.target(actor, identity)
        # Verification is purposefully explicit and rate-limited; no private result is included.
        if target["challenge_expires_at"] and target["challenge_expires_at"] > future(540):
            raise HTTPException(429, "telegram_verification_rate_limited")
        code = f"{secrets.randbelow(1000000):06d}"
        try:
            message_id = self.send_telegram(
                target, f"野弦目标验证：{code}\n10 分钟内在站内设置填写，勿转发验证码。"
            )
        except Exception as failure:
            raise HTTPException(
                502, getattr(failure, "code", "telegram_verification_send_failed")
            ) from None
        with self.database.connect(write=True) as connection:
            connection.execute(
                "UPDATE agent_telegram_targets SET challenge_hash=?,challenge_expires_at=?,challenge_attempts=0 WHERE id=? AND version=?",
                (digest(code), future(600), identity, target["version"]),
            )
        return {"ok": True, "message_id": message_id, "expires_in": 600}

    def verify_target(self, actor, identity, code):
        with self.database.connect(write=True) as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                "SELECT * FROM agent_telegram_targets WHERE id=? AND user_id=? AND deleted_at IS NULL",
                (identity, actor.user_id),
            ).fetchone()
            if row is None:
                raise HTTPException(404, "telegram_target_not_found")
            valid = (
                row["challenge_hash"]
                and row["challenge_expires_at"] > now()
                and row["challenge_attempts"] < 5
                and secrets.compare_digest(row["challenge_hash"], digest(code))
            )
            if valid:
                connection.execute(
                    "UPDATE agent_telegram_targets SET verified=1,enabled=1,challenge_hash=NULL,challenge_expires_at=NULL,version=version+1 WHERE id=?",
                    (identity,),
                )
            else:
                connection.execute(
                    "UPDATE agent_telegram_targets SET challenge_attempts=challenge_attempts+1 WHERE id=?",
                    (identity,),
                )
        if not valid:
            raise HTTPException(400, "telegram_verification_invalid")
        return self.target_public(self.target(actor, identity))

    def update_target(self, actor, identity, body):
        target = self.target(actor, identity)
        if target["version"] != body.version:
            raise HTTPException(409, "telegram_target_version_conflict")
        if body.enabled and not target["verified"]:
            raise HTTPException(409, "telegram_target_unverified")
        with self.database.connect(write=True) as connection:
            result = connection.execute(
                "UPDATE agent_telegram_targets SET enabled=?,version=version+1 WHERE id=? AND version=?",
                (body.enabled, identity, body.version),
            )
            if not result.rowcount:
                raise HTTPException(409, "telegram_target_version_conflict")
            connection.execute(
                "UPDATE agent_deliveries SET status='cancelled',error_code='target_changed' WHERE target_id=? AND status IN ('queued','retry_wait')",
                (identity,),
            )
        return self.target_public(self.target(actor, identity))

    def delete_target(self, actor, identity):
        target = self.target(actor, identity)
        with self.database.connect(write=True) as connection:
            connection.execute(
                "UPDATE agent_telegram_targets SET deleted_at=?,enabled=0,version=version+1 WHERE id=?",
                (now(), identity),
            )
            connection.execute(
                "UPDATE agent_deliveries SET status='cancelled',error_code='target_deleted' WHERE target_id=? AND status IN ('queued','retry_wait')",
                (identity,),
            )
        self.delete_secret(target["secret_ref"])
        return {"ok": True}

    def deliveries(self, actor, limit=50, offset=0):
        with self.database.connect() as connection:
            total = connection.execute(
                "SELECT count(*) FROM agent_deliveries d JOIN agent_telegram_targets t ON t.id=d.target_id WHERE t.user_id=?",
                (actor.user_id,),
            ).fetchone()[0]
            rows = connection.execute(
                "SELECT d.* FROM agent_deliveries d JOIN agent_telegram_targets t ON t.id=d.target_id WHERE t.user_id=? ORDER BY d.rowid DESC LIMIT ? OFFSET ?",
                (actor.user_id, limit, offset),
            ).fetchall()
        return {
            "items": [dict(row) for row in rows],
            "total": total,
            "limit": limit,
            "offset": offset,
        }

    def retry_delivery(self, actor, identity, acknowledge_unknown):
        with self.database.connect(write=True) as connection:
            row = connection.execute(
                "SELECT d.* FROM agent_deliveries d JOIN agent_telegram_targets t ON t.id=d.target_id WHERE d.id=? AND t.user_id=?",
                (identity, actor.user_id),
            ).fetchone()
            if row is None:
                raise HTTPException(404, "delivery_not_found")
            if row["status"] == "unknown" and not acknowledge_unknown:
                raise HTTPException(409, "delivery_outcome_unknown")
            if row["status"] not in {"failed", "unknown", "retry_wait"}:
                raise HTTPException(409, "delivery_not_retryable")
            connection.execute(
                "UPDATE agent_deliveries SET status='queued',next_attempt_at=?,error_code=NULL WHERE id=?",
                (now(), identity),
            )
        return {"ok": True}

    def deliver_one(self):
        with self.database.connect(write=True) as connection:
            connection.execute("BEGIN IMMEDIATE")
            # An expired send could already have reached Telegram. Never silently resend it.
            connection.execute(
                "UPDATE agent_deliveries SET status='unknown',error_code='send_interrupted',lease_until=NULL WHERE status='sending' AND lease_until<?",
                (now(),),
            )
            row = connection.execute(
                "SELECT d.*,t.user_id FROM agent_deliveries d JOIN agent_telegram_targets t ON t.id=d.target_id WHERE d.status IN ('queued','retry_wait') AND d.next_attempt_at<=? ORDER BY d.next_attempt_at,d.rowid LIMIT 1",
                (now(),),
            ).fetchone()
            if row is None:
                return False
            item = dict(row)
            target = connection.execute(
                "SELECT t.*,u.enabled AS account_enabled,u.role AS account_role FROM agent_telegram_targets t JOIN users u ON u.id=t.user_id WHERE t.id=?",
                (row["target_id"],),
            ).fetchone()
            prefrow = connection.execute(
                "SELECT value FROM agent_preferences WHERE user_id=?", (row["user_id"],)
            ).fetchone()
            pref = json.loads(prefrow[0]) if prefrow else {}
            if (
                not target
                or not target["verified"]
                or not target["enabled"]
                or not target["account_enabled"]
                or target["chat_id"].startswith("-")
                and target["account_role"] != "admin"
                or target["deleted_at"]
                or target["version"] != item["target_version"]
                or not pref.get("telegram_enabled")
            ):
                connection.execute(
                    "UPDATE agent_deliveries SET status='cancelled',error_code='delivery_authorization_changed' WHERE id=?",
                    (item["id"],),
                )
                return True
            if self.in_quiet_hours(pref):
                connection.execute(
                    "UPDATE agent_deliveries SET next_attempt_at=? WHERE id=?",
                    (future(300), item["id"]),
                )
                return True
            event = connection.execute(
                "SELECT * FROM agent_events WHERE id=?", (item["event_id"],)
            ).fetchone()
            if target["account_role"] != "admin" and event["kind"] in {
                "library.task.completed",
                "metadata.refresh.completed",
            }:
                connection.execute(
                    "UPDATE agent_deliveries SET status='cancelled',error_code='delivery_authorization_changed' WHERE id=?",
                    (item["id"],),
                )
                return True
            if (
                pref.get("event_types")
                and event["kind"] not in pref["event_types"]
                or SEVERITY[event["severity"]] < SEVERITY.get(pref.get("min_severity", "info"), 0)
            ):
                connection.execute(
                    "UPDATE agent_deliveries SET status='cancelled',error_code='subscription_changed' WHERE id=?",
                    (item["id"],),
                )
                return True
            connection.execute(
                "UPDATE agent_deliveries SET status='sending',attempt=attempt+1,lease_until=? WHERE id=?",
                (future(60), item["id"]),
            )
            text = f"野弦 · {event['title']}\n{event['summary']}\n诊断编号：{event['trace_id']}"
            if event["task_id"]:
                text += f"\n任务：{event['task_id']}"
            if event["draft_id"]:
                text += f"\n草案：{event['draft_id']}（请在站内查看并确认）"
            public_url = connection.execute(
                "SELECT public_url FROM provider_settings WHERE id=1"
            ).fetchone()[0]
            detail_url = self.public_detail_url(public_url, event["draft_id"], event["task_id"])
            if detail_url:
                text += "\n详情：" + detail_url
        status, error, message_id, retry = "sent", None, None, None
        try:
            from wildstring.diagnostics import trace_context

            with trace_context(item["trace_id"], user_id=item["user_id"], sink=self.diagnostics):
                message_id = self.send_telegram(dict(target), text)
        except TelegramFailure as failure:
            error = failure.code
            status = (
                "unknown"
                if failure.unknown
                else "failed"
                if failure.permanent or item["attempt"] >= 4
                else "retry_wait"
            )
            retry = failure.retry_after
        except HTTPException as failure:
            error = failure.detail
            status = "failed"
        except Exception as failure:
            # Never include exception strings: Telegram tokens are URL path components.
            error = getattr(failure, "code", "telegram_network_unknown")
            http_status = getattr(failure, "http_status", None)
            status = (
                "retry_wait"
                if http_status == 429 or http_status is not None and http_status >= 500
                else "failed"
                if http_status in {400, 401, 403, 404}
                else "unknown"
            )
            retry = getattr(failure, "retry_after", None)
        if status == "retry_wait" and item["attempt"] >= 4:
            status = "failed"
        delay = (
            min(86400, max(1, int(retry)))
            if isinstance(retry, (int, float))
            else min(3600, 30 * 2 ** item["attempt"])
        )
        with self.database.connect(write=True) as connection:
            connection.execute(
                "UPDATE agent_deliveries SET status=?,error_code=?,message_id=?,next_attempt_at=?,lease_until=NULL WHERE id=? AND status='sending'",
                (status, error, message_id, future(delay), item["id"]),
            )
        self.log(
            "notification.delivery", status=status, error_code=error, trace_id=item["trace_id"]
        )
        return True

    @staticmethod
    def public_detail_url(base, draft_id=None, task_id=None):
        import ipaddress
        from urllib.parse import urlsplit

        try:
            parts = urlsplit(base)
            host = parts.hostname or ""
            if (
                parts.scheme != "https"
                or not host
                or parts.username
                or parts.password
                or parts.query
                or parts.fragment
                or host in {"localhost", "localhost.localdomain"}
                or host.endswith((".localhost", ".local"))
            ):
                return None
            try:
                if not ipaddress.ip_address(host).is_global:
                    return None
            except ValueError:
                if "." not in host:
                    return None
            suffix = (
                f"drafts/{draft_id}"
                if draft_id
                else f"tasks/{task_id}"
                if task_id
                else "notifications"
            )
            return base.rstrip("/") + "/#agent/" + suffix
        except ValueError:
            return None

    @staticmethod
    def in_quiet_hours(preferences):
        start, end = preferences.get("quiet_start"), preferences.get("quiet_end")
        if not start or not end or start == end:
            return False
        local = datetime.now(ZoneInfo(preferences.get("timezone", "UTC"))).strftime("%H:%M")
        return start <= local < end if start < end else local >= start or local < end

    def cleanup_notifications(self):
        cutoff = (datetime.now(UTC) - timedelta(days=30)).isoformat()
        with self.database.connect(write=True) as connection:
            # Pending proposals and unresolved failure notifications are retained.
            rows = connection.execute(
                "SELECT n.id,n.user_id FROM agent_notifications n JOIN agent_events e ON e.id=n.event_id LEFT JOIN agent_drafts d ON d.id=e.draft_id LEFT JOIN agent_tasks t ON t.id=e.task_id WHERE n.created_at<? AND (d.id IS NULL OR d.status IN ('applied','rejected')) AND (e.severity='info' OR t.status IN ('succeeded','cancelled'))",
                (cutoff,),
            ).fetchall()
            connection.executemany(
                "DELETE FROM agent_notifications WHERE id=?", [(row["id"],) for row in rows]
            )
            for row in rows:
                connection.execute(
                    "DELETE FROM agent_notification_changes WHERE notification_id=?", (row["id"],)
                )
            for user_id in {row["user_id"] for row in rows}:
                # A retention boundary advances the cursor even when the inbox is now empty.
                # Every older client must reload, so locally cached expired items disappear.
                boundary = connection.execute(
                    "INSERT INTO agent_notification_changes(notification_id,user_id) VALUES (?,?)",
                    ("retention-" + uuid4().hex, user_id),
                ).lastrowid
                connection.execute(
                    "INSERT INTO agent_inbox_state(user_id,expired_through) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET expired_through=excluded.expired_through",
                    (user_id, boundary),
                )


class TelegramFailure(Exception):
    def __init__(self, code, *, permanent=False, unknown=False, retry_after=None):
        self.code, self.permanent, self.unknown, self.retry_after = (
            code,
            permanent,
            unknown,
            retry_after,
        )
        super().__init__(code)
