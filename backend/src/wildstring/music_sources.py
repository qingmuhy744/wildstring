"""Source-plugin orchestration keeps permissions and matching in WildString."""

import json
import re
import shutil
import time
from concurrent.futures import ThreadPoolExecutor
from contextvars import copy_context
from difflib import SequenceMatcher
from typing import Annotated
from urllib.parse import urlsplit
from uuid import uuid4

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from fastapi import Request as APIRequest
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from wildstring.library.edits import Overrides
from wildstring.library.lyric_edits import LyricsEditor, lyric_text
from wildstring.library.metadata import normalize
from wildstring.library.online_lyrics import display_lyrics, normalize_bundle
from wildstring.lyric_scans import LyricScans
from wildstring.source_models import LyricChoice
from wildstring.source_plugins import API_VERSION, PluginError, registry


class PluginSettings(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    version: int = Field(ge=0)
    enabled: bool = False
    metadata_enabled: bool = True
    lyrics_enabled: bool = True
    priority: int = Field(default=50, ge=0, le=100)
    config: dict[str, str] = Field(default_factory=dict, max_length=20)
    clear_secrets: list[str] = Field(default_factory=list, max_length=10)


class LyricQuery(BaseModel):
    model_config = ConfigDict(extra="forbid")
    plugin_ids: list[str] | None = Field(default=None, min_length=1, max_length=20)


_NOISE_TAG = re.compile(
    r"\[\s*([^\[\]]+?)\s*\]|【\s*([^【】]+?)\s*】|\(\s*([^()]+?)\s*\)|（\s*([^（）]+?)\s*）"
)
_NOISE_TERM = (
    r"(?:flac|wav|ape|alac|dsd|dff|dsf|aac|mp3|m4a|ogg|opus|wma|"
    r"lossless|无损|母带|hi-?res|hires|sq|hq|mq|cd|"
    r"explicit|clean|"
    r"official\s+(?:music\s+|lyric\s+)?(?:audio|video)|official\s+visualizer|"
    r"lyric\s+video|music\s+video|visualizer|mv|pv|audio|hd|uhd|4k|1080p|"
    r"\d+\s*kbps|\d+\s*bit(?:\s*/\s*\d+(?:\.\d+)?\s*k(?:hz)?)?|\d+(?:\.\d+)?\s*khz)"
)
_NOISE_CONTENT = re.compile(rf"(?i)^{_NOISE_TERM}(?:[\s/,|·+-]+{_NOISE_TERM})*$")


def clean_search_text(value: str) -> str:
    """Strip bracketed technical/packaging noise while keeping musical version markers."""
    original = (value or "").strip()
    if not original:
        return ""
    stripped = _NOISE_TAG.sub(
        lambda m: (
            ""
            if _NOISE_CONTENT.fullmatch(next(g for g in m.groups() if g is not None).strip())
            else m.group(0)
        ),
        original,
    )
    cleaned = re.sub(r"\s{2,}", " ", stripped).strip()
    return cleaned or original


def search_query(
    track: dict,
    *,
    query_title: str | None = None,
    query_artist: str | None = None,
) -> dict:
    """Build normalized search title, artists, and combined query keyword."""
    title = (
        query_title.strip()
        if query_title and query_title.strip()
        else clean_search_text(str(track.get("title") or ""))
    )
    if query_artist and query_artist.strip():
        artists = [
            part.strip() for part in re.split(r"[,;/、]+", query_artist.strip()) if part.strip()
        ]
    else:
        artists = [
            cleaned
            for item in track.get("artists", [])
            if (cleaned := clean_search_text(str(item)))
        ]
    keyword = (title + (" " + " ".join(artists) if artists else "")).strip()[:200]
    return {
        "title": title,
        "artists": artists,
        "album": track.get("album"),
        "duration_ms": track.get("duration_ms"),
        "keyword": keyword,
    }


def matching(track, candidate):
    title = normalize(track["title"])
    other = normalize(candidate.get("title", ""))
    artist = normalize(" ".join(track.get("artists", [])))
    other_artist = normalize(" ".join(candidate.get("artists", [])))
    flags = (
        "live",
        "现场",
        "demo",
        "小样",
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
        self.interactive = False
        self.batch_id = None
        self.interval_seconds = 5


class MusicSources:
    def __init__(self, providers):
        self.providers, self.database = providers, providers.database
        self.scans = LyricScans(self)

    def retire_old_packages(self):
        with self.database.connect(write=True) as db:
            db.execute("BEGIN IMMEDIATE")
            old = [
                row
                for row in db.execute(
                    "SELECT plugin_id, sha256, manifest FROM source_plugin_packages"
                )
                if json.loads(row["manifest"]).get("api_version") != API_VERSION
            ]
            if not old:
                return
            ids = {row["plugin_id"] for row in old}
            credentials = {
                key: None
                for key in self.providers.secrets()
                if any(key.startswith(f"source:{identity}:") for identity in ids)
            }
            if credentials:
                self.providers.secrets(credentials)
            for row in old:
                identity = row["plugin_id"]
                for target in (
                    self.providers.directory / "source-plugins" / row["sha256"],
                    self.providers.directory / "plugin-state" / identity,
                ):
                    if target.exists():
                        shutil.rmtree(target)
                db.execute("DELETE FROM source_plugin_settings WHERE plugin_id=?", (identity,))
                db.execute("DELETE FROM source_plugin_packages WHERE plugin_id=?", (identity,))
                db.execute("DELETE FROM provider_cache WHERE provider=?", ("plugin:" + identity,))
            if not db.execute(
                "SELECT 1 FROM source_plugin_packages p JOIN source_plugin_settings s USING(plugin_id) "
                "WHERE s.enabled=1 AND s.lyrics_enabled=1 LIMIT 1"
            ).fetchone():
                db.execute(
                    "UPDATE lyric_lookup_jobs AS j SET status='cancelled',"
                    "error='source_plugin_incompatible_api',updated_at=? "
                    "WHERE status IN ('queued','running') AND NOT EXISTS "
                    "(SELECT 1 FROM lyric_scan_items i WHERE i.job_id=j.id)",
                    (time.time(),),
                )
            affected = [
                row["id"]
                for row in db.execute(
                    "SELECT id, options FROM lyric_scan_batches WHERE status IN ('running','paused')"
                )
                if any(
                    provider["id"] in ids for provider in json.loads(row["options"])["providers"]
                )
            ]
            for batch_id in affected:
                db.execute(
                    "UPDATE lyric_lookup_jobs SET status='cancelled',error='source_plugin_incompatible_api' WHERE status IN ('running','paused','queued') AND id IN (SELECT job_id FROM lyric_scan_items WHERE batch_id=?)",
                    (batch_id,),
                )
                db.execute(
                    "UPDATE lyric_scan_items SET status='cancelled',error='source_plugin_incompatible_api' WHERE batch_id=? AND status IN ('queued','running')",
                    (batch_id,),
                )
                db.execute(
                    "UPDATE lyric_scan_batches SET status='cancelled',updated_at=? WHERE id=?",
                    (time.time(), batch_id),
                )

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

    def candidates(
        self,
        track,
        identity,
        *,
        force=False,
        batch_id=None,
        interval_seconds=None,
        include_release=True,
        interactive=False,
        query_title=None,
        query_artist=None,
    ):
        if interval_seconds is None:
            interval_seconds = 0.8 if (interactive and not batch_id) else 5
        configuration = self.settings(identity)
        context = PluginContext(self, identity, configuration)
        context.force, context.batch_id, context.interval_seconds = (
            force,
            batch_id,
            interval_seconds,
        )
        context.interactive = interactive
        if batch_id:
            context.deadline = time.monotonic() + max(180, interval_seconds * 12 + 120)
        plugin = self.plugins[identity]
        parsed_query = search_query(track, query_title=query_title, query_artist=query_artist)
        effective_track = (
            track
            if not (query_title and query_title.strip())
            and not (query_artist and query_artist.strip())
            else track | {"title": parsed_query["title"], "artists": parsed_query["artists"]}
        )
        query = (
            parsed_query["keyword"]
            or (track["title"] + " " + " ".join(track.get("artists", [])))[:200]
        )
        candidates = plugin.search(context, query)
        if not isinstance(candidates, list):
            raise PluginError("source_plugin_invalid_response")
        valid_candidates = []
        summaries = []
        for row in candidates[:3]:
            try:
                summary = self.candidate(effective_track, row)
            except (PluginError, ValidationError):
                continue
            valid_candidates.append(row)
            summaries.append(summary)
        ranked = sorted(summaries, key=lambda row: -row["match"]["score"])
        if not ranked:
            return [], context
        from wildstring.lyric_quality import matched

        if not include_release and (
            matched(ranked[0])
            and all(
                row["title"]
                and row["artists"]
                and row.get("duration_ms")
                and not row["title"].endswith(("...", "…"))
                for row in ranked
            )
            and (
                len(ranked) == 1
                or ranked[0]["match"]["score"] - ranked[1]["match"]["score"] >= 0.05
            )
        ):
            return [row for row in ranked if matched(row)], context
        details = plugin.metadata(
            context, {"candidates": valid_candidates, "include_release": include_release}
        )
        if not isinstance(details, list):
            raise PluginError("source_plugin_invalid_response")
        valid_ids = {row["id"] for row in summaries}
        result = {}
        for row in details:
            try:
                detail = self.candidate(effective_track, row, full=True)
            except (PluginError, ValidationError):
                continue
            if detail["id"] in valid_ids:
                result[detail["id"]] = detail
        ranked = sorted(
            (result[row["id"]] for row in summaries if row["id"] in result),
            key=lambda row: -row["match"]["score"],
        )
        if not include_release:
            ranked = [row for row in ranked if matched(row)] or ranked
        return ranked, context

    @staticmethod
    def candidate(track, detail, *, full=False):
        if (
            not isinstance(detail, dict)
            or not isinstance(detail.get("id"), str)
            or not 1 <= len(detail["id"]) <= 300
        ):
            raise PluginError("source_plugin_invalid_response")
        url = detail.get("source_url", "")
        if not isinstance(url, str):
            raise PluginError("source_plugin_invalid_response")
        try:
            parsed = urlsplit(url)
        except ValueError:
            raise PluginError("source_plugin_invalid_response") from None
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
        if duration is not None and (type(duration) is not int or not 0 < duration <= 86_400_000):
            raise PluginError("source_plugin_invalid_response")
        values = (
            detail.get("fields")
            if full
            else {key: detail[key] for key in ("title", "artists", "album") if key in detail}
        )
        if not isinstance(values, dict):
            raise PluginError("source_plugin_invalid_response")
        fields = Overrides.model_validate(
            {key: value for key, value in values.items() if value not in (None, "", [])}
        ).model_dump(exclude_unset=True)
        detail = detail | {
            "fields": fields,
            "title": fields.get("title", ""),
            "artists": fields.get("artists", []),
        }
        return detail | {"match": matching(track, detail)}

    def available_lyric_sources(self):
        return [
            {"id": value["id"], "name": value["name"]}
            for value in self.catalog()
            if value["available"] and value["enabled"] and value["lyrics_enabled"]
        ]

    def suggestions(
        self,
        track,
        *,
        force=False,
        interactive=False,
        plugin_ids=None,
        query_title=None,
        query_artist=None,
    ):
        output, warnings = [], []
        selected = set(plugin_ids) if plugin_ids is not None else None
        configs = [
            config
            for config in self.catalog()
            if config["available"]
            and config["enabled"]
            and config["metadata_enabled"]
            and (selected is None or config["id"] in selected)
        ]
        if not configs:
            return output, warnings

        def fetch(config):
            candidates, context = self.candidates(
                track,
                config["id"],
                force=force,
                interactive=interactive,
                query_title=query_title,
                query_artist=query_artist,
            )
            self.current(config["id"], context.configuration["version"])
            return [
                (config["id"], row["source_url"], row["fields"], row.get("cover_url"), row["match"])
                for row in candidates
            ]

        with ThreadPoolExecutor(max_workers=max(1, len(configs))) as pool:
            futures = [
                (config, pool.submit(copy_context().run, fetch, config)) for config in configs
            ]
            for config, future in futures:
                try:
                    output.extend(future.result())
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

    def enqueue_lyrics(self, track_id, *, plugin_ids=None):
        LyricsEditor(self.providers.repository).read(track_id)
        sources = self.available_lyric_sources()
        if not sources:
            raise HTTPException(409, "source_plugins_disabled")
        options_json = None
        if plugin_ids is not None:
            normalized_ids = list(dict.fromkeys(plugin_ids))
            available_ids = {item["id"] for item in sources}
            if not normalized_ids or any(item not in available_ids for item in normalized_ids):
                raise HTTPException(422, "source_plugin_invalid_selection")
            options_json = json.dumps({"plugin_ids": normalized_ids})
        with self.database.connect(write=True) as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute(
                "SELECT id,status FROM lyric_lookup_jobs j WHERE track_id=? AND status IN ('queued','running') AND NOT EXISTS (SELECT 1 FROM lyric_scan_items i WHERE i.job_id=j.id)",
                (track_id,),
            ).fetchone()
            if row:
                if row["status"] == "queued":
                    db.execute(
                        "UPDATE lyric_lookup_jobs SET options=?,updated_at=? WHERE id=?",
                        (options_json, time.time(), row["id"]),
                    )
                return {"id": row[0], "status": "queued"}
            identity = uuid4().hex
            db.execute(
                "INSERT INTO lyric_lookup_jobs(id,track_id,status,error,warnings,created_at,updated_at,options) VALUES (?,?,'queued',NULL,'[]',?,?,?)",
                (identity, track_id, time.time(), time.time(), options_json),
            )
        return {"id": identity, "status": "queued"}

    def step(self):
        with self.database.connect(write=True) as db:
            db.execute("BEGIN IMMEDIATE")
            job = db.execute(
                "SELECT * FROM lyric_lookup_jobs j WHERE status='queued' AND NOT EXISTS (SELECT 1 FROM lyric_scan_items i WHERE i.job_id=j.id) ORDER BY created_at LIMIT 1"
            ).fetchone()
            if not job:
                return False
            db.execute(
                "UPDATE lyric_lookup_jobs SET status='running',updated_at=? WHERE id=?",
                (time.time(), job["id"]),
            )
        warnings = []
        try:
            from wildstring.library.scope import library_job_scope
            from wildstring.lyric_quality import matched, quality

            options = json.loads(job["options"]) if job["options"] else {}
            selected_ids = (
                set(options["plugin_ids"]) if options.get("plugin_ids") is not None else None
            )

            with library_job_scope(self.database, "lyric_lookup_jobs", job["id"], job["track_id"]):
                with self.database.connect(write=True) as db:
                    db.execute(
                        "DELETE FROM lyric_candidates WHERE track_id=? AND job_id IN (SELECT id FROM lyric_lookup_jobs WHERE status NOT IN ('queued','running','paused')) AND job_id NOT IN (SELECT id FROM lyric_lookup_jobs WHERE track_id=? ORDER BY created_at DESC LIMIT 5) AND id NOT IN (SELECT c2.id FROM lyric_candidates c2 WHERE c2.track_id=lyric_candidates.track_id AND c2.plugin_id=lyric_candidates.plugin_id ORDER BY c2.created_at DESC, c2.id DESC LIMIT 4) AND id NOT IN (SELECT json_extract(selected_candidate,'$.id') FROM track_lyrics WHERE selected_candidate IS NOT NULL) AND id NOT IN (SELECT candidate_id FROM lyric_scan_items WHERE candidate_id IS NOT NULL) AND id NOT IN (SELECT json_extract(previous,'$.selected_candidate.id') FROM lyric_scan_items WHERE json_extract(previous,'$.selected_candidate.id') IS NOT NULL)",
                        (job["track_id"], job["track_id"]),
                    )
                    db.execute(
                        "DELETE FROM lyric_lookup_jobs WHERE track_id=? AND status NOT IN ('queued','running','paused') AND id NOT IN (SELECT job_id FROM lyric_scan_items WHERE job_id IS NOT NULL) AND id NOT IN (SELECT id FROM lyric_lookup_jobs WHERE track_id=? ORDER BY created_at DESC LIMIT 5) AND id NOT IN (SELECT job_id FROM lyric_candidates)",
                        (job["track_id"], job["track_id"]),
                    )
                track = self.providers.repository.track(job["track_id"])
                record = LyricsEditor(self.providers.repository).read(job["track_id"])
                configs = [
                    config
                    for config in self.catalog()
                    if config["available"]
                    and config["enabled"]
                    and config["lyrics_enabled"]
                    and (selected_ids is None or config["id"] in selected_ids)
                ]

                def fetch(config):
                    candidates, context = self.candidates(
                        track, config["id"], include_release=False, interactive=True
                    )
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
                        if matched(candidate) and quality(normalized)["level"] >= 5:
                            break

                if configs:
                    with ThreadPoolExecutor(max_workers=max(1, len(configs))) as pool:
                        futures = [
                            (config, pool.submit(copy_context().run, fetch, config))
                            for config in configs
                        ]
                        for config, future in futures:
                            try:
                                future.result()
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
                    "SELECT * FROM lyric_lookup_jobs j WHERE track_id=? AND NOT EXISTS (SELECT 1 FROM lyric_scan_items i WHERE i.job_id=j.id) ORDER BY created_at DESC LIMIT 5",
                    (track_id,),
                )
            ]
            rows = [
                dict(row)
                for row in db.execute(
                    "SELECT * FROM lyric_candidates WHERE track_id=? ORDER BY created_at DESC LIMIT 50",
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
                -value["quality"]["level"],
                -value["quality"]["word_coverage"],
                -value["created_at"],
            )
        )
        return {"items": rows, "jobs": jobs, "sources": self.available_lyric_sources()}

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
        if file_version != row["file_version"] or file_version != body.file_version:
            raise HTTPException(409, "lyrics_version_conflict")
        if scan_item and (row["lyrics_version"] != body.version or current_version != body.version):
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
            return {"items": self.catalog(), "api_version": API_VERSION}

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
            remove_package_dir = False
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
                pkg = db.execute(
                    "SELECT sha256 FROM source_plugin_packages WHERE plugin_id=?", (identity,)
                ).fetchone()
                db.execute("DELETE FROM source_plugin_packages WHERE plugin_id=?", (identity,))
                db.execute("DELETE FROM source_plugin_settings WHERE plugin_id=?", (identity,))
                if pkg:
                    still_used = db.execute(
                        "SELECT 1 FROM source_plugin_packages WHERE sha256=? LIMIT 1", (pkg[0],)
                    ).fetchone()
                    remove_package_dir = still_used is None
            if remove_package_dir:
                shutil.rmtree(plugin.path, ignore_errors=True)
            shutil.rmtree(self.providers.directory / "plugin-state" / identity, ignore_errors=True)
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
            context.interactive = True
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
        def query(track_id: str, user=admin, body: Annotated[LyricQuery | None, Body()] = None):
            return self.enqueue_lyrics(track_id, plugin_ids=body.plugin_ids if body else None)

        @router.post("/manage/lyric-candidates/{identity}/apply", dependencies=mutation)
        def apply(identity: str, body: LyricChoice, user=admin):
            return self.apply(identity, body)

        return router
