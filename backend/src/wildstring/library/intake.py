"""Source discovery, durable review items and deterministic import preparation."""

import json
import logging
import os
import shutil
import time
from dataclasses import asdict, replace
from pathlib import Path
from uuid import uuid4

from fastapi import HTTPException
from mutagen import MutagenError
from pydantic import BaseModel, ConfigDict, Field

from wildstring.library.conversion import convert
from wildstring.library.cue import parse_cue
from wildstring.library.edits import FIELDS, Overrides, apply_effective
from wildstring.library.import_files import copy_exclusive, digest, organized_path, target_digest
from wildstring.library.metadata import SUPPORTED_SUFFIXES, read_metadata
from wildstring.library.scanner import SourceChangedError, fingerprint, open_source

INPUT_SUFFIXES = SUPPORTED_SUFFIXES | {".wav"}
logger = logging.getLogger(__name__)


class IntakeSettings(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    version: int = Field(ge=1)
    enabled: bool
    interval_seconds: int = Field(ge=15, le=86400)
    stable_seconds: int = Field(ge=5, le=86400)


class IntakeApproval(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    version: int = Field(ge=1)
    overrides: Overrides


def problems(metadata):
    result = []
    if metadata.get("title_source") == "filename":
        result.append("missing_title")
    for name in ("artists", "album"):
        if not metadata.get(name):
            result.append(f"missing_{name}")
    return result


class Intake:
    def __init__(self, settings, repository):
        self.settings, self.repository = settings, repository
        self.database = repository.database
        self.root = settings.data_dir / "intake"

    def preferences(self):
        with self.database.connect() as connection:
            row = connection.execute(
                "SELECT enabled,interval_seconds,stable_seconds,version FROM intake_settings WHERE library_id=?",
                (self.repository.library_id(),),
            ).fetchone()
        return (
            {**dict(row), "enabled": bool(row["enabled"])}
            if row
            else {"enabled": False, "interval_seconds": 60, "stable_seconds": 120, "version": 1}
        )

    def configure(self, body):
        library_id = self.repository.library_id(create=True)
        with self.database.connect(write=True) as connection:
            connection.execute("BEGIN IMMEDIATE")
            connection.execute(
                "INSERT OR IGNORE INTO intake_settings(library_id) VALUES (?)", (library_id,)
            )
            result = connection.execute(
                "UPDATE intake_settings SET enabled=?,interval_seconds=?,stable_seconds=?,version=version+1 WHERE library_id=? AND version=?",
                (
                    body.enabled,
                    body.interval_seconds,
                    body.stable_seconds,
                    library_id,
                    body.version,
                ),
            )
            if not result.rowcount:
                raise HTTPException(409, "settings_version_conflict")
        return self.preferences()

    def item(self, item_id):
        with self.database.connect() as connection:
            row = connection.execute(
                "SELECT * FROM intake_items WHERE id=? AND library_id=?",
                (item_id, self.repository.library_id()),
            ).fetchone()
        if row is None:
            raise HTTPException(404, "intake_not_found")
        result = dict(row)
        for field in ("signature", "metadata", "issues", "overrides", "outputs"):
            result[field] = json.loads(result[field])
        return result

    def public(self, row):
        return {
            key: row[key]
            for key in (
                "id",
                "source_path",
                "state",
                "metadata",
                "issues",
                "overrides",
                "outputs",
                "version",
                "updated_at",
            )
        } | {
            "can_approve": bool(row["staged"])
            and row["state"] == "review"
            and not any(code.startswith(("cue_", "wav_", "flac_")) for code in row["issues"])
        }

    def items(self, limit=50, offset=0):
        with self.database.connect() as connection:
            parameters = (self.repository.library_id(),)
            total = connection.execute(
                "SELECT count(*) FROM intake_items WHERE library_id=? AND state NOT IN ('imported','ignored')",
                parameters,
            ).fetchone()[0]
            rows = connection.execute(
                "SELECT id FROM intake_items WHERE library_id=? AND state NOT IN ('imported','ignored') ORDER BY updated_at DESC,id LIMIT ? OFFSET ?",
                (*parameters, limit, offset),
            ).fetchall()
        return {
            "items": [self.public(self.item(row[0])) for row in rows],
            "total": total,
            "limit": limit,
            "offset": offset,
        }

    def paths(self):
        for directory, folders, files in os.walk(
            self.settings.music_dir,
            followlinks=False,
            onerror=lambda error: logger.warning("An import directory is unreadable"),
        ):
            folders[:] = sorted(
                name
                for name in folders
                if not (Path(directory) / name).is_symlink() and not name.startswith(".")
            )
            for name in sorted(files):
                path = Path(directory) / name
                if (
                    path.suffix.lower() in INPUT_SUFFIXES
                    and not path.is_symlink()
                    and not name.startswith(".")
                ):
                    yield path.relative_to(self.settings.music_dir)

    def signature(self, relative):
        with open_source(self.settings.music_dir, relative) as source:
            result = {"audio": list(fingerprint(os.fstat(source.fileno()))), "cues": []}
        # CUE and sidecar updates restart stability even when audio bytes are unchanged.
        parent = self.settings.music_dir / relative.parent
        for path in sorted(parent.iterdir()):
            if (
                path.suffix.lower() in {".cue", ".lrc", ".lryc", ".jpg", ".jpeg", ".png", ".webp"}
                and path.is_file()
                and not path.is_symlink()
            ):
                result["cues"].append([path.name, *fingerprint(path.stat())])
        return result

    def observe(self, relative, automatic):
        signature = self.signature(relative)
        encoded = json.dumps(signature)
        stamp = time.time()
        with self.database.connect(write=True) as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                "SELECT * FROM intake_items WHERE library_id=? AND source_root=? AND source_path=?",
                (self.repository.library_id(), str(self.settings.music_dir), relative.as_posix()),
            ).fetchone()
            if row is None:
                item_id = uuid4().hex
                connection.execute(
                    "INSERT INTO intake_items(id,library_id,source_root,source_path,signature,state,changed_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
                    (
                        item_id,
                        self.repository.library_id(),
                        str(self.settings.music_dir),
                        relative.as_posix(),
                        encoded,
                        "waiting" if automatic else "ready",
                        stamp,
                        stamp,
                    ),
                )
            else:
                item_id = row["id"]
                if json.loads(row["signature"]) != signature:
                    # An imported source changing never silently replaces a managed release.
                    state = (
                        "conflict"
                        if row["state"] in {"imported", "conflict"}
                        else "retry"
                        if row["state"] == "retry"
                        else "failed"
                        if row["state"] == "approved"
                        else "waiting"
                        if automatic
                        else "ready"
                    )
                    connection.execute(
                        "UPDATE intake_items SET signature=?,state=?,metadata='{}',issues=?,staged=NULL,staged_sha256=NULL,overrides='{}',version=version+1,changed_at=?,updated_at=? WHERE id=?",
                        (
                            encoded,
                            state,
                            json.dumps(
                                ["source_changed_managed_copy_preserved"]
                                if state == "conflict"
                                else ["intake_source_changed"]
                                if state == "failed"
                                else []
                            ),
                            stamp,
                            stamp,
                            item_id,
                        ),
                    )
        item = self.item(item_id)
        if item["state"] == "failed" and not automatic:
            self.update(item_id, state="ready")
            item = self.item(item_id)
        if item["state"] == "waiting" and (
            not automatic or stamp - item["changed_at"] >= self.preferences()["stable_seconds"]
        ):
            self.update(item_id, state="ready")
            item = self.item(item_id)
        return item

    def update(self, item_id, **fields):
        allowed = {"state", "metadata", "issues", "staged", "staged_sha256", "overrides", "outputs"}
        if not fields.keys() <= allowed:
            raise ValueError("Invalid intake fields")
        fields = {
            key: json.dumps(value, ensure_ascii=False)
            if key in {"metadata", "issues", "overrides", "outputs"}
            else value
            for key, value in fields.items()
        }
        with self.database.connect(write=True) as connection:
            connection.execute(
                f"UPDATE intake_items SET {','.join(key + '=?' for key in fields)},updated_at=? WHERE id=? AND library_id=?",  # nosec B608
                (*fields.values(), time.time(), item_id, self.repository.library_id()),
            )

    def has_work(self):
        with self.database.connect() as connection:
            approved = connection.execute(
                "SELECT id,source_path FROM intake_items WHERE library_id=? AND state IN ('approved','retry') AND source_root=?",
                (self.repository.library_id(), str(self.settings.music_dir)),
            ).fetchall()
        enabled = self.preferences()["enabled"]
        if not enabled and not approved:
            return False
        with os.scandir(self.settings.music_dir) as entries:
            next(entries, None)
        for row in approved:
            try:
                if self.observe(Path(row["source_path"]), True)["state"] in {"approved", "retry"}:
                    return True
            except FileNotFoundError:
                self.update(row["id"], state="failed", issues=["source_missing"])
        if not enabled:
            return False
        ready = False
        for path in self.paths():
            try:
                ready = self.observe(path, True)["state"] == "ready" or ready
            except OSError:
                logger.warning("An import file is unreadable")
        return ready

    def approve(self, item_id, body):
        item = self.item(item_id)
        if not self.public(item)["can_approve"]:
            raise HTTPException(409, "intake_not_reviewable")
        if target_digest(self.root, Path(item["staged"])) != item["staged_sha256"]:
            raise HTTPException(409, "intake_snapshot_changed")
        try:
            current_signature = self.signature(Path(item["source_path"]))
        except OSError:
            raise HTTPException(409, "intake_source_changed") from None
        if (
            item["source_root"] != str(self.settings.music_dir)
            or current_signature != item["signature"]
        ):
            raise HTTPException(409, "intake_source_changed")
        overrides = item["overrides"] | body.overrides.model_dump(exclude_unset=True)
        effective = item["metadata"] | overrides
        if "title" in overrides:
            effective["title_source"] = "user"
        if problems(effective):
            raise HTTPException(422, "intake_metadata_incomplete")
        if "album_artist_ambiguous" in item["issues"] and not effective.get("album_artists"):
            raise HTTPException(422, "intake_album_artist_required")
        with self.database.connect(write=True) as connection:
            result = connection.execute(
                "UPDATE intake_items SET state='approved',overrides=?,version=version+1,updated_at=? WHERE id=? AND library_id=? AND version=? AND state='review'",
                (
                    json.dumps(overrides, ensure_ascii=False),
                    time.time(),
                    item_id,
                    self.repository.library_id(),
                    body.version,
                ),
            )
            if not result.rowcount:
                raise HTTPException(409, "metadata_version_conflict")
        return self.public(self.item(item_id))

    def ignore(self, item_id, version):
        with self.database.connect(write=True) as connection:
            result = connection.execute(
                "UPDATE intake_items SET state='ignored',version=version+1,updated_at=? WHERE id=? AND library_id=? AND version=? AND state IN ('review','failed','waiting','conflict')",
                (time.time(), item_id, self.repository.library_id(), version),
            )
            if not result.rowcount:
                raise HTTPException(409, "metadata_version_conflict")
        return self.public(self.item(item_id))

    def cue_for(self, relative):
        found = []
        for cue in sorted((self.settings.music_dir / relative.parent).iterdir()):
            if cue.suffix.lower() != ".cue" or cue.is_symlink():
                continue
            with open_source(
                self.settings.music_dir, cue.relative_to(self.settings.music_dir)
            ) as stream:
                data = stream.read(512 * 1024 + 1)
            try:
                sheet = parse_cue(data)
            except (ValueError, IndexError):
                # A malformed CUE that explicitly references this image must not be ignored.
                if (
                    relative.name.encode("utf-8") in data
                    or relative.name.encode("gb18030", errors="replace") in data
                ):
                    raise ValueError("cue_invalid") from None
                continue
            tracks = [
                track for track in sheet.tracks if track.file.casefold() == relative.name.casefold()
            ]
            if tracks:
                found.append((sheet, tracks, data))
        if len(found) > 1 and any(found[0][0] != entry[0] for entry in found[1:]):
            raise ValueError("cue_conflicting_sheets")
        return found[0] if found else (None, [], None)

    def stage(self, importer, item, relative):
        if item["staged"] is not None:
            staged = Path(item["staged"])
            if target_digest(self.root, staged) != item["staged_sha256"]:
                raise ValueError("intake_snapshot_changed")
            return staged
        staged = Path(item["id"]) / str(item["version"]) / f"source{relative.suffix.lower()}"
        if not (self.root / staged).exists():
            self.check_space((self.settings.music_dir / relative).stat().st_size * 2)
            with open_source(self.settings.music_dir, relative) as source:
                sha = copy_exclusive(source, self.root, staged)
        else:
            sha = target_digest(self.root, staged)
            if item["staged_sha256"] and sha != item["staged_sha256"]:
                raise ValueError("intake_snapshot_changed")
        child = importer.__class__(self.settings, self.database)
        child.root = self.root
        child.import_sidecars(relative, staged)
        self.update(item["id"], staged=staged.as_posix(), staged_sha256=sha)
        return staged

    def check_space(self, required):
        self.root.mkdir(parents=True, exist_ok=True)
        for root in {self.root, self.settings.library_dir}:
            if shutil.disk_usage(root).free < required + 32 * 1024 * 1024:
                raise ValueError("insufficient_storage")

    def process(self, importer, relative, automatic=False):
        # Existing manifests retain the established source-change/managed-edit semantics.
        if importer.manifest(relative) is not None:
            target = importer.import_track(relative)
            item = self.observe(relative, automatic)
            if target is not None:
                self.update(
                    item["id"],
                    state="imported",
                    outputs=item["outputs"] or [{"path": target.as_posix(), "overrides": {}}],
                )
            else:
                self.update(
                    item["id"], state="conflict", issues=["source_changed_managed_copy_preserved"]
                )
            return
        item = self.observe(relative, automatic)
        if item["state"] in {"waiting", "review", "ignored", "failed", "conflict"}:
            importer.counts[
                "skipped"
                if item["state"] == "ignored"
                else "waiting"
                if item["state"] == "waiting"
                else "review"
            ] += 1
            return
        if item["state"] == "imported":
            if all(
                (self.settings.library_dir / output["path"]).is_file() for output in item["outputs"]
            ):
                importer.counts["unchanged"] += 1
            else:
                self.update(item["id"], state="conflict", issues=["managed_copy_missing"])
                importer.error(relative, "managed_copy_missing", conflict=True)
            return
        try:
            with open_source(self.settings.music_dir, relative) as source:
                metadata = read_metadata(source, relative)
            sheet, tracks, cue_data = self.cue_for(relative)
            overrides = dict(item["overrides"])
            if tracks and len(tracks) == 1:
                track = tracks[0]
                inferred = {
                    "title": track.title,
                    "artists": [track.performer or sheet.performer],
                    "album": sheet.title,
                    "album_artists": [sheet.performer],
                    "track_number": track.number,
                }
                for key, value in inferred.items():
                    current = getattr(metadata, key)
                    if (
                        (not current or key == "title" and metadata.title_source == "filename")
                        and value
                        and value != [""]
                    ):
                        overrides.setdefault(key, value)
            if not metadata.artists and metadata.album_artists:
                overrides.setdefault("artists", metadata.album_artists)
            effective = asdict(metadata) | overrides
            if "title" in overrides:
                effective["title_source"] = "user"
            image = bool(tracks and len(tracks) > 1)
            if image and metadata.format not in {"wav", "flac"}:
                raise ValueError("cue_lossy_image_unsupported")
            if image:
                sheet.title = sheet.title or metadata.album or ""
                same_artist = {track.performer for track in tracks if track.performer}
                sheet.performer = (
                    sheet.performer
                    or next(iter(metadata.album_artists), "")
                    or (next(iter(same_artist)) if len(same_artist) == 1 else "")
                )
                issues = (
                    []
                    if sheet.title
                    and sheet.performer
                    and all(t.title and (t.performer or sheet.performer) for t in tracks)
                    else ["cue_metadata_incomplete"]
                )
            else:
                issues = problems(effective)
            # Compilation fallback would otherwise scatter one source album among artists.
            if not effective["album_artists"] and not tracks:
                artists = set()
                for neighbor in (self.settings.music_dir / relative.parent).iterdir():
                    if (
                        neighbor.suffix.lower() in SUPPORTED_SUFFIXES
                        and not neighbor.is_symlink()
                        and not neighbor.name.startswith(".")
                    ):
                        try:
                            with open_source(
                                self.settings.music_dir,
                                neighbor.relative_to(self.settings.music_dir),
                            ) as stream:
                                other = read_metadata(stream, neighbor)
                        except (OSError, MutagenError, ValueError, TypeError, IndexError):
                            continue
                        if other.album == metadata.album:
                            artists.add(tuple(other.artists))
                if len(artists) > 1 and "album_artists" not in overrides:
                    issues.append("album_artist_ambiguous")
            self.update(item["id"], metadata=asdict(metadata), overrides=overrides)
            if issues and item["state"] != "approved":
                self.stage(importer, item, relative)
                self.update(item["id"], state="review", issues=issues)
                importer.counts["review"] += 1
                return
            if self.signature(relative) != item["signature"]:
                raise SourceChangedError
            if not image and relative.suffix.lower() != ".wav" and item["state"] != "approved":
                planned = organized_path(
                    replace(
                        metadata,
                        **{key: value for key, value in overrides.items() if key in FIELDS},
                    )
                )
                existing_hash = target_digest(self.settings.library_dir, planned)
                if existing_hash is not None:
                    with open_source(self.settings.music_dir, relative) as stream:
                        source_hash = digest(stream)
                    with self.database.connect() as connection:
                        known = connection.execute(
                            "SELECT 1 FROM imported_files WHERE target_root=? AND sha256=? LIMIT 1",
                            (str(self.settings.library_dir), source_hash),
                        ).fetchone()
                    if existing_hash != source_hash and not known:
                        self.stage(importer, item, relative)
                        self.update(item["id"], state="review", issues=["release_collision"])
                        importer.counts["review"] += 1
                        return
            if image or relative.suffix.lower() == ".wav":
                staged = self.stage(importer, item, relative)
                base = self.root / staged.parent
                if cue_data:
                    cue_path = base / "source.cue"
                    if not cue_path.exists():
                        cue_path.write_bytes(cue_data)
                self.check_space((self.root / staged).stat().st_size * 2)
                from tempfile import TemporaryDirectory

                with TemporaryDirectory(prefix="convert-", dir=base) as temporary:
                    with open_source(self.root, staged) as source:
                        outputs = convert(
                            source, Path(temporary), sheet if image else None, effective
                        )
                    for picture in base.iterdir():
                        if picture.is_file() and picture.suffix.lower() in {
                            ".jpg",
                            ".jpeg",
                            ".png",
                            ".webp",
                        }:
                            shutil.copyfile(
                                picture, Path(temporary) / f"cover{picture.suffix.lower()}"
                            )
                    prepared = importer.__class__(
                        self.settings.model_copy(update={"music_dir": Path(temporary)}),
                        self.database,
                    )
                    if item["state"] != "approved":
                        for output in outputs:
                            with output.open("rb") as stream:
                                planned = organized_path(read_metadata(stream, output))
                                candidate_hash = digest(stream)
                            existing_hash = target_digest(self.settings.library_dir, planned)
                            if existing_hash is not None and existing_hash != candidate_hash:
                                self.update(
                                    item["id"],
                                    state="review",
                                    issues=[
                                        "cue_release_collision" if image else "release_collision"
                                    ],
                                )
                                importer.counts["review"] += 1
                                return
                    published = []
                    for output in outputs:
                        target = prepared.import_track(output.relative_to(temporary))
                        if target is not None:
                            published.append({"path": target.as_posix(), "overrides": {}})
                    for key in importer.counts:
                        importer.counts[key] += prepared.counts[key]
                    importer.errors.extend(prepared.errors[: max(0, 100 - len(importer.errors))])
                    if len(published) != len(outputs):
                        raise ValueError("conversion_publish_failed")
                    # Transient generated paths must never remain as duplicate hash references.
                    with self.database.connect(write=True) as connection:
                        connection.execute(
                            "DELETE FROM imported_files WHERE source_root=? AND target_root=?",
                            (temporary, str(self.settings.library_dir)),
                        )
                    self.update(item["id"], state="imported", issues=[], outputs=published)
                    importer.counts["converted"] += len(published)
            elif item["state"] == "approved":
                staged = self.stage(importer, item, relative)
                prepared = importer.__class__(
                    self.settings.model_copy(update={"music_dir": self.root}), self.database
                )
                target = prepared.import_track(
                    staged,
                    metadata=replace(
                        metadata,
                        **{key: value for key, value in overrides.items() if key in FIELDS},
                    ),
                )
                for key in importer.counts:
                    importer.counts[key] += prepared.counts[key]
                if target is None:
                    raise ValueError("intake_publish_failed")
                with open_source(self.settings.music_dir, relative) as source:
                    info, sha = os.fstat(source.fileno()), digest(source)
                importer.save(relative, target, info, sha)
                self.update(
                    item["id"],
                    state="imported",
                    issues=[],
                    outputs=[{"path": target.as_posix(), "overrides": overrides}],
                )
            else:
                self.check_space((self.settings.music_dir / relative).stat().st_size)
                target = importer.import_track(
                    relative,
                    metadata=replace(
                        metadata,
                        **{key: value for key, value in overrides.items() if key in FIELDS},
                    ),
                )
                if target is not None:
                    self.update(
                        item["id"],
                        state="imported",
                        issues=[],
                        outputs=[{"path": target.as_posix(), "overrides": overrides}],
                    )
        except SourceChangedError:
            raise
        except (ValueError, OSError, MutagenError, TypeError, IndexError, OverflowError) as error:
            code = (
                str(error)
                if isinstance(error, ValueError) and str(error).replace("_", "").isalnum()
                else "intake_file_unavailable"
            )
            self.update(item["id"], state="failed", issues=[code])
            importer.error(relative, code)

    def apply_overrides(self):
        with self.database.connect(write=True) as connection:
            for item in connection.execute(
                "SELECT id,outputs FROM intake_items WHERE library_id=? AND state='imported'",
                (self.repository.library_id(),),
            ).fetchall():
                outputs = json.loads(item["outputs"])
                changed = False
                for output in outputs:
                    if not output["overrides"] or output.get("applied"):
                        continue
                    row = connection.execute(
                        "SELECT t.id,m.overrides FROM tracks t JOIN track_metadata m ON m.track_id=t.id WHERE t.library_id=? AND t.path=?",
                        (self.repository.library_id(), output["path"]),
                    ).fetchone()
                    if row and not json.loads(row["overrides"]):
                        connection.execute(
                            "UPDATE track_metadata SET overrides=?,version=version+1 WHERE track_id=?",
                            (json.dumps(output["overrides"], ensure_ascii=False), row["id"]),
                        )
                        apply_effective(connection, row["id"])
                    if row:
                        output["applied"] = True
                        changed = True
                if changed:
                    connection.execute(
                        "UPDATE intake_items SET outputs=? WHERE id=?",
                        (json.dumps(outputs, ensure_ascii=False), item["id"]),
                    )
