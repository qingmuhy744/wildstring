"""Service and handlers for uploading audio files and lyrics into managed library."""

import hashlib
import os
import shutil
from pathlib import Path
from tempfile import NamedTemporaryFile

from fastapi import HTTPException, UploadFile
from mutagen import MutagenError

from wildstring.config import Settings
from wildstring.database import Database
from wildstring.library.assets import IMAGE_SUFFIXES
from wildstring.library.import_files import copy_exclusive, organized_path, target_digest
from wildstring.library.intake import INPUT_SUFFIXES
from wildstring.library.lyrics import MAX_TEXT_BYTES
from wildstring.library.metadata import read_metadata
from wildstring.library.metadata_inference import enrich_metadata
from wildstring.library.scanner import scan_library

MAX_AUDIO_BYTES = 500 * 1024 * 1024  # 500 MB limit per audio file
LYRIC_SUFFIXES = {".lrc", ".lryc", ".txt"}


def sanitize_relative_path(raw: str, filename: str | None) -> Path:
    """Normalize client provided relative path and ensure it stays relative."""
    clean = (raw or "").replace("\\", "/").strip().lstrip("/")
    path = Path(clean)
    if ".." in path.parts:
        safe_parts = [p for p in path.parts if p and p != ".." and p != "."]
        path = Path(*safe_parts) if safe_parts else Path(filename or "unknown")
    if not path.parts or path.as_posix() in ("", "."):
        path = Path(filename or "unknown")
    return path


def save_upload_to_temp(file: UploadFile, directory: Path, max_bytes: int) -> tuple[Path, str, int]:
    """Stream an upload into a secure temporary file and compute its SHA256 digest."""
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    hasher = hashlib.sha256()
    size = 0
    with NamedTemporaryFile(dir=directory, prefix=".ws_upload_", delete=False) as temp:
        temp_path = Path(temp.name)
        try:
            while chunk := file.file.read(1024 * 1024):
                size += len(chunk)
                if size > max_bytes:
                    raise HTTPException(413, "file_too_large")
                hasher.update(chunk)
                temp.write(chunk)
            temp.flush()
            os.fsync(temp.fileno())
            return temp_path, hasher.hexdigest(), size
        except Exception:
            temp_path.unlink(missing_ok=True)
            raise


def find_matching_audio_target(
    database: Database, library_dir: Path, relative_sidecar: Path
) -> Path | None:
    """Find the target path of a companion audio track in the same relative folder."""
    stem = relative_sidecar.stem
    with database.connect() as db:
        # 1. Direct stem match (e.g. Song.lrc matching Song.mp3)
        rows = db.execute(
            "SELECT target_path FROM imported_files WHERE target_root=? AND source_path LIKE ? ORDER BY source_mtime DESC",
            (str(library_dir), f"%{stem}.%"),
        ).fetchall()
        for row in rows:
            target = Path(row["target_path"])
            if (library_dir / target).exists() and target.suffix.lower() in INPUT_SUFFIXES:
                return target

        # 2. Directory-level companion (e.g. cover.jpg / folder.png in album folder)
        parent_prefix = relative_sidecar.parent.as_posix()
        if parent_prefix and parent_prefix != ".":
            rows = db.execute(
                "SELECT target_path FROM imported_files WHERE target_root=? AND source_path LIKE ? ORDER BY source_mtime DESC",
                (str(library_dir), f"{parent_prefix}/%"),
            ).fetchall()
            for row in rows:
                target = Path(row["target_path"])
                if (library_dir / target).exists() and target.suffix.lower() in INPUT_SUFFIXES:
                    return target
    return None


def handle_upload(
    settings: Settings,
    database: Database,
    file: UploadFile,
    relative_path_raw: str = "",
    *,
    override_artist: str | None = None,
    override_album: str | None = None,
    auto_scan: bool = False,
) -> dict:
    """Process an uploaded audio or sidecar file and organize it into library_dir."""
    filename = file.filename or "unknown"
    relative_path = sanitize_relative_path(relative_path_raw, filename)
    suffix = relative_path.suffix.lower()
    temp_dir = settings.data_dir / ".upload_tmp"

    # 1. Lyric or sidecar upload
    if suffix in LYRIC_SUFFIXES or suffix in IMAGE_SUFFIXES:
        temp_path, sha256, size = save_upload_to_temp(
            file, temp_dir, MAX_TEXT_BYTES if suffix in LYRIC_SUFFIXES else 15 * 1024 * 1024
        )
        try:
            matched_audio = find_matching_audio_target(
                database, settings.library_dir, relative_path
            )
            if matched_audio:
                stem = relative_path.stem.lower()
                if stem in ("cover", "folder", "front") and suffix in IMAGE_SUFFIXES:
                    target_file = matched_audio.parent / f"cover{suffix}"
                else:
                    target_file = matched_audio.with_suffix(suffix)
                dest = settings.library_dir / target_file
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(temp_path, dest)
                target_str = target_file.as_posix()
            else:
                # Place in relative path inside library_dir
                dest = settings.library_dir / relative_path
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(temp_path, dest)
                target_str = relative_path.as_posix()

            return {
                "status": "imported",
                "kind": "sidecar",
                "filename": filename,
                "relative_path": relative_path.as_posix(),
                "target_path": target_str,
                "sha256": sha256,
            }
        finally:
            temp_path.unlink(missing_ok=True)

    # 2. Audio upload
    if suffix not in INPUT_SUFFIXES:
        raise HTTPException(400, f"unsupported_audio_format: {suffix}")

    temp_path, sha256, size = save_upload_to_temp(file, temp_dir, MAX_AUDIO_BYTES)
    try:
        with open(temp_path, "rb") as stream:
            try:
                observed = read_metadata(stream, relative_path)
            except (MutagenError, ValueError, TypeError) as err:
                raise HTTPException(400, "metadata_invalid") from err

            metadata = enrich_metadata(
                observed,
                relative_path,
                override_artist=override_artist,
                override_album=override_album,
            )

            # Check duplicate in database by hash
            with database.connect() as db:
                duplicate = db.execute(
                    "SELECT target_path FROM imported_files WHERE target_root=? AND sha256=? LIMIT 1",
                    (str(settings.library_dir), sha256),
                ).fetchone()

            if duplicate is not None:
                return {
                    "status": "duplicate",
                    "filename": filename,
                    "relative_path": relative_path.as_posix(),
                    "target_path": duplicate["target_path"],
                    "title": metadata.title,
                    "artist": "、".join(metadata.artists),
                    "album": metadata.album,
                    "track_number": metadata.track_number,
                    "disc_number": metadata.disc_number,
                    "sha256": sha256,
                }

            # Find exclusive target path
            base_target = organized_path(metadata)
            chosen_target = None
            for length in (0, 8, 16, 32, 64):
                candidate = (
                    base_target
                    if length == 0
                    else base_target.with_name(
                        f"{base_target.stem} [{sha256[:length]}]{base_target.suffix}"
                    )
                )
                existing = target_digest(settings.library_dir, candidate)
                if existing == sha256:
                    chosen_target = candidate
                    break
                if existing is None:
                    copy_exclusive(stream, settings.library_dir, candidate, sha256)
                    chosen_target = candidate
                    break
            else:
                raise HTTPException(409, "target_collision")

            # Record in imported_files table
            with database.connect(write=True) as db:
                db.execute(
                    "INSERT OR REPLACE INTO imported_files VALUES (?,?,?,?,?,?,?)",
                    (
                        "upload",
                        relative_path.as_posix(),
                        str(settings.library_dir),
                        chosen_target.as_posix(),
                        size,
                        int(temp_path.stat().st_mtime_ns),
                        sha256,
                    ),
                )

        if auto_scan:
            scan_library(settings)

        return {
            "status": "imported",
            "filename": filename,
            "relative_path": relative_path.as_posix(),
            "target_path": chosen_target.as_posix(),
            "title": metadata.title,
            "artist": "、".join(metadata.artists),
            "album": metadata.album,
            "track_number": metadata.track_number,
            "disc_number": metadata.disc_number,
            "duration_ms": metadata.duration_ms,
            "sha256": sha256,
        }
    finally:
        temp_path.unlink(missing_ok=True)
