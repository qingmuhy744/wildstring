"""Non-destructive ReplayGain, explicit analysis and per-user manual trim."""

import hashlib
import json
import math
import os
import re
import shutil
import subprocess
import time
from pathlib import Path
from tempfile import TemporaryFile
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from wildstring.library.assets import TrackAssets
from wildstring.library.scanner import fingerprint, open_source
from wildstring.library.tag_fields import TagReader


class GainSettings(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    version: int = Field(ge=0)
    mode: Literal["off", "track", "album"] = "off"
    preamp_db: float = Field(default=0, ge=-12, le=12, allow_inf_nan=False)
    prevent_clipping: bool = True


class GainAdjustment(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    version: int = Field(ge=0)
    scope: Literal["track", "album"]
    gain_db: float = Field(ge=-12, le=12, allow_inf_nan=False)


def number(value, minimum, maximum):
    try:
        match = re.match(r"^[+-]?(?:\d+(?:\.\d*)?|\.\d+)", str(value).strip())
        parsed = float(match[0]) if match else math.nan
        return parsed if math.isfinite(parsed) and minimum <= parsed <= maximum else None
    except (ValueError, TypeError):
        return None


def source_version(record):
    return hashlib.sha256(
        json.dumps([record["path"], record["size_bytes"], record["mtime_ns"]]).encode()
    ).hexdigest()


class Loudness:
    def __init__(self, repository, stopping):
        self.repository, self.database, self.stopping = repository, repository.database, stopping

    def settings(self, user_id):
        with self.database.connect() as db:
            row = db.execute(
                "SELECT * FROM playback_gain_settings WHERE user_id=?", (user_id,)
            ).fetchone()
        result = (
            dict(row)
            if row
            else {"mode": "off", "preamp_db": 0.0, "prevent_clipping": True, "version": 0}
        )
        result.pop("user_id", None)
        result["prevent_clipping"] = bool(result["prevent_clipping"])
        return result

    def save_settings(self, user_id, body):
        with self.database.connect(write=True) as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute(
                "SELECT version FROM playback_gain_settings WHERE user_id=?", (user_id,)
            ).fetchone()
            if (row[0] if row else 0) != body.version:
                raise HTTPException(409, "playback_gain_version_conflict")
            db.execute(
                "INSERT INTO playback_gain_settings VALUES (?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET mode=excluded.mode,preamp_db=excluded.preamp_db,prevent_clipping=excluded.prevent_clipping,version=excluded.version",
                (user_id, body.mode, body.preamp_db, body.prevent_clipping, body.version + 1),
            )
        return self.settings(user_id)

    def detail(self, user_id, track_id):
        track = self.repository.track(track_id)
        if not track:
            raise HTTPException(404, "track_not_found")
        _, audio = TrackAssets(self.repository).source(track_id)
        tags = TagReader(audio)
        observed = {}
        for field in ("track_gain", "album_gain", "track_peak", "album_peak"):
            values = tags.custom("replaygain_" + field, "REPLAYGAIN_" + field.upper())
            values = values or tags.custom("replaygain_" + field, "replaygain_" + field)
            observed[field] = (
                number(
                    values[0],
                    -60 if field.endswith("gain") else 0,
                    60 if field.endswith("gain") else 64,
                )
                if values
                else None
            )
        record = self.repository.source(track_id)
        with self.database.connect() as db:
            analysis = db.execute(
                "SELECT * FROM loudness_analysis WHERE track_id=?", (track_id,)
            ).fetchone()
            adjustments = {
                row["scope"]: dict(row)
                for row in db.execute(
                    "SELECT * FROM playback_gain_adjustments WHERE user_id=? AND ((scope='track' AND target_id=?) OR (scope='album' AND target_id=?))",
                    (user_id, track_id, track.get("album_id")),
                )
            }
        if (
            analysis
            and analysis["file_version"] == source_version(record)
            and analysis["status"] == "completed"
        ):
            for field in ("track_gain", "track_peak"):
                if observed[field] is None:
                    observed[field] = analysis[field]
        config = self.settings(user_id)
        manual = sum(value["gain_db"] for value in adjustments.values())
        gain, peak = observed["track_gain"], observed["track_peak"]
        selected = "track"
        if config["mode"] == "album" and observed["album_gain"] is not None:
            gain, peak, selected = observed["album_gain"], observed["album_peak"], "album"
        requested = manual + ((gain or 0) + config["preamp_db"] if config["mode"] != "off" else 0)
        factor = max(0.001, min(32, 10 ** (requested / 20)))
        if config["prevent_clipping"]:
            # Unknown peaks do not authorize positive amplification; analysis resolves this.
            factor = min(factor, 1 / peak if peak and peak > 0 else 1)
        return {
            "track_id": track_id,
            "album_id": track.get("album_id"),
            "settings": config,
            "tags": observed,
            "selected_mode": selected if config["mode"] != "off" else "off",
            "analysis": {"status": analysis["status"], "error": analysis["error"]}
            if analysis and analysis["file_version"] == source_version(record)
            else {"status": "none", "error": None},
            "track": {
                "gain_db": adjustments.get("track", {}).get("gain_db", 0),
                "version": adjustments.get("track", {}).get("version", 0),
            },
            "album": {
                "gain_db": adjustments.get("album", {}).get("gain_db", 0),
                "version": adjustments.get("album", {}).get("version", 0),
            },
            "requested_db": requested,
            "applied_db": 20 * math.log10(factor),
            "factor": factor,
            "limited": factor < 10 ** (requested / 20) - 1e-9,
            "peak_known": peak is not None,
        }

    def adjust(self, user_id, track_id, body):
        track = self.repository.track(track_id)
        if not track:
            raise HTTPException(404, "track_not_found")
        target = track_id if body.scope == "track" else track.get("album_id")
        if not target:
            raise HTTPException(422, "playback_gain_album_missing")
        with self.database.connect(write=True) as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute(
                "SELECT version FROM playback_gain_adjustments WHERE user_id=? AND scope=? AND target_id=?",
                (user_id, body.scope, target),
            ).fetchone()
            if (row[0] if row else 0) != body.version:
                raise HTTPException(409, "playback_gain_version_conflict")
            db.execute(
                "INSERT INTO playback_gain_adjustments VALUES (?,?,?,?,?) ON CONFLICT(user_id,scope,target_id) DO UPDATE SET gain_db=excluded.gain_db,version=excluded.version",
                (user_id, body.scope, target, body.gain_db, body.version + 1),
            )
        return self.detail(user_id, track_id)

    def enqueue(self, track_id):
        record = self.repository.source(track_id)
        if not record or record["status"] != "available":
            raise HTTPException(404, "track_not_found")
        if not shutil.which("ffmpeg"):
            raise HTTPException(409, "loudness_tool_missing")
        with self.database.connect(write=True) as db:
            db.execute(
                "INSERT INTO loudness_analysis VALUES (?,?,NULL,NULL,'queued',NULL,?) ON CONFLICT(track_id) DO UPDATE SET file_version=excluded.file_version,status='queued',error=NULL,updated_at=excluded.updated_at WHERE loudness_analysis.status NOT IN ('queued','running')",
                (track_id, source_version(record), time.time()),
            )
        return {"status": "queued"}

    def step(self):
        with self.database.connect(write=True) as db:
            db.execute("BEGIN IMMEDIATE")
            job = db.execute(
                "SELECT * FROM loudness_analysis WHERE status='queued' ORDER BY updated_at LIMIT 1"
            ).fetchone()
            if not job:
                return False
            db.execute(
                "UPDATE loudness_analysis SET status='running',updated_at=? WHERE track_id=?",
                (time.time(), job["track_id"]),
            )
        try:
            result = self.analyze(job["track_id"], job["file_version"])
            with self.database.connect(write=True) as db:
                db.execute(
                    "UPDATE loudness_analysis SET status='completed',track_gain=?,track_peak=?,error=NULL,updated_at=? WHERE track_id=? AND file_version=?",
                    (*result, time.time(), job["track_id"], job["file_version"]),
                )
        except Exception as error:
            code = error.detail if isinstance(error, HTTPException) else "loudness_analysis_failed"
            with self.database.connect(write=True) as db:
                db.execute(
                    "UPDATE loudness_analysis SET status='failed',error=?,updated_at=? WHERE track_id=?",
                    (code, time.time(), job["track_id"]),
                )
        return True

    def analyze(self, track_id, expected):
        record = self.repository.source(track_id)
        tool = shutil.which("ffmpeg")
        if not tool or source_version(record) != expected or os.name != "posix":
            raise HTTPException(409, "loudness_source_changed")
        process = None
        try:
            with (
                open_source(self.repository.root, Path(record["path"])) as source,
                TemporaryFile() as output,
            ):
                before = os.fstat(source.fileno())
                if (before.st_size, before.st_mtime_ns) != (
                    record["size_bytes"],
                    record["mtime_ns"],
                ):
                    raise HTTPException(409, "loudness_source_changed")
                process = subprocess.Popen(
                    [
                        tool,
                        "-hide_banner",
                        "-nostdin",
                        "-loglevel",
                        "info",
                        "-i",
                        f"/dev/fd/{source.fileno()}",
                        "-map",
                        "0:a:0",
                        "-vn",
                        "-af",
                        "loudnorm=I=-18:TP=-1:LRA=11:print_format=json",
                        "-f",
                        "null",
                        "-",
                    ],
                    stdout=subprocess.DEVNULL,
                    stderr=output,
                    pass_fds=(source.fileno(),),
                )
                deadline = time.monotonic() + 600
                while process.poll() is None:
                    if (
                        self.stopping.wait(0.2)
                        or time.monotonic() > deadline
                        or output.tell() > 1024 * 1024
                    ):
                        raise HTTPException(409, "loudness_analysis_interrupted")
                if process.returncode or fingerprint(os.fstat(source.fileno())) != fingerprint(
                    before
                ):
                    raise HTTPException(409, "loudness_source_changed")
                output.seek(0)
                text = output.read(1024 * 1024).decode(errors="replace")
                matches = re.findall(r'\{\s*"input_i".*?\}', text, re.DOTALL)
                data = json.loads(matches[-1])
                integrated, true_peak = (
                    number(data.get("input_i"), -100, 0),
                    number(data.get("input_tp"), -120, 24),
                )
                if integrated is None or true_peak is None:
                    raise HTTPException(409, "loudness_silence_or_invalid")
                return max(-60, min(60, -18 - integrated)), 10 ** (true_peak / 20)
        finally:
            if process is not None and process.poll() is None:
                process.kill()
                process.wait()

    def router(self, auth):
        router = APIRouter(prefix="/api/v1")
        member = Depends(auth.require_session)
        admin = Depends(auth.require_admin)
        mutation = [Depends(auth.require_client)]

        @router.get("/playback/gain-settings")
        def settings(user=member):
            return self.settings(user["id"])

        @router.put("/playback/gain-settings", dependencies=mutation)
        def save_settings(body: GainSettings, user=member):
            return self.save_settings(user["id"], body)

        @router.get("/tracks/{track_id}/playback-gain")
        def gain(track_id: str, user=member):
            return self.detail(user["id"], track_id) | {"can_analyze": user["role"] == "admin"}

        @router.put("/tracks/{track_id}/playback-gain", dependencies=mutation)
        def adjust(track_id: str, body: GainAdjustment, user=member):
            return self.adjust(user["id"], track_id, body)

        @router.post("/manage/tracks/{track_id}/analyze-loudness", dependencies=mutation)
        def analyze(track_id: str, user=admin):
            return self.enqueue(track_id)

        return router
