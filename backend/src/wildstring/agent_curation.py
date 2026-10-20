"""Explicit cover and atomic album proposals, without implicit fact inference."""

import json

from fastapi import HTTPException

from wildstring.agent_curation_models import MetadataBatch
from wildstring.agent_sources import evidence_url
from wildstring.library.artwork import CoverSelection, CoverSelections
from wildstring.library.edits import MetadataEditor, MetadataUpdate, Overrides


def records(service, body, connection):
    identities = [item.track_id for item in body.items]
    if len(set(identities)) != len(identities) or len(set(body.album_ids)) != len(body.album_ids):
        raise HTTPException(422, "duplicate_track_id")
    if any(not isinstance(value, str) or not 1 <= len(value) <= 128 for value in body.album_ids):
        raise HTTPException(422, "agent_invalid_input")
    result = []
    for item in body.items:
        row = connection.execute(
            "SELECT t.id,t.title,t.album_id,m.version,m.observed,m.overrides FROM tracks t "
            "JOIN track_metadata m ON m.track_id=t.id "
            "WHERE t.id=? AND t.library_id=? AND t.status='available'",
            (item.track_id, service.library_id),
        ).fetchone()
        if row is None:
            raise HTTPException(404, "track_not_found")
        if row["version"] != item.metadata_version:
            raise HTTPException(409, "metadata_version_conflict")
        if body.album_ids and row["album_id"] not in body.album_ids:
            raise HTTPException(409, "album_membership_changed")
        if not item.overrides.model_fields_set:
            raise HTTPException(422, "empty_metadata_changes")
        source = None
        if item.source_suggestion_id:
            from wildstring.agent_review import candidate_digest

            candidate = connection.execute(
                "SELECT * FROM metadata_suggestions WHERE id=? AND track_id=?",
                (item.source_suggestion_id, item.track_id),
            ).fetchone()
            changes = item.overrides.model_dump(exclude_unset=True)
            if (
                candidate is None
                or candidate["status"] != "pending"
                or candidate["metadata_version"] != item.metadata_version
                or candidate_digest(candidate) != item.source_digest
                or any(json.loads(candidate["fields"]).get(k) != v for k, v in changes.items())
            ):
                raise HTTPException(409, "metadata_candidate_changed")
            from wildstring.album_release_locks import candidate_conflict

            conflict = candidate_conflict(
                connection,
                service.library_id,
                row["album_id"],
                candidate,
                set(changes),
            )
            if conflict:
                raise HTTPException(409, conflict["code"])
            source = {
                "suggestion_id": candidate["id"],
                "provider": candidate["provider"],
                "url": evidence_url(candidate["source_url"]),
            }
        elif item.source_digest:
            raise HTTPException(422, "invalid_suggestion_fields")
        else:
            from wildstring.album_release_locks import ALBUM_FIELDS
            from wildstring.album_release_locks import read as read_lock

            if read_lock(
                connection, service.library_id, row["album_id"]
            ) and ALBUM_FIELDS.intersection(item.overrides.model_fields_set):
                raise HTTPException(409, "album_release_lock_requires_source")
        result.append(
            {
                "track_id": row["id"],
                "title": row["title"],
                "album_id": row["album_id"],
                "metadata_version": row["version"],
                "effective": json.loads(row["observed"]) | json.loads(row["overrides"]),
                "source": source,
            }
        )
    if body.album_ids:
        # Fixed SQL per album avoids building SQL from caller-controlled identifiers.
        members = {
            row[0]
            for album in body.album_ids
            for row in connection.execute(
                "SELECT id FROM tracks WHERE library_id=? AND album_id=? AND status='available'",
                (service.library_id, album),
            )
        }
        if members != set(identities):
            raise HTTPException(409, "album_membership_changed")
    return result


def check(service, actor, kind, payload):
    from wildstring.agent_common import validate

    actor.require("library:manage", admin=True)
    if kind == "cover":
        selected, before = CoverSelections(service.providers).prepare(
            validate(CoverSelection, payload)
        )
        before["source_url"] = evidence_url(before["source_url"])
        return selected, before
    body = validate(MetadataBatch, payload)
    with service.database.connect() as connection:
        before = records(service, body, connection)
    selected = body.model_dump(exclude_unset=True)
    snapshot = {"items": before, "count": len(before)}
    if body.cover_draft_id:
        cover = service.draft(actor, body.cover_draft_id)
        if cover["kind"] != "cover" or cover["status"] not in {"pending", "approved"}:
            raise HTTPException(409, "cover_candidate_changed")
        fixed, cover_before = CoverSelections(service.providers).prepare(
            validate(CoverSelection, cover["payload"])
        )
        if (
            body.cover_snapshot is not None
            and body.cover_snapshot.model_dump(exclude_unset=True) != fixed
        ):
            raise HTTPException(409, "cover_candidate_changed")
        selected["cover_snapshot"] = fixed
        snapshot["cover"] = cover_before
    elif body.cover_snapshot:
        raise HTTPException(422, "cover_snapshot_server_owned")
    return selected, snapshot


def apply(service, actor, connection, kind, payload):
    from wildstring.agent_common import validate

    actor.require("library:manage", admin=True)
    if kind == "cover":
        return CoverSelections(service.providers).save_in_transaction(
            connection, validate(CoverSelection, payload)
        )
    body = validate(MetadataBatch, payload)
    records(service, body, connection)  # Check the whole selection before writing any row.
    cover_plan = None
    if body.cover_draft_id:
        child = service.draft(actor, body.cover_draft_id, connection)
        if (
            child["kind"] != "cover"
            or child["status"] not in {"pending", "approved"}
            or child["payload"] != body.cover_snapshot.model_dump(exclude_unset=True)
        ):
            raise HTTPException(409, "cover_candidate_changed")
        cover_plan = CoverSelections(service.providers).validate_in_transaction(
            connection, body.cover_snapshot
        )
    editor = MetadataEditor(service.repository_for(actor))
    for item in body.items:
        old = connection.execute(
            "SELECT overrides FROM track_metadata WHERE track_id=?", (item.track_id,)
        ).fetchone()
        merged = json.loads(old[0]) | item.overrides.model_dump(exclude_unset=True)
        editor.save_in_transaction(
            connection,
            item.track_id,
            MetadataUpdate(
                version=item.metadata_version, overrides=Overrides.model_validate(merged)
            ),
            user_id=actor.user_id,
            source="agent_draft",
        )
        if item.source_suggestion_id:
            connection.execute(
                "UPDATE metadata_suggestions SET status='applied' WHERE id=?",
                (item.source_suggestion_id,),
            )
    versions = {item.track_id: item.metadata_version + 1 for item in body.items}
    if cover_plan:
        cover_result = CoverSelections(service.providers).persist_in_transaction(
            connection, body.cover_snapshot, *cover_plan, metadata_changed=frozenset(versions)
        )
        versions.update({target.track_id: target.metadata_version + 1 for target in cover_plan[1]})
        connection.execute(
            "UPDATE agent_drafts SET status='applied',approved_version=version,approved_by=?,result=?,idempotency_key=? WHERE id=?",
            (
                actor.user_id,
                json.dumps(cover_result | {"combined_review": True}),
                "cover-combined:" + body.cover_draft_id,
                body.cover_draft_id,
            ),
        )
    return {"track_ids": list(versions), "metadata_versions": versions}
