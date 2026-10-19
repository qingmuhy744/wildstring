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
        result.append(
            {
                "track_id": row["id"],
                "title": row["title"],
                "album_id": row["album_id"],
                "metadata_version": row["version"],
                "effective": json.loads(row["observed"]) | json.loads(row["overrides"]),
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
    return body.model_dump(exclude_unset=True), {"items": before, "count": len(before)}


def apply(service, actor, connection, kind, payload):
    from wildstring.agent_common import validate

    actor.require("library:manage", admin=True)
    if kind == "cover":
        return CoverSelections(service.providers).save_in_transaction(
            connection, validate(CoverSelection, payload)
        )
    body = validate(MetadataBatch, payload)
    records(service, body, connection)  # Check the whole selection before writing any row.
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
    return {
        "track_ids": [item.track_id for item in body.items],
        "metadata_versions": {item.track_id: item.metadata_version + 1 for item in body.items},
    }
