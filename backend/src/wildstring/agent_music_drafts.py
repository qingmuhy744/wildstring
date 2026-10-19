"""Versioned proposals for intake metadata and exact lyric candidates."""

from pydantic import Field

from wildstring.agent_models import Input
from wildstring.library.edits import Overrides
from wildstring.source_models import LyricChoice


class IntakePayload(Input):
    item_id: str = Field(min_length=1, max_length=128)
    version: int = Field(ge=1)
    overrides: Overrides


class LyricsPayload(LyricChoice):
    candidate_id: str = Field(min_length=1, max_length=128)


def check(service, actor, kind, payload):
    from fastapi import HTTPException

    from wildstring.agent_common import validate
    from wildstring.library.intake import IntakeApproval
    from wildstring.library.lyric_edits import LyricsEditor
    from wildstring.lyric_quality import preview, quality

    actor.require("library:manage", admin=True)
    if kind == "intake":
        body = validate(IntakePayload, payload)
        intake = service.management.intake
        item = intake.item(body.item_id)
        intake.approval(item, IntakeApproval(version=body.version, overrides=body.overrides))
        return body.model_dump(exclude_unset=True), item["metadata"] | item["overrides"] | {
            "source_path": item["source_path"]
        }
    body = validate(LyricsPayload, payload)
    with service.database.connect() as db:
        row = db.execute(
            "SELECT * FROM lyric_candidates WHERE id=?", (body.candidate_id,)
        ).fetchone()
    if row is None:
        raise HTTPException(404, "lyric_candidate_not_found")
    record = LyricsEditor(service.repository).read(row["track_id"])
    if (
        record["version"] != body.version
        or row["lyrics_version"] != body.version
        or row["file_version"] != body.file_version
        or record["file_version"] != body.file_version
    ):
        raise HTTPException(409, "lyrics_version_conflict")
    import json

    candidate = json.loads(row["normalized"])
    return body.model_dump(), {
        "track_id": row["track_id"],
        "title": service.repository.track(row["track_id"])["title"],
        "current_quality": quality(record["effective"]),
        "candidate_quality": quality(candidate),
        "provider": row["plugin_id"],
        "match": json.loads(row["match"]),
        "current_lines": preview(record["effective"], 5),
        "candidate_lines": preview(candidate, 5),
    }


def apply(service, actor, connection, kind, payload):
    from wildstring.agent_common import validate
    from wildstring.library.intake import IntakeApproval

    actor.require("library:manage", admin=True)
    if kind == "intake":
        body = validate(IntakePayload, payload)
        item = service.management.intake.approve(
            body.item_id,
            IntakeApproval(version=body.version, overrides=body.overrides),
            connection=connection,
        )
        service.management.next_discovery = 0
        return {"item_id": item["id"], "version": item["version"], "state": item["state"]}
    body = validate(LyricsPayload, payload)
    return service.providers.sources.apply_in_transaction(
        connection, body.candidate_id, LyricChoice(**body.model_dump(exclude={"candidate_id"}))
    )
