"""Delegate MCP operations to the same permission-checked domain services as UI."""

import time
from datetime import UTC, datetime, timedelta

from fastapi import HTTPException

from wildstring.agent_common import validate
from wildstring.agent_diagnostics import legacy_task
from wildstring.agent_music_models import ADMIN_TOOLS, DEFINITIONS
from wildstring.library.lyric_edits import LyricsEditor
from wildstring.library.online_lyrics import display_lyrics
from wildstring.lyric_quality import preview, quality
from wildstring.management import JobRequest


def execute(service, actor, name, arguments):
    _, scope, _, model = DEFINITIONS[name]
    actor.require(scope, admin=name in ADMIN_TOOLS)
    body = validate(model, arguments)
    if name == "list_drafts":
        return service.drafts(actor, **body.model_dump())
    if name == "list_tasks":
        return service.tasks(actor, **body.model_dump())
    if name == "resume_task":
        actor.require("library:read")
        task = service.task(actor, body.task_id)
        if task["parameters"].get("use_ai") and task["parameters"].get("connection_id"):
            service.connection_for(actor, task["parameters"]["connection_id"], background=True)
        return service.resume_task(actor, body.task_id)
    if name in {
        "get_import_settings",
        "set_import_settings",
        "discover_imports",
        "list_intake_items",
        "get_intake_item",
        "submit_library_task",
        "list_library_tasks",
        "get_library_task",
    }:
        return intake_tool(service, name, body)
    providers = service.providers
    sources = providers.sources
    if name == "get_lyrics_quality":
        actor.require("library:read")
        record = LyricsEditor(service.repository_for(actor)).read(body.track_id)
        effective = display_lyrics(record["effective"])
        return {
            "track_id": body.track_id,
            "version": record["version"],
            "file_version": record["file_version"],
            "quality": quality(record["effective"]),
            "source": effective.get("source"),
            "lines": preview(record["effective"]),
            "truncated": len(effective["lines"]) > 20,
        }
    if name == "get_lyric_candidates":
        result = sources.results(body.track_id)
        return {
            "items": [
                {key: value for key, value in candidate.items() if key != "normalized"}
                | {
                    "quality": candidate["quality"],
                    "preview": preview(candidate["normalized"], 5),
                }
                for candidate in result["items"]
            ],
            "jobs": result["jobs"],
        }
    if name == "request_lyrics_lookup":
        return sources.enqueue_lyrics(body.track_id)
    scans = sources.scans
    if name == "get_lyric_scan_settings":
        return scans.settings()
    if name == "set_lyric_scan_settings":
        return scans.settings(body)
    if name == "submit_lyric_scan":
        return scans.create(body)
    if name == "list_lyric_scans":
        with service.database.connect() as db:
            rows = db.execute(
                "SELECT id FROM lyric_scan_batches WHERE library_id=? ORDER BY created_at DESC,id LIMIT ? OFFSET ?",
                (service.library_id, body.limit, body.offset),
            ).fetchall()
            total = db.execute(
                "SELECT count(*) FROM lyric_scan_batches WHERE library_id=?", (service.library_id,)
            ).fetchone()[0]
        return {
            "items": [scans.read(row[0], limit=0) for row in rows],
            "total": total,
            **body.model_dump(),
        }
    if name == "get_lyric_scan":
        return scans.read(body.task_id, offset=body.offset, limit=body.limit)
    if name == "control_lyric_scan":
        return scans.control(body.task_id, body.action)
    loudness = providers.loudness
    if name == "get_loudness":
        return loudness.detail(actor.user_id, body.track_id)
    if name == "request_loudness_analysis":
        for identity in body.track_ids:
            if service.repository_for(actor).track(identity) is None:
                raise HTTPException(404, "track_not_found")
        return {
            "items": [
                {"track_id": identity, **loudness.enqueue(identity)}
                for identity in dict.fromkeys(body.track_ids)
            ]
        }
    if name == "get_gain_settings":
        return loudness.settings(actor.user_id)
    if name == "set_gain_settings":
        return loudness.save_settings(actor.user_id, body)
    if name == "adjust_gain":
        return loudness.adjust(actor.user_id, body.track_id, body.adjustment)
    return web_tool(service, actor, name, body)


def intake_tool(service, name, body):
    management = service.management
    intake = management.intake
    if name == "get_import_settings":
        return intake.preferences()
    if name == "set_import_settings":
        result = intake.configure(body)
        management.next_discovery = 0
        return result
    if name == "discover_imports":
        from itertools import islice

        observed = []
        for path in islice(intake.paths(), body.offset, body.offset + body.limit):
            try:
                observed.append(intake.public(intake.observe(path, True)))
            except OSError:
                observed.append(
                    {
                        "source_path": path.as_posix(),
                        "state": "waiting",
                        "issues": ["source_missing"],
                        "can_approve": False,
                    }
                )
        return {"items": observed, **body.model_dump(), "has_more": len(observed) == body.limit}
    if name == "list_intake_items":
        return intake.items(**body.model_dump())
    if name == "get_intake_item":
        return intake.public(intake.item(body.item_id))
    if name == "submit_library_task":
        job = management.submit(JobRequest(**body.model_dump()), automatic=True)
        return legacy_task(service, job["id"])[0]
    if name == "get_library_task":
        management.job(body.task_id)  # Enforce the same library boundary first.
        return legacy_task(service, body.task_id)[0]
    result = management.jobs(**body.model_dump())
    result["items"] = [legacy_task(service, item["id"])[0] for item in result["items"]]
    return result


def web_tool(service, actor, name, body):
    actor.require("library:read")
    settings = service.search_settings(actor)
    if name == "get_search_settings":
        return settings
    if not settings["enabled"]:
        raise HTTPException(409, "search_disabled")
    settings["deadline"] = time.monotonic() + 65
    if name == "search_web":
        with service.database.connect(write=True) as db:
            db.execute(
                "DELETE FROM agent_web_sources WHERE user_id=? AND run_id IS NULL AND retrieved_at<?",
                (actor.user_id, (datetime.now(UTC) - timedelta(days=1)).isoformat()),
            )
        result = service.research_tool(actor, settings, name, body.model_dump(), {}, None)
        return result | {"untrusted_content": True}
    with service.database.connect() as db:
        row = db.execute(
            "SELECT * FROM agent_web_sources WHERE id=? AND user_id=? AND retrieved_at>?",
            (body.source_id, actor.user_id, (datetime.now(UTC) - timedelta(days=1)).isoformat()),
        ).fetchone()
    if not row:
        raise HTTPException(404, "web_source_not_found")
    source = {
        key: row[key] for key in ("id", "title", "url", "summary", "published_at", "retrieved_at")
    }
    return service.research_tool(
        actor, settings, name, body.model_dump(), {source["id"]: source}, None
    ) | {"untrusted_content": True}
