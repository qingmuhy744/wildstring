"""Source-plugin orchestration keeps permissions and matching in WildString."""

import json
import time
from difflib import SequenceMatcher
from urllib.parse import urlsplit
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi import Request as APIRequest
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field

from wildstring.library.edits import Overrides
from wildstring.library.lyric_edits import LyricsEditor, lyric_text
from wildstring.library.metadata import normalize
from wildstring.library.online_lyrics import display_lyrics, normalize_bundle
from wildstring.lyric_scans import LyricScans
from wildstring.source_models import LyricChoice
from wildstring.source_plugins import PluginError, registry


class PluginSettings(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    version: int = Field(ge=0)
    enabled: bool = False
    metadata_enabled: bool = True
    lyrics_enabled: bool = True
    priority: int = Field(default=50, ge=0, le=100)
    config: dict[str, str] = Field(default_factory=dict, max_length=20)
    clear_secrets: list[str] = Field(default_factory=list, max_length=10)


def matching(track, candidate):
    title = normalize(track["title"])
    other = normalize(candidate.get("title", ""))
    artist = normalize(" ".join(track.get("artists", [])))
    other_artist = normalize(" ".join(candidate.get("artists", [])))
    flags = (
        "live",
        "现场",
        "remaster",
        "重制",
        "acoustic",
        "unplugged",
        "不插电",
        "instrumental",
        "伴奏",
    )
    version_mismatch = any((flag in title) != (flag in other) for flag in flags)
    duration = candidate.get("duration_ms") or 0
    difference = abs(track.get("duration_ms", 0) - duration) if duration else None
    title_score = SequenceMatcher(None, title, other).ratio()
    artist_score = (
        SequenceMatcher(None, artist, other_artist).ratio() if artist and other_artist else 0
    )
    score = (
        0.45 * title_score
        + 0.4 * artist_score
        + (0.15 * max(0, 1 - difference / 10000) if difference is not None else 0)
    )
    return {
        "method": "title_artist_duration",
        "score": round(score * (0.5 if version_mismatch else 1), 3),
        "version_mismatch": version_mismatch,
        "duration_difference_ms": difference,
        "source_id": str(candidate["id"]),
        "release_id": candidate.get("release_id"),
        "title": candidate.get("title"),
        "artists": candidate.get("artists", []),
        "automatic_match": False,
    }


def bridge_url(value):
    try:
        parsed = urlsplit(value)
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.hostname
            or parsed.username
            or parsed.password
            or parsed.query
            or parsed.fragment
            or any(c.isspace() or ord(c) < 32 for c in value)
        ):
            raise ValueError
        if parsed.port is not None and not 1 <= parsed.port <= 65535:
            raise ValueError
    except ValueError:
        raise HTTPException(422, "source_plugin_invalid_url") from None
    return value.rstrip("/")


class PluginContext:
    def __init__(self, manager, identity, configuration, deadline=None):
        self.manager, self.identity, self.configuration = manager, identity, configuration
        self.directory = manager.providers.directory
        self.deadline = deadline or time.monotonic() + 90
        self.force = False
        self.batch_id = None
        self.interval_seconds = 5


class MusicSources:
    def __init__(self, providers):
        self.providers, self.database = providers, providers.database
        self.scans = LyricScans(self)

    @property
    def plugins(self):
        return registry(self.database, self.providers.directory / "source-plugins")

    def settings(self, identity):
        if identity not in self.plugins:
            raise HTTPException(404, "source_plugin_not_found")
        with self.database.connect() as db:
            row = db.execute(
                "SELECT * FROM source_plugin_settings WHERE plugin_id=?", (identity,)
            ).fetchone()
        value = (
            dict(row)
            if row
            else {
                "version": 0,
                "enabled": False,
                "metadata_enabled": True,
                "lyrics_enabled": True,
                "priority": 50,
                "config": "{}",
            }
        )
        value.pop("plugin_id", None)
        value["config"] = json.loads(value["config"])
        for field in ("enabled", "metadata_enabled", "lyrics_enabled"):
            value[field] = bool(value[field])
        return value

    def current(self, identity, version):
        config = self.settings(identity)
        if not config["enabled"] or config["version"] != version:
            raise PluginError("source_plugin_configuration_changed")
        return config

    def catalog(self):
        result = []
        for identity, plugin in self.plugins.items():
            value = self.settings(identity)
            value["configured_secrets"] = [
                field["key"]
                for field in plugin.manifest.settings
                if field["type"] == "secret"
                and self.providers.secrets().get(f"source:{identity}:{field['key']}")
            ]
            result.append(
                plugin.manifest.public()
                | value
                | {
                    "available": plugin.available()
                    if callable(getattr(plugin, "available", None))
                    else True,
                    "plugin_version": plugin.manifest.version,
                }
            )
        return sorted(result, key=lambda value: (value["priority"], value["id"]))

    def save(self, identity, body):
        current = self.settings(identity)
        plugin = self.plugins[identity]
        fields = {field["key"]: field for field in plugin.manifest.settings}
        if set(body.config) - fields.keys() or set(body.clear_secrets) - {
            key for key, field in fields.items() if field["type"] == "secret"
        }:
            raise HTTPException(422, "source_plugin_invalid_config")
        values = dict(current["config"])
        secret_updates = {}
        for key, value in body.config.items():
            if len(value) > 8000 or any(ord(c) < 32 for c in value):
                raise HTTPException(422, "source_plugin_invalid_config")
            if fields[key]["type"] == "secret":
                if value:
                    secret_updates[f"source:{identity}:{key}"] = value
            else:
                values[key] = bridge_url(value) if value and fields[key]["type"] == "url" else value
        for key in body.clear_secrets:
            secret_updates[f"source:{identity}:{key}"] = None
        existing_secrets = self.providers.secrets()
        if body.enabled and any(
            field.get("required")
            and not (
                secret_updates.get(
                    f"source:{identity}:{key}", existing_secrets.get(f"source:{identity}:{key}")
                )
                if field["type"] == "secret"
                else values.get(key)
            )
            for key, field in fields.items()
        ):
            raise HTTPException(422, "source_plugin_invalid_config")
        if body.enabled and callable(getattr(plugin, "available", None)) and not plugin.available():
            raise HTTPException(409, "source_plugin_dependency_missing")
        # Serialize credential changes with the same lock as other provider configuration.
        with self.database.connect(write=True) as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute(
                "SELECT version FROM source_plugin_settings WHERE plugin_id=?", (identity,)
            ).fetchone()
            if (row[0] if row else 0) != body.version:
                raise HTTPException(409, "source_plugin_version_conflict")
            self.providers.secrets(secret_updates)
            db.execute(
                "INSERT INTO source_plugin_settings VALUES (?,?,?,?,?,?,?) ON CONFLICT(plugin_id) DO UPDATE SET enabled=excluded.enabled,metadata_enabled=excluded.metadata_enabled,lyrics_enabled=excluded.lyrics_enabled,priority=excluded.priority,config=excluded.config,version=excluded.version",
                (
                    identity,
                    body.enabled,
                    body.metadata_enabled,
                    body.lyrics_enabled,
                    body.priority,
                    json.dumps(values),
                    body.version + 1,
                ),
            )
        return next(value for value in self.catalog() if value["id"] == identity)

    def candidates(self, track, identity, *, force=False, batch_id=None, interval_seconds=5):
        configuration = self.settings(identity)
        context = PluginContext(self, identity, configuration)
        context.force, context.batch_id, context.interval_seconds = (
            force,
            batch_id,
            interval_seconds,
        )
        if batch_id:
            context.deadline = time.monotonic() + max(180, interval_seconds * 12 + 120)
        plugin = self.plugins[identity]
        query = (track["title"] + " " + " ".join(track.get("artists", [])))[:200]
        candidates = plugin.search(context, query)
        if not isinstance(candidates, list):
            raise PluginError("source_plugin_invalid_response")
        result = []
        for candidate in candidates[:3]:
            detail = plugin.metadata(context, candidate)
            if (
                not isinstance(detail, dict)
                or not isinstance(detail.get("id"), str)
                or not 1 <= len(detail["id"]) <= 300
                or not isinstance(detail.get("fields"), dict)
            ):
                raise PluginError("source_plugin_invalid_response")
            url = detail.get("source_url", "")
            parsed = urlsplit(url)
            if (
                parsed.scheme != "https"
                or not parsed.hostname
                or parsed.username
                or parsed.password
                or len(url) > 4000
                or any(c.isspace() or ord(c) < 32 for c in url)
            ):
                raise PluginError("source_plugin_invalid_response")
            duration = detail.get("duration_ms")
            if duration is not None and (
                type(duration) is not int or not 0 < duration <= 86_400_000
            ):
                raise PluginError("source_plugin_invalid_response")
            fields = Overrides.model_validate(
                {
                    key: value
                    for key, value in detail["fields"].items()
                    if value not in (None, "", [])
                }
            ).model_dump(exclude_unset=True)
            detail["fields"] = fields
            detail["title"] = fields.get("title", "")
            detail["artists"] = fields.get("artists", [])
            detail["match"] = matching(track, detail)
            result.append(detail)
        return sorted(result, key=lambda value: -value["match"]["score"]), context

    def suggestions(self, track):
        output, warnings = [], []
        for config in self.catalog():
            if not config["enabled"] or not config["metadata_enabled"]:
                continue
            try:
                candidates, context = self.candidates(track, config["id"])
                self.current(config["id"], context.configuration["version"])
                for candidate in candidates:
                    output.append(
                        (
                            config["id"],
                            candidate["source_url"],
                            candidate["fields"],
                            candidate.get("cover_url"),
                            candidate["match"],
                        )
                    )
            except Exception as error:
                warnings.append(
                    config["id"]
                    + ":"
                    + (
                        error.code
                        if isinstance(error, PluginError)
                        else "source_plugin_invalid_response"
                    )
                )
        return output, warnings

    def enqueue_lyrics(self, track_id):
        LyricsEditor(self.providers.repository).read(track_id)
        if not any(value["enabled"] and value["lyrics_enabled"] for value in self.catalog()):
            raise HTTPException(409, "source_plugins_disabled")
        with self.database.connect(write=True) as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute(
                "SELECT id FROM lyric_lookup_jobs WHERE track_id=? AND status IN ('queued','running')",
                (track_id,),
            ).fetchone()
            if row:
                return {"id": row[0], "status": "queued"}
            identity = uuid4().hex
            db.execute(
                "INSERT INTO lyric_lookup_jobs VALUES (?,?,'queued',NULL,'[]',?,?)",
                (identity, track_id, time.time(), time.time()),
            )
        return {"id": identity, "status": "queued"}

    def step(self):
        with self.database.connect(write=True) as db:
            db.execute("BEGIN IMMEDIATE")
            job = db.execute(
                "SELECT * FROM lyric_lookup_jobs WHERE status='queued' ORDER BY created_at LIMIT 1"
            ).fetchone()
            if not job:
                return False
            db.execute(
                "UPDATE lyric_lookup_jobs SET status='running',updated_at=? WHERE id=?",
                (time.time(), job["id"]),
            )
        warnings = []
        try:
            with self.database.connect(write=True) as db:
                db.execute(
                    "DELETE FROM lyric_candidates WHERE track_id=? AND job_id NOT IN (SELECT id FROM lyric_lookup_jobs WHERE track_id=? ORDER BY created_at DESC LIMIT 5) AND id NOT IN (SELECT json_extract(selected_candidate,'$.id') FROM track_lyrics WHERE selected_candidate IS NOT NULL) AND id NOT IN (SELECT candidate_id FROM lyric_scan_items WHERE candidate_id IS NOT NULL) AND id NOT IN (SELECT json_extract(previous,'$.selected_candidate.id') FROM lyric_scan_items WHERE json_extract(previous,'$.selected_candidate.id') IS NOT NULL)",
                    (job["track_id"], job["track_id"]),
                )
                db.execute(
                    "DELETE FROM lyric_lookup_jobs WHERE track_id=? AND id NOT IN (SELECT id FROM lyric_lookup_jobs WHERE track_id=? ORDER BY created_at DESC LIMIT 5) AND id NOT IN (SELECT job_id FROM lyric_candidates)",
                    (job["track_id"], job["track_id"]),
                )
            track = self.providers.repository.track(job["track_id"])
            record = LyricsEditor(self.providers.repository).read(job["track_id"])
            for config in self.catalog():
                if not config["enabled"] or not config["lyrics_enabled"]:
                    continue
                try:
                    candidates, context = self.candidates(track, config["id"])
                    for candidate in candidates[:2]:
                        raw = self.plugins[config["id"]].lyrics(context, candidate)
                        if (
                            len(
                                json.dumps(
                                    {
                                        key: value
                                        for key, value in raw.items()
                                        if key != "normalized"
                                    }
                                ).encode()
                            )
                            > 512 * 1024
                        ):
                            raise PluginError("source_plugin_response_too_large")
                        normalized = normalize_bundle(raw, config["id"])
                        if normalized["kind"] == "none":
                            continue
                        self.current(config["id"], config["version"])
                        with self.database.connect(write=True) as db:
                            db.execute(
                                "INSERT INTO lyric_candidates VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                                (
                                    uuid4().hex,
                                    job["id"],
                                    track["id"],
                                    config["id"],
                                    str(candidate["id"]),
                                    candidate["source_url"],
                                    json.dumps(candidate["match"]),
                                    json.dumps(
                                        {
                                            key: value
                                            for key, value in raw.items()
                                            if key != "normalized"
                                        }
                                    ),
                                    json.dumps(normalized),
                                    record["version"],
                                    record["file_version"],
                                    time.time(),
                                ),
                            )
                except Exception as error:
                    warnings.append(
                        config["id"]
                        + ":"
                        + (
                            error.code
                            if isinstance(error, PluginError)
                            else "source_plugin_invalid_response"
                        )
                    )
            with self.database.connect(write=True) as db:
                count = db.execute(
                    "SELECT count(*) FROM lyric_candidates WHERE job_id=?", (job["id"],)
                ).fetchone()[0]
                db.execute(
                    "UPDATE lyric_lookup_jobs SET status=?,warnings=?,updated_at=? WHERE id=?",
                    (
                        "completed" if count else "no_match",
                        json.dumps(warnings),
                        time.time(),
                        job["id"],
                    ),
                )
        except Exception:
            with self.database.connect(write=True) as db:
                db.execute(
                    "UPDATE lyric_lookup_jobs SET status='failed',error='lyric_lookup_failed',updated_at=? WHERE id=?",
                    (time.time(), job["id"]),
                )
        return True

    def results(self, track_id):
        LyricsEditor(self.providers.repository).read(track_id)
        with self.database.connect() as db:
            jobs = [
                dict(row)
                for row in db.execute(
                    "SELECT * FROM lyric_lookup_jobs WHERE track_id=? ORDER BY created_at DESC LIMIT 5",
                    (track_id,),
                )
            ]
            rows = [
                dict(row)
                for row in db.execute(
                    "SELECT * FROM lyric_candidates WHERE track_id=? ORDER BY created_at DESC LIMIT 30",
                    (track_id,),
                )
            ]
        from wildstring.lyric_quality import quality

        for value in rows:
            value.pop("raw")
            for field in ("match", "normalized"):
                value[field] = json.loads(value[field])
            value["quality"] = quality(value["normalized"])
            value["normalized"] = display_lyrics(value["normalized"])
            value["line_count"] = len(value["normalized"]["lines"])
            value["normalized"]["lines"] = value["normalized"]["lines"][:100]
            value["normalized"].pop("layers", None)
        for job in jobs:
            job["warnings"] = json.loads(job["warnings"])
        rows.sort(
            key=lambda value: (
                value["match"]["version_mismatch"],
                -value["match"]["score"],
                -value["created_at"],
            )
        )
        return {"items": rows, "jobs": jobs}

    def apply(self, identity, body, scan_item=None):
        editor = LyricsEditor(self.providers.repository)
        with self.database.connect(write=True) as db:
            db.execute("BEGIN IMMEDIATE")
            result = self.apply_in_transaction(db, identity, body, scan_item)
        return editor.read(result["track_id"])

    def apply_in_transaction(self, db, identity, body, scan_item=None):
        editor = LyricsEditor(self.providers.repository)
        row = db.execute("SELECT * FROM lyric_candidates WHERE id=?", (identity,)).fetchone()
        if row is None:
            raise HTTPException(404, "lyric_candidate_not_found")
        _, file_version = editor.observed(row["track_id"])
        previous = db.execute(
            "SELECT * FROM track_lyrics WHERE track_id=?", (row["track_id"],)
        ).fetchone()
        current_version = previous["version"] if previous else 1
        if (
            row["lyrics_version"] != body.version
            or row["file_version"] != body.file_version
            or file_version != body.file_version
            or current_version != body.version
        ):
            raise HTTPException(409, "lyrics_version_conflict")
        if scan_item:
            locked = db.execute(
                "SELECT locked FROM lyric_locks WHERE track_id=?", (row["track_id"],)
            ).fetchone()
            item = db.execute(
                "SELECT status,candidate_id,track_id,fingerprint FROM lyric_scan_items WHERE id=?",
                (scan_item,),
            ).fetchone()
            if locked and locked[0]:
                raise HTTPException(409, "lyrics_locked")
            if not item or item[0] != "ready" or item[1] != identity or item[2] != row["track_id"]:
                raise HTTPException(409, "lyric_scan_item_not_ready")
            from wildstring.lyric_scans import signature

            track = self.providers.repository.track(row["track_id"])
            if not track or item[3] != signature(
                track, {"file_version": file_version, "version": current_version}
            ):
                raise HTTPException(409, "lyrics_version_conflict")
            snapshot = {
                "text": previous["text"] if previous else None,
                "selected_candidate": json.loads(previous["selected_candidate"])
                if previous and previous["selected_candidate"]
                else None,
            }
            db.execute(
                "UPDATE lyric_scan_items SET previous=?,applied_version=?,status='applied',updated_at=? WHERE id=?",
                (json.dumps(snapshot), current_version + 1, time.time(), scan_item),
            )
        normalized = json.loads(row["normalized"])
        for line in normalized["lines"]:
            if line["time_ms"] is not None:
                line["time_ms"] = max(0, line["time_ms"] + body.offset_ms)
        db.execute(
            "INSERT INTO track_lyrics(track_id,text,version,selected_candidate) VALUES (?,?,?,?) ON CONFLICT(track_id) DO UPDATE SET text=excluded.text,version=excluded.version,selected_candidate=excluded.selected_candidate",
            (
                row["track_id"],
                lyric_text(normalized),
                current_version + 1,
                json.dumps({"id": identity, "offset_ms": body.offset_ms}),
            ),
        )
        return {
            "track_id": row["track_id"],
            "version": current_version + 1,
            "candidate_id": identity,
        }

    def router(self, auth):
        router = APIRouter(prefix="/api/v1")
        admin = Depends(auth.require_owner)
        mutation = [Depends(auth.require_client)]

        @router.get("/manage/source-plugins")
        def catalog(user=admin):
            return {"items": self.catalog(), "api_version": 1}

        @router.post("/manage/source-plugins/import", dependencies=mutation)
        async def import_zip(
            request: APIRequest,
            user=admin,
            expected_version: int | None = Query(default=None, ge=1),
            expected_id: str | None = Query(default=None, pattern=r"^[a-z][a-z0-9_-]{1,40}$"),
        ):
            from wildstring.plugin_archives import MAX_ARCHIVE, install

            data = bytearray()
            async for chunk in request.stream():
                data.extend(chunk)
                if len(data) > MAX_ARCHIVE:
                    raise HTTPException(413, "source_plugin_zip_too_large")
            import asyncio

            return await asyncio.to_thread(
                install, self, bytes(data), expected_version, expected_id
            )

        @router.get("/manage/source-plugins/{identity}/export")
        def export_zip(identity: str, user=admin):
            self.settings(identity)
            plugin = self.plugins[identity]
            return FileResponse(
                plugin.path / "package.zip",
                media_type="application/zip",
                filename=f"wildstring-{identity}-{plugin.manifest.version}.zip",
            )

        @router.delete("/manage/source-plugins/{identity}", dependencies=mutation)
        def uninstall(identity: str, version: int = Query(ge=1), user=admin):
            self.settings(identity)
            plugin = self.plugins[identity]
            with self.database.connect(write=True) as db:
                db.execute("BEGIN IMMEDIATE")
                row = db.execute(
                    "SELECT enabled,version FROM source_plugin_settings WHERE plugin_id=?",
                    (identity,),
                ).fetchone()
                if not row or row[1] != version:
                    raise HTTPException(409, "source_plugin_version_conflict")
                if row[0]:
                    raise HTTPException(409, "source_plugin_disable_first")
                db.execute("DELETE FROM source_plugin_packages WHERE plugin_id=?", (identity,))
                db.execute("DELETE FROM source_plugin_settings WHERE plugin_id=?", (identity,))
            secret_updates = {
                f"source:{identity}:{field['key']}": None
                for field in plugin.manifest.settings
                if field["type"] == "secret"
            }
            if secret_updates:
                self.providers.secrets(secret_updates)
            return {"ok": True}

        @router.put("/manage/source-plugins/{identity}", dependencies=mutation)
        def save(identity: str, body: PluginSettings, user=admin):
            return self.save(identity, body)

        @router.post("/manage/source-plugins/{identity}/test", dependencies=mutation)
        def test(identity: str, user=admin):
            configuration = self.settings(identity)
            if not configuration["enabled"]:
                raise HTTPException(409, "source_plugin_disabled")
            context = PluginContext(self, identity, configuration, time.monotonic() + 25)
            try:
                values = self.plugins[identity].search(context, "摇滚")
                if not isinstance(values, list):
                    raise PluginError("source_plugin_invalid_response")
                return {"ok": True, "count": min(3, len(values))}
            except Exception as error:
                from wildstring.diagnostics import record_event

                record_event(
                    "source_plugin.test.finished",
                    service=identity,
                    operation="plugin_test",
                    code=error.code
                    if isinstance(error, PluginError)
                    else "source_plugin_invalid_response",
                )
                raise HTTPException(
                    409
                    if isinstance(error, PluginError)
                    and error.code == "source_plugin_configuration_changed"
                    else 502,
                    error.code
                    if isinstance(error, PluginError)
                    else "source_plugin_invalid_response",
                ) from None

        @router.get("/manage/tracks/{track_id}/online-lyrics")
        def results(track_id: str, user=admin):
            return self.results(track_id)

        @router.post("/manage/tracks/{track_id}/online-lyrics", dependencies=mutation)
        def query(track_id: str, user=admin):
            return self.enqueue_lyrics(track_id)

        @router.post("/manage/lyric-candidates/{identity}/apply", dependencies=mutation)
        def apply(identity: str, body: LyricChoice, user=admin):
            return self.apply(identity, body)

        return router
