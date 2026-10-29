"""Permission-checked tools shared by the UI, MCP bridge and bounded model loops."""

import json
import secrets
import sqlite3
from uuid import uuid4

from fastapi import HTTPException

from wildstring.agent_ai import Assistant
from wildstring.agent_application import Application
from wildstring.agent_automation import Automation
from wildstring.agent_common import (
    LIBRARY_TARGET_REQUIRED,
    TOOLS,
    Actor,
    digest,
    encoded,
    future,
    tool_definitions,
    validate,
)
from wildstring.agent_diagnostics import DEFINITIONS as DIAGNOSTIC_TOOLS
from wildstring.agent_diagnostics import execute as execute_diagnostic
from wildstring.agent_models import SCOPES, DraftCreate, PlaylistPayload
from wildstring.agent_music_models import ADMIN_TOOLS, NETWORK_TOOLS
from wildstring.agent_music_models import DEFINITIONS as MUSIC_TOOLS
from wildstring.agent_notifications import Notifications
from wildstring.agent_research import Research
from wildstring.agent_review import Review
from wildstring.library.edits import MetadataEditor, MetadataUpdate
from wildstring.library.playlists import PlaylistStore
from wildstring.library.repository import now
from wildstring.permissions import profile_for, scopes_for


class Core:
    @staticmethod
    def tool_catalog(actor):
        return [
            {
                "name": tool["name"],
                "description": tool["description"],
                "inputSchema": tool["input_schema"],
                "annotations": {
                    "readOnlyHint": tool["read_only"],
                    "destructiveHint": False,
                    "idempotentHint": tool["read_only"] or tool["name"] == "apply_draft",
                    "openWorldHint": tool["name"]
                    in NETWORK_TOOLS
                    | {
                        "request_metadata_refresh",
                        "test_external_services",
                        "submit_inspection",
                        "create_draft",
                    },
                },
            }
            for tool in tool_definitions()
            if tool["scope"] in actor.scopes
            and (
                actor.profile == "owner"
                or tool["name"]
                not in ADMIN_TOOLS | {"get_metadata_suggestions", "request_metadata_refresh"}
                and tool["scope"] != "diagnostics:read"
            )
            and (tool["scope"] != "web:search" or "library:read" in actor.scopes)
        ]

    def actor(self, request, *, session_only=False):
        authorization = request.headers.get("authorization", "")
        if authorization and not session_only:
            if not authorization.startswith("Bearer ws_") or len(authorization) > 256:
                raise HTTPException(401, "agent_credential_invalid")
            with self.database.connect() as connection:
                row = connection.execute(
                    "SELECT c.*,u.profile,u.version AS auth_version FROM agent_credentials c JOIN users u ON u.id=c.user_id WHERE c.token_hash=? AND c.revoked_at IS NULL AND c.expires_at>? AND u.enabled=1 AND u.password_hash IS NOT NULL",
                    (digest(authorization[7:]), now()),
                ).fetchone()
            if row is None:
                raise HTTPException(401, "agent_credential_invalid")
            return Actor(
                row["user_id"],
                row["auth_version"],
                frozenset(json.loads(row["scopes"])).intersection(scopes_for(row)),
                row["id"],
                profile=row["profile"],
            )
        user = self.auth.require_session(request)
        return self.current_actor(user["id"])

    def current_actor(self, user_id, *, scopes=None, credential_id=None):
        with self.database.connect() as connection:
            row = connection.execute(
                "SELECT * FROM users WHERE id=? AND enabled=1 AND password_hash IS NOT NULL",
                (user_id,),
            ).fetchone()
        if row is None:
            raise HTTPException(403, "agent_authorization_revoked")
        return Actor(
            user_id,
            row["version"],
            frozenset(SCOPES if scopes is None else scopes).intersection(scopes_for(row)),
            credential_id,
            profile=profile_for(row),
        )

    def refresh_actor(self, actor):
        current = self.current_actor(
            actor.user_id, scopes=actor.scopes, credential_id=actor.credential_id
        )
        if actor.credential_id:
            with self.database.connect() as connection:
                row = connection.execute(
                    "SELECT scopes FROM agent_credentials WHERE id=? AND user_id=? AND revoked_at IS NULL AND expires_at>?",
                    (actor.credential_id, actor.user_id, now()),
                ).fetchone()
            if row is None:
                raise HTTPException(403, "agent_authorization_revoked")
            current = self.current_actor(
                actor.user_id,
                scopes=actor.scopes.intersection(json.loads(row["scopes"])),
                credential_id=actor.credential_id,
            )
        return current

    def repository_for(self, actor):
        return self.repository.for_user(actor.user_id)

    def log(self, event, actor=None, **fields):
        if "status" in fields:
            fields["stage"] = fields.pop("status")
        if "tool" in fields:
            fields["operation"] = fields.pop("tool")
        if "error_code" in fields:
            fields["code"] = fields.pop("error_code")
        if self.diagnostics is not None:
            from wildstring.diagnostics import record_event

            record_event(
                event,
                sink=self.diagnostics,
                **({"user_id": actor.user_id} if actor else {}),
                **fields,
            )

    def credentials(self, actor):
        with self.database.connect() as connection:
            rows = connection.execute(
                "SELECT * FROM agent_credentials WHERE user_id=? ORDER BY created_at DESC",
                (actor.user_id,),
            ).fetchall()
        return [self.credential_public(row) for row in rows]

    @staticmethod
    def credential_public(row):
        return {
            key: json.loads(row[key]) if key == "scopes" else row[key]
            for key in ("id", "name", "scopes", "created_at", "expires_at", "revoked_at", "version")
        }

    def create_credential(self, actor, body):
        if {"diagnostics:read", "library:manage"}.intersection(
            body.scopes
        ) and actor.profile != "owner":
            raise HTTPException(403, "admin_required")
        identity, token = uuid4().hex, "ws_" + secrets.token_urlsafe(32)
        with self.database.connect(write=True) as connection:
            connection.execute(
                "INSERT INTO agent_credentials(id,user_id,name,token_hash,scopes,created_at,expires_at) VALUES (?,?,?,?,?,?,?)",
                (
                    identity,
                    actor.user_id,
                    body.name,
                    digest(token),
                    encoded(body.scopes),
                    now(),
                    future(body.expires_in_days * 86400),
                ),
            )
            row = connection.execute(
                "SELECT * FROM agent_credentials WHERE id=?", (identity,)
            ).fetchone()
        return self.credential_public(row) | {"token": token}

    def revoke_credential(self, actor, identity):
        with self.database.connect(write=True) as connection:
            result = connection.execute(
                "UPDATE agent_credentials SET revoked_at=?,version=version+1 WHERE id=? AND user_id=?",
                (now(), identity, actor.user_id),
            )
            if not result.rowcount:
                raise HTTPException(404, "agent_credential_not_found")
        return {"ok": True}

    @staticmethod
    def projection(track):
        keys = (
            "id",
            "title",
            "artists",
            "album",
            "album_id",
            "album_artists",
            "track_number",
            "disc_number",
            "duration_ms",
            "format",
            "has_cover",
            "loved",
            "play_count",
            "listened_ms",
            "last_played_at",
        )
        return {key: track[key] for key in keys if key in track}

    def get_track(self, actor, identity):
        actor.require("library:read")
        repository = self.repository_for(actor)
        track = repository.track(identity)
        if track is None:
            raise HTTPException(404, "track_not_found")
        result = self.projection(track)
        metadata = MetadataEditor(repository).read(identity)
        result["metadata_version"] = metadata["version"]
        result["metadata"] = {
            key: metadata[key] for key in ("observed", "overrides", "effective", "origins")
        }
        result["has_lyrics"] = self.lyrics_present(identity)
        return result

    def lyrics_present(self, identity):
        # Read using the existing bounded resolver so embedded and sidecar lyrics count.
        from wildstring.library.assets import TrackAssets

        try:
            result = TrackAssets(self.repository).lyrics(identity)
            return result.get("kind") != "none"
        except HTTPException:
            return False

    def inspect(
        self, actor, identities=None, limit=100, *, offset=0, album_id=None, rules=None, index=None
    ):
        from wildstring.library.inspection import RULES, InspectionIndex

        actor.require("library:read")
        if rules is not None and (not isinstance(rules, list) or set(rules) - RULES.keys()):
            raise HTTPException(422, "agent_invalid_input")
        repository = self.repository_for(actor)
        if identities is None:
            page = repository.tracks(limit=limit, offset=offset, album_id=album_id)
            identities = [track["id"] for track in page["items"]]
            total = page["total"]
        else:
            if (
                not isinstance(identities, list)
                or len(identities) > 5000
                or len(set(identities)) != len(identities)
            ):
                raise HTTPException(422, "inspection_limit")
            total = len(identities)
            identities = identities[offset : offset + limit]
        if not 1 <= limit <= 5000:
            raise HTTPException(422, "inspection_limit")
        index = index or InspectionIndex(repository)
        results = []
        for identity in identities:
            track = self.get_track(actor, identity)
            if album_id is not None and track.get("album_id") != album_id:
                raise HTTPException(422, "inspection_album_mismatch")
            findings = index.findings(track, track["has_lyrics"])
            if rules is not None:
                findings = [finding for finding in findings if finding["code"] in rules]
            results.append(
                {
                    "track_id": identity,
                    "title": track["title"],
                    "metadata_version": track["metadata_version"],
                    "issues": [finding["code"] for finding in findings],
                    "findings": findings,
                }
            )
        return {
            "items": results,
            "total": total,
            "limit": limit,
            "offset": offset,
            "has_more": offset + len(results) < total,
            "grouping_complete": not index.truncated,
            "note": "结构与缺失检查仅供核对；纯音乐无歌词可能正常，同名歌曲不代表重复音频。",
        }

    def check_draft_payload(self, actor, kind, payload):
        repository = self.repository_for(actor)
        if kind in {"cover", "metadata_batch"}:
            from wildstring.agent_curation import check

            return check(self, actor, kind, payload)
        if kind in {"intake", "lyrics"}:
            from wildstring.agent_music_drafts import check

            return check(self, actor, kind, payload)
        if kind == "playlist":
            body = validate(PlaylistPayload, payload)
            if len(body.track_ids) != len(set(body.track_ids)):
                raise HTTPException(422, "duplicate_track_id")
            with self.database.connect() as connection:
                for identity in body.track_ids:
                    if (
                        not isinstance(identity, str)
                        or connection.execute(
                            "SELECT 1 FROM tracks WHERE id=? AND library_visible(library_id) AND status='available'",
                            (identity,),
                        ).fetchone()
                        is None
                    ):
                        raise HTTPException(404, "track_not_found")
            before = {}
            if body.playlist_id:
                store = PlaylistStore(repository)
                record = store.get(body.playlist_id)
                if record["kind"] != "manual":
                    raise HTTPException(409, "playlist_kind_immutable")
                if body.playlist_version != record["version"]:
                    raise HTTPException(409, "playlist_version_conflict")
                before = {
                    "name": record["name"],
                    "track_ids": [
                        track["id"] for track in store.tracks(body.playlist_id, limit=5000)["items"]
                    ],
                }
            return body.model_dump(exclude_none=True), before
        actor.require("drafts:write", admin=True)
        if set(payload) != {"track_id", "metadata_version", "overrides"}:
            raise HTTPException(422, "agent_invalid_input")
        body = validate(
            MetadataUpdate,
            {"version": payload["metadata_version"], "overrides": payload["overrides"]},
        )
        record = MetadataEditor(repository).read(payload["track_id"])
        if record["version"] != body.version:
            raise HTTPException(409, "metadata_version_conflict")
        from wildstring.album_release_locks import ALBUM_FIELDS
        from wildstring.album_release_locks import read as read_release_lock

        with self.database.connect() as connection:
            row = connection.execute(
                "SELECT album_id FROM tracks WHERE id=? AND library_id=?",
                (payload["track_id"], self.library_id),
            ).fetchone()
            if row and read_release_lock(connection, self.library_id, row["album_id"]):
                if ALBUM_FIELDS.intersection(body.overrides.model_fields_set):
                    raise HTTPException(409, "album_release_lock_requires_source")
        return {
            "track_id": payload["track_id"],
            "metadata_version": body.version,
            "overrides": body.overrides.model_dump(exclude_unset=True),
        }, record["effective"]

    def create_draft(
        self,
        actor,
        body,
        trace_id=None,
        *,
        auto_apply=True,
        application_key=None,
        notify_pending=True,
    ):
        actor.require("drafts:write")
        if body.kind == "cover" and set(body.payload) - {
            "suggestion_id",
            "metadata_version",
            "targets",
        }:
            raise HTTPException(422, "cover_snapshot_server_owned")
        if body.kind == "metadata_batch" and "cover_snapshot" in body.payload:
            raise HTTPException(422, "cover_snapshot_server_owned")
        payload, before = self.check_draft_payload(actor, body.kind, body.payload)
        from wildstring.diagnostics import trace_id as current_trace

        identity, trace_id = uuid4().hex, trace_id or current_trace()
        library_id = self.library_id
        with self.database.connect(write=True) as connection:
            connection.execute("BEGIN IMMEDIATE")
            connection.execute(
                "INSERT INTO agent_drafts(id,user_id,library_id,kind,title,payload,evidence,before_values,created_at,updated_at,trace_id,idempotency_key) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    identity,
                    actor.user_id,
                    library_id,
                    body.kind,
                    body.title,
                    encoded(payload),
                    encoded([e.model_dump() for e in body.evidence]),
                    encoded(before),
                    now(),
                    now(),
                    trace_id,
                    application_key,
                ),
            )
        result = (
            self.maybe_apply_created_draft(actor, identity)
            if auto_apply
            else self.draft(actor, identity)
        )
        if result["status"] == "pending" and notify_pending:
            with self.database.connect(write=True) as connection:
                connection.execute("BEGIN IMMEDIATE")
                if self.draft(actor, identity, connection)["status"] == "pending":
                    self.emit(
                        connection,
                        actor.user_id,
                        "draft.pending",
                        f"draft:{identity}:1",
                        "草案待确认",
                        body.title,
                        draft_id=identity,
                        trace_id=trace_id,
                    )
        return result

    def draft(self, actor, identity, connection=None):
        if connection is None:
            with self.database.connect() as connection:
                return self.draft(actor, identity, connection)
        row = connection.execute(
            "SELECT * FROM agent_drafts WHERE id=? AND user_id=? AND library_id=?",
            (identity, actor.user_id, self.library_id),
        ).fetchone()
        if row is None:
            raise HTTPException(404, "draft_not_found")
        result = {
            key: row[key]
            for key in row.keys()
            if key
            not in {"user_id", "library_id", "approved_by", "before_values", "idempotency_key"}
        }
        for key in ("payload", "evidence", "result"):
            result[key] = json.loads(result[key]) if result[key] else None
        result["before"] = json.loads(row["before_values"])
        if result["kind"] in {"cover", "metadata_batch"}:
            result["preview_digest"] = digest(encoded(result["payload"]))
        return result

    def drafts(self, actor, limit=50, offset=0, status=None):
        with self.database.connect() as connection:
            rows = connection.execute(
                "SELECT id FROM agent_drafts WHERE user_id=? AND library_visible(library_id) AND (? IS NULL OR status=?) ORDER BY CASE WHEN status IN ('pending','approved') THEN 0 ELSE 1 END,updated_at DESC,id DESC LIMIT ? OFFSET ?",
                (actor.user_id, status, status, limit, offset),
            ).fetchall()
            total = connection.execute(
                "SELECT count(*) FROM agent_drafts WHERE user_id=? AND library_visible(library_id) AND (? IS NULL OR status=?)",
                (actor.user_id, status, status),
            ).fetchone()[0]
            items = [self.draft(actor, row["id"], connection) for row in rows]
        return {"items": items, "total": total, "limit": limit, "offset": offset}

    def patch_draft(self, actor, identity, body):
        actor.require("drafts:write")
        existing = self.draft(actor, identity)
        if (
            existing["kind"] == "cover"
            and body.payload is not None
            and set(body.payload) - {"suggestion_id", "metadata_version", "targets"}
            and body.payload != existing["payload"]
        ):
            raise HTTPException(422, "cover_snapshot_server_owned")
        if (
            existing["kind"] == "metadata_batch"
            and body.payload is not None
            and "cover_snapshot" in body.payload
            and body.payload != existing["payload"]
        ):
            raise HTTPException(422, "cover_snapshot_server_owned")
        payload, before = self.check_draft_payload(
            actor,
            existing["kind"],
            body.payload if body.payload is not None else existing["payload"],
        )
        with self.database.connect(write=True) as connection:
            connection.execute("BEGIN IMMEDIATE")
            existing = self.draft(actor, identity, connection)
            if existing["status"] == "applied" or existing["version"] != body.version:
                raise HTTPException(409, "draft_version_conflict")
            connection.execute(
                "UPDATE agent_drafts SET payload=?,before_values=?,title=?,evidence=?,version=version+1,status='pending',approved_version=NULL,approved_by=NULL,result=NULL,updated_at=? WHERE id=?",
                (
                    encoded(payload),
                    encoded(before),
                    body.title if body.title is not None else existing["title"],
                    encoded([e.model_dump() for e in body.evidence])
                    if body.evidence is not None
                    else encoded(existing["evidence"]),
                    now(),
                    identity,
                ),
            )
        return self.draft(actor, identity)

    def approve_draft(self, actor, identity, version, *, reject=False, preview_digest=None):
        actor.require("drafts:write")
        with self.database.connect(write=True) as connection:
            connection.execute("BEGIN IMMEDIATE")
            record = self.draft(actor, identity, connection)
            if record["kind"] != "playlist" and actor.profile != "owner":
                raise HTTPException(403, "admin_required")
            if (
                not reject
                and record["kind"] in {"cover", "metadata_batch"}
                and preview_digest != record["preview_digest"]
            ):
                raise HTTPException(409, "draft_preview_required")
            if record["version"] != version or record["status"] == "applied":
                raise HTTPException(409, "draft_version_conflict")
            connection.execute(
                "UPDATE agent_drafts SET status=?,approved_version=?,approved_by=?,updated_at=? WHERE id=?",
                (
                    "rejected" if reject else "approved",
                    None if reject else version,
                    None if reject else actor.user_id,
                    now(),
                    identity,
                ),
            )
        return self.draft(actor, identity)

    def apply_draft(self, actor, identity, body, *, accept=False):
        actor = self.refresh_actor(actor)
        actor.require("drafts:apply")
        try:
            with self.database.connect(write=True) as connection:
                connection.execute("BEGIN IMMEDIATE")
                self.check_application_actor(actor, connection)
                record = self.draft(actor, identity, connection)
                if record["kind"] != "playlist" and actor.profile != "owner":
                    raise HTTPException(403, "admin_required")
                raw = connection.execute(
                    "SELECT * FROM agent_drafts WHERE id=?", (identity,)
                ).fetchone()
                if body.version != record["version"]:
                    raise HTTPException(409, "draft_version_conflict")
                if record["status"] == "applied":
                    if raw["idempotency_key"] != body.idempotency_key:
                        raise HTTPException(409, "draft_already_applied")
                    return record
                automatic = not accept and self.automatic_application_allowed(
                    actor, record, connection
                )
                if accept or automatic:
                    if record["status"] not in {"pending", "approved"}:
                        raise HTTPException(409, "draft_approval_required")
                    if (
                        accept
                        and record["kind"] in {"cover", "metadata_batch"}
                        and body.preview_digest != record["preview_digest"]
                    ):
                        raise HTTPException(409, "draft_preview_required")
                    connection.execute(
                        "UPDATE agent_drafts SET status='approved',approved_version=?,approved_by=? WHERE id=?",
                        (record["version"], actor.user_id, identity),
                    )
                elif (
                    record["status"] != "approved"
                    or record["approved_version"] != record["version"]
                ):
                    raise HTTPException(409, "draft_approval_required")
                payload = record["payload"]
                if record["kind"] == "playlist":
                    result = self.apply_playlist(connection, actor, payload)
                elif record["kind"] in {"cover", "metadata_batch"}:
                    from wildstring.agent_curation import apply

                    result = apply(self, actor, connection, record["kind"], payload)
                elif record["kind"] in {"intake", "lyrics"}:
                    from wildstring.agent_music_drafts import apply

                    result = apply(self, actor, connection, record["kind"], payload)
                else:
                    existing = connection.execute(
                        "SELECT overrides FROM track_metadata WHERE track_id=?",
                        (payload["track_id"],),
                    ).fetchone()
                    if existing is None:
                        raise HTTPException(404, "track_not_found")
                    changes = json.loads(existing["overrides"]) | payload["overrides"]
                    update = validate(
                        MetadataUpdate,
                        {"version": payload["metadata_version"], "overrides": changes},
                    )
                    MetadataEditor(self.repository_for(actor)).save_in_transaction(
                        connection,
                        payload["track_id"],
                        update,
                        user_id=actor.user_id,
                        source="agent_draft",
                    )
                    result = {
                        "track_id": payload["track_id"],
                        "metadata_version": update.version + 1,
                    }
                result["application_mode"] = "automatic" if automatic else "manual"
                if automatic:
                    result["policy_version"] = self.application_policy(actor, connection)["version"]
                object_ids = result.get("track_ids") or [
                    result.get("playlist_id", result.get("track_id", result.get("item_id")))
                ]
                for object_id in object_ids:
                    connection.execute(
                        "INSERT INTO agent_audit VALUES (?,?,?,?,?,?,?)",
                        (
                            uuid4().hex,
                            actor.user_id,
                            identity,
                            "apply",
                            object_id,
                            record["trace_id"],
                            now(),
                        ),
                    )
                connection.execute(
                    "UPDATE agent_drafts SET status='applied',result=?,idempotency_key=?,updated_at=? WHERE id=?",
                    (encoded(result), body.idempotency_key, now(), identity),
                )
                self.emit(
                    connection,
                    actor.user_id,
                    "draft.applied",
                    f"apply:{identity}",
                    "草案已应用",
                    record["title"],
                    draft_id=identity,
                    trace_id=record["trace_id"],
                )
        except sqlite3.IntegrityError:
            raise HTTPException(409, "agent_idempotency_conflict") from None
        return self.draft(actor, identity)

    def apply_playlist(self, connection, actor, payload):
        body = validate(PlaylistPayload, payload)
        identity = body.playlist_id or uuid4().hex
        store = PlaylistStore(self.repository_for(actor))
        track_ids = body.track_ids
        if body.playlist_id:
            record = store._record(connection, identity, body.playlist_version, editable=True)
            if record["kind"] != "manual":
                raise HTTPException(409, "smart_playlist_tracks_readonly")
            old = connection.execute(
                "SELECT p.track_id,library_visible(t.library_id) AND t.status='available' AS visible "
                "FROM playlist_tracks p JOIN tracks t ON t.id=p.track_id "
                "WHERE p.playlist_id=? ORDER BY p.position",
                (identity,),
            ).fetchall()
            replacements = iter(body.track_ids)
            track_ids = [row[0] if not row[1] else next(replacements, None) for row in old]
            track_ids = [track for track in track_ids if track is not None] + list(replacements)
        for track_id in body.track_ids:
            if (
                connection.execute(
                    "SELECT 1 FROM tracks WHERE id=? AND library_visible(library_id) AND status='available'",
                    (track_id,),
                ).fetchone()
                is None
            ):
                raise HTTPException(404, "track_not_found")
        if body.playlist_id:
            connection.execute(
                "UPDATE playlists SET name=?,version=version+1,updated_at=? WHERE id=?",
                (body.name, now(), identity),
            )
            connection.execute("DELETE FROM playlist_tracks WHERE playlist_id=?", (identity,))
        else:
            connection.execute(
                "INSERT INTO playlists(id,library_id,name,kind,created_at,updated_at,user_id) VALUES (?,?,?,'manual',?,?,?)",
                (
                    identity,
                    store.library.default_library_id(),
                    body.name,
                    now(),
                    now(),
                    actor.user_id,
                ),
            )
        connection.executemany(
            "INSERT INTO playlist_tracks VALUES (?,?,?)",
            [(identity, track_id, index) for index, track_id in enumerate(track_ids)],
        )
        return {"playlist_id": identity}

    def execute_tool(self, actor, name, arguments):
        actor = self.refresh_actor(actor)
        from wildstring.library.scope import actor_library_scope

        if not isinstance(arguments, dict) or len(encoded(arguments).encode()) > 100000:
            raise HTTPException(422, "agent_invalid_input")
        scoped_arguments = dict(arguments)
        library_id = scoped_arguments.pop("library_id", None)
        if library_id is not None and (
            not isinstance(library_id, str) or not 1 <= len(library_id) <= 128
        ):
            raise HTTPException(422, "agent_invalid_input")
        with actor_library_scope(
            self.database,
            actor,
            scoped_arguments,
            library_id=library_id,
            require_selection=name in LIBRARY_TARGET_REQUIRED,
        ):
            return self.execute_scoped_tool(actor, name, scoped_arguments)

    def execute_scoped_tool(self, actor, name, arguments):
        if name in MUSIC_TOOLS:
            from wildstring.agent_music_tools import execute

            if not isinstance(arguments, dict) or len(encoded(arguments).encode()) > 100000:
                raise HTTPException(422, "agent_invalid_input")
            return execute(self, actor, name, arguments)
        if name not in TOOLS:
            raise HTTPException(404, "agent_tool_not_found")
        _, scope, _, properties = TOOLS[name]
        actor.require(scope)
        if (
            not isinstance(arguments, dict)
            or set(arguments) - set(properties)
            or len(encoded(arguments).encode()) > 100000
        ):
            raise HTTPException(422, "agent_invalid_input")
        required = next(
            item["input_schema"]["required"] for item in tool_definitions() if item["name"] == name
        )
        if set(required) - set(arguments):
            raise HTTPException(422, "agent_invalid_input")
        for key, value in arguments.items():
            expected = properties[key]
            valid_type = (
                (isinstance(value, str) and len(value) <= 2048)
                if expected == "string"
                else (isinstance(value, int) and not isinstance(value, bool))
                if expected == "integer"
                else isinstance(value, bool)
                if expected == "boolean"
                else (isinstance(value, list) and len(value) <= 5000)
                if expected == "array"
                else isinstance(value, dict)
                if expected == "object"
                else False
            )
            if not valid_type:
                raise HTTPException(422, "agent_invalid_input")
        repository = self.repository_for(actor)
        limit = arguments.get("limit", 50)
        offset = arguments.get("offset", 0)
        if (
            not isinstance(limit, int)
            or isinstance(limit, bool)
            or not 1 <= limit <= 100
            or not isinstance(offset, int)
            or isinstance(offset, bool)
            or not 0 <= offset <= 1000000
        ):
            raise HTTPException(422, "agent_invalid_input")
        if name == "request_metadata_refresh":
            actor.require("library:read", admin=True)
            ids = arguments.get("track_ids")
            force = arguments.get("force", False)
            if not isinstance(ids, list) or not 1 <= len(ids) <= 100 or not isinstance(force, bool):
                raise HTTPException(422, "agent_invalid_input")
            for identity in ids:
                if not isinstance(identity, str) or repository.track(identity) is None:
                    raise HTTPException(404, "track_not_found")
            from wildstring.providers import Providers

            providers = getattr(self, "providers", None) or Providers(self.repository)
            return providers.enqueue(ids, force=force, track_batch=True)
        if name == "get_metadata_suggestions":
            actor.require("library:read", admin=True)
            identity = arguments.get("track_id")
            if not isinstance(identity, str) or repository.track(identity) is None:
                raise HTTPException(404, "track_not_found")
            from wildstring.agent_sources import evidence_url
            from wildstring.library.edits import FIELDS

            with self.database.connect() as connection:
                rows = connection.execute(
                    "SELECT id,provider,source_url,fields,metadata_version,status,created_at,match FROM metadata_suggestions WHERE track_id=? ORDER BY created_at DESC LIMIT 30",
                    (identity,),
                ).fetchall()
            result = []
            for row in rows:
                source_url = evidence_url(row["source_url"])
                fields = json.loads(row["fields"])
                result.append(
                    {
                        "id": row["id"],
                        "track_id": identity,
                        "provider": row["provider"],
                        "source_url": source_url,
                        "fields": {key: value for key, value in fields.items() if key in FIELDS},
                        "metadata_version": row["metadata_version"],
                        "status": row["status"],
                        "created_at": row["created_at"],
                        "match": json.loads(row["match"]),
                    }
                )
            return {"items": result, "total": len(result)}
        if name in DIAGNOSTIC_TOOLS:
            return execute_diagnostic(self, actor, name, arguments)
        if name.startswith("search_"):
            query = arguments.get("q", "")
            if not isinstance(query, str) or len(query) > 256:
                raise HTTPException(422, "agent_invalid_input")
            method = {
                "search_tracks": repository.tracks,
                "search_albums": repository.albums,
                "search_artists": repository.artists,
            }[name]
            result = method(q=query, limit=limit, offset=offset)
            if name == "search_tracks":
                result["items"] = [self.projection(track) for track in result["items"]]
            return result
        if name == "get_track":
            identity = arguments.get("track_id")
            if not isinstance(identity, str) or len(identity) > 128:
                raise HTTPException(422, "agent_invalid_input")
            return self.get_track(actor, identity)
        if name == "get_personal_library":
            kind = arguments.get("kind")
            if kind == "playlists":
                return PlaylistStore(repository).listing(limit=limit, offset=offset)
            tracks = repository.tracks(
                limit=limit,
                offset=offset,
                played_only=kind == "history",
                sort="last_played_at" if kind == "history" else "title",
            )
            if kind == "favorites":
                store = PlaylistStore(repository)
                store.ensure_default()
                favorites = next(
                    row for row in store.listing(limit=100)["items"] if row["kind"] == "favorites"
                )
                tracks = store.tracks(favorites["id"], limit=limit, offset=offset)
            elif kind != "history":
                raise HTTPException(422, "agent_invalid_input")
            tracks["items"] = [self.projection(track) for track in tracks["items"]]
            return tracks
        if name == "inspect_library":
            return self.inspect(actor, arguments.get("track_ids"), limit)
        if name == "get_application_policy":
            actor.require("drafts:write")
            if arguments:
                raise HTTPException(422, "agent_invalid_input")
            return self.application_policy(actor)
        if name == "create_draft":
            return self.create_draft(actor, validate(DraftCreate, arguments))
        if name == "get_draft":
            return self.draft(actor, arguments.get("draft_id"))
        if name == "apply_draft":
            from wildstring.agent_models import Apply

            identity = arguments["draft_id"]
            return self.apply_draft(
                actor,
                identity,
                validate(Apply, {k: v for k, v in arguments.items() if k != "draft_id"}),
            )
        if name == "submit_inspection":
            from wildstring.agent_models import Inspection

            return self.submit_task(actor, validate(Inspection, arguments))
        if name == "get_task":
            return self.task(actor, arguments.get("task_id"))
        if name == "cancel_task":
            return self.cancel_task(actor, arguments.get("task_id"))
        return self.notifications(actor, limit=limit, offset=offset)


class AgentPlatform(Core, Application, Review, Notifications, Automation, Assistant, Research):
    def __init__(self, repository, auth, transport=None):
        import threading

        self.repository = repository
        self.database = repository.database
        self.auth = auth
        self.transport = transport
        self.chat_progress = {}
        self.chat_progress_lock = threading.Lock()
        self.diagnostics = None
        self.stop_event = threading.Event()
        self.wake = threading.Event()
        self.thread = None

    @property
    def library_id(self):
        return self.repository.library_id() or self.repository.library_id(create=True)

    def router(self):
        from wildstring.agent_routes import agent_router

        return agent_router(self)
