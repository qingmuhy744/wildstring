"""User-owned application policy; tool credentials cannot grant themselves approval."""

import json

from fastapi import HTTPException

from wildstring.agent_common import encoded
from wildstring.agent_models import Apply, NotificationPreferences
from wildstring.library.repository import now
from wildstring.permissions import profile_for

KINDS = ("playlist", "metadata", "metadata_batch", "cover", "lyrics", "intake")


class Application:
    def application_policy(self, actor, connection=None):
        if connection is None:
            with self.database.connect() as connection:
                return self.application_policy(actor, connection)
        row = connection.execute(
            "SELECT value FROM agent_preferences WHERE user_id=?", (actor.user_id,)
        ).fetchone()
        saved = json.loads(row[0]).get("application_policy", {}) if row else {}
        allowed = list(KINDS) if actor.profile == "owner" else ["playlist"]
        return {
            "mode": saved.get("mode", "manual"),
            "kinds": [kind for kind in saved.get("kinds", allowed) if kind in allowed],
            "version": saved.get("version", 1),
            "allowed_kinds": allowed,
        }

    def save_application_policy(self, actor, body):
        # Only a cookie-authenticated settings route may call this method.
        if actor.credential_id:
            raise HTTPException(403, "application_policy_session_required")
        actor = self.refresh_actor(actor)
        with self.database.connect(write=True) as connection:
            connection.execute("BEGIN IMMEDIATE")
            current = self.application_policy(actor, connection)
            if body.version != current["version"]:
                raise HTTPException(409, "application_policy_version_conflict")
            if set(body.kinds) - set(current["allowed_kinds"]):
                raise HTTPException(403, "admin_required")
            row = connection.execute(
                "SELECT value FROM agent_preferences WHERE user_id=?", (actor.user_id,)
            ).fetchone()
            preferences = json.loads(row[0]) if row else NotificationPreferences().model_dump()
            preferences["application_policy"] = body.model_dump() | {"version": body.version + 1}
            connection.execute(
                "INSERT INTO agent_preferences VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET value=excluded.value",
                (actor.user_id, encoded(preferences)),
            )
            self.emit(
                connection,
                actor.user_id,
                "application.policy_changed",
                f"application-policy:{actor.user_id}:{body.version + 1}",
                "整理方式已更新",
                "自动应用" if body.mode == "automatic" else "审核后应用",
            )
        return self.application_policy(actor)

    def check_application_actor(self, actor, connection):
        user = connection.execute(
            "SELECT version,profile FROM users WHERE id=? AND enabled=1 AND password_hash IS NOT NULL",
            (actor.user_id,),
        ).fetchone()
        if user is None or user["version"] != actor.version or profile_for(user) != actor.profile:
            raise HTTPException(403, "agent_authorization_changed")
        if actor.credential_id:
            credential = connection.execute(
                "SELECT scopes FROM agent_credentials WHERE id=? AND user_id=? AND revoked_at IS NULL AND expires_at>?",
                (actor.credential_id, actor.user_id, now()),
            ).fetchone()
            if credential is None or not actor.scopes.issubset(json.loads(credential[0])):
                raise HTTPException(403, "agent_authorization_revoked")

    def automatic_application_allowed(self, actor, record, connection):
        policy = self.application_policy(actor, connection)
        return (
            "drafts:apply" in actor.scopes
            and policy["mode"] == "automatic"
            and record["kind"] in policy["kinds"]
        )

    def maybe_apply_created_draft(self, actor, identity):
        record = self.draft(actor, identity)
        with self.database.connect() as connection:
            allowed = self.automatic_application_allowed(actor, record, connection)
        if allowed:
            try:
                return self.apply_draft(
                    actor,
                    identity,
                    Apply(
                        version=record["version"],
                        idempotency_key=f"auto:{identity}:{record['version']}",
                    ),
                )
            except HTTPException as failure:
                # Creation succeeded; retain a reviewable proposal when versions, scope or policy changed.
                with self.database.connect(write=True) as connection:
                    connection.execute(
                        "UPDATE agent_drafts SET result=?,updated_at=? WHERE id=? AND status='pending'",
                        (encoded({"automatic_error": failure.detail}), now(), identity),
                    )
        return self.draft(actor, identity)

    def accept_draft(self, actor, identity, body):
        if actor.credential_id:
            raise HTTPException(403, "draft_accept_session_required")
        return self.apply_draft(actor, identity, body, accept=True)
