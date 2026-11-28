"""Portable, content-bound public metadata. Source directories are only read."""

import hashlib
import io
import json
import os
import re
from collections import defaultdict
from contextlib import suppress
from pathlib import Path
from uuid import uuid4

from fastapi import HTTPException
from filelock import FileLock, Timeout
from PIL import Image, UnidentifiedImageError
from pydantic import ValidationError

from wildstring.books.ebooks import normalized_image
from wildstring.library.assets import MAX_COVER_BYTES, TrackAssets
from wildstring.library.edits import Overrides, apply_effective
from wildstring.library.fs import open_source
from wildstring.library.import_files import digest, target_directory
from wildstring.library.lyric_edits import LyricsText, lyric_text
from wildstring.library.lyrics import MAX_TEXT_BYTES, parse_lyrics
from wildstring.library.metadata import normalize
from wildstring.library.online_lyrics import (
    build_portable_lyric_bundle,
    display_lyrics,
    normalize_bundle,
    selected_lyrics,
)
from wildstring.library.repository import LibraryRepository
from wildstring.library.tag_fields import DETAIL_DEFAULTS

DIRECTORY = ".wildstring"
MUSIC = "wildstring.sidecar.music.v1"
BOOK = "wildstring.sidecar.book.v1"
LYRIC_BUNDLE = "wildstring.sidecar.lyrics.v1"
MAX_MANIFEST = 2 * 1024 * 1024
MAX_LYRIC_BUNDLE = 2 * 1024 * 1024
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_TRACK_COVER_RE = re.compile(r"^covers/[0-9a-f]{64}\.jpg$")
MARKUP = re.compile(
    r"<\s*(?:/\s*)?(?:script|iframe|object|embed|svg|style|link|meta|html|body|form|input)\b|javascript:",
    re.I,
)
ABSOLUTE_PATH = re.compile(r"^(?:/[A-Za-z0-9._~-]+/|[A-Za-z]:[\\/]|\\\\[^\\]+\\)")
BOOK_TEXT = (
    "title",
    "sort_title",
    "subtitle",
    "series_name",
    "publisher",
    "language",
    "isbn10",
    "isbn13",
    "description",
)
BOOK_ARRAY = {"authors": "authors_json", "narrators": "narrators_json", "tags": "tags_json"}
TRACK_FIELDS = (
    "title",
    "artists",
    "album",
    "album_artists",
    "track_number",
    "disc_number",
    "artist_credit",
    "album_artist_credit",
    "composers",
    "lyricists",
    "arrangers",
    "vocalists",
    "genres",
    "tags",
    "track_total",
    "disc_total",
    "release_date",
    "original_date",
    "label",
    "catalog_number",
    "external_ids",
    "description",
)
_STRING_LIST_FIELDS = {
    "artists",
    "album_artists",
    "composers",
    "lyricists",
    "arrangers",
    "vocalists",
    "genres",
    "tags",
}
_INT_FIELDS = {"track_number", "disc_number", "track_total", "disc_total"}


def clean_text(value):
    return (
        isinstance(value, str)
        and len(value) <= 16000
        and "\x00" not in value
        and not MARKUP.search(value)
        and not ABSOLUTE_PATH.search(value)
    )


def read_asset(root, relative, limit):
    try:
        with open_source(root, relative) as stream:
            value = stream.read(limit + 1)
            return value if len(value) <= limit else None
    except OSError:
        return None


def write_asset(root, relative, payload):
    temp_name = f".wildstring-asset-{uuid4().hex}"
    with target_directory(root, relative) as descriptor:
        temporary = temp_name if descriptor is not None else root / relative.with_name(temp_name)
        name = relative.name if descriptor is not None else root / relative
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=descriptor)
        try:
            with os.fdopen(fd, "wb") as stream:
                stream.write(payload)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, name, src_dir_fd=descriptor, dst_dir_fd=descriptor)
        finally:
            with suppress(FileNotFoundError):
                os.unlink(temporary, dir_fd=descriptor)


def _unlink_asset(root: Path, relative: Path) -> None:
    with suppress(OSError), target_directory(root, relative) as descriptor:
        target = relative.name if descriptor is not None else root / relative
        with suppress(FileNotFoundError):
            os.unlink(target, dir_fd=descriptor)


def remove_sidecar_dir(root: Path, folder: Path) -> None:
    sidecar = root / folder / DIRECTORY
    if not sidecar.is_dir() or sidecar.is_symlink():
        return
    for subdir in ("lyrics", "covers"):
        nested = sidecar / subdir
        if nested.is_dir() and not nested.is_symlink():
            for child in list(nested.iterdir()):
                if not child.is_symlink():
                    with suppress(OSError):
                        child.unlink()
            with suppress(OSError):
                nested.rmdir()
    for child in list(sidecar.iterdir()):
        if child.is_file() and not child.is_symlink():
            with suppress(OSError):
                child.unlink()
    with suppress(OSError):
        sidecar.rmdir()


def read_manifest(root, folder, schema):
    data = read_asset(root, folder / DIRECTORY / "manifest.json", MAX_MANIFEST)
    if data is None:
        return None
    try:
        manifest = json.loads(data)
    except (ValueError, RecursionError):
        return None
    return manifest if isinstance(manifest, dict) and manifest.get("schema") == schema else None


def _validate_image_bytes(payload: bytes) -> bytes | None:
    if not payload or len(payload) > MAX_COVER_BYTES:
        return None
    try:
        with Image.open(io.BytesIO(payload)) as original:
            if (
                original.format not in {"JPEG", "PNG", "WEBP"}
                or original.width * original.height > 24_000_000
            ):
                return None
            original.load()
        return payload
    except (OSError, ValueError, UnidentifiedImageError, Image.DecompressionBombError):
        return None


def ensure_jpeg_cover(payload: bytes) -> bytes | None:
    if not _validate_image_bytes(payload):
        return None
    try:
        with Image.open(io.BytesIO(payload)) as original:
            exif = original.getexif()
            orientation = exif.get(274, 1) if exif else 1
            if (
                original.format == "JPEG"
                and original.width <= 1600
                and original.height <= 1600
                and orientation == 1
                and original.mode in {"RGB", "L"}
            ):
                return payload
    except (OSError, ValueError, UnidentifiedImageError, Image.DecompressionBombError):
        return None
    try:
        return normalized_image(payload)
    except (OSError, ValueError):
        return None


def verified_cover_bytes(
    root: Path, folder: Path, rel_name: str, expected_sha: str, *, reencode: bool
) -> bytes | None:
    if rel_name != "cover.jpg" and not _TRACK_COVER_RE.fullmatch(rel_name):
        return None
    if not isinstance(expected_sha, str) or not _SHA256_RE.fullmatch(expected_sha):
        return None
    payload = read_asset(root, folder / DIRECTORY / rel_name, MAX_COVER_BYTES)
    if payload is None or hashlib.sha256(payload).hexdigest() != expected_sha:
        return None
    if reencode:
        try:
            return normalized_image(payload)
        except (OSError, ValueError):
            return None
    return _validate_image_bytes(payload)


def cover_asset(root, folder, manifest):
    cover_file = manifest.get("cover_file")
    expected = manifest.get("cover_sha256")
    if cover_file != "cover.jpg" or not isinstance(expected, str):
        return None
    return verified_cover_bytes(root, folder, "cover.jpg", expected, reencode=True)


def commit_manifest(root, folder, manifest, cover):
    sidecar = folder / DIRECTORY
    if cover:
        manifest.update(cover_file="cover.jpg", cover_sha256=hashlib.sha256(cover).hexdigest())
    else:
        _unlink_asset(root, sidecar / "cover.jpg")
    data = json.dumps(manifest, ensure_ascii=False, indent=2).encode()
    if len(data) > MAX_MANIFEST:
        raise ValueError("sidecar_manifest_too_large")
    if cover:
        write_asset(root, sidecar / "cover.jpg", cover)
    write_asset(root, sidecar / "manifest.json", data)
    with suppress(OSError), open_source(root, sidecar / "manifest.json") as stream:
        stat = os.fstat(stream.fileno())
        return stat.st_mtime_ns, hashlib.sha256(data).hexdigest()
    return None, hashlib.sha256(data).hexdigest()


def album_folder(relative):
    return (
        relative.parent.parent
        if re.fullmatch(r"(?:CD|Disc)\s*\d+", relative.parent.name, re.I)
        else relative.parent
    )


def _clean_external_ids(value) -> dict | None:
    if not isinstance(value, dict) or len(value) > 50:
        return None
    cleaned = {}
    for k, v in value.items():
        if not clean_text(k):
            continue
        if isinstance(v, list):
            items = [item for item in v[:50] if clean_text(item)]
            if items:
                cleaned[k] = items
        elif clean_text(v):
            cleaned[k] = v
    return cleaned


def portable_values(raw):
    fields = {}
    for key in TRACK_FIELDS:
        value = raw.get(key)
        if key in _INT_FIELDS:
            if type(value) is int and 1 <= value <= 99999:
                fields[key] = value
        elif key in _STRING_LIST_FIELDS:
            if isinstance(value, list) and len(value) <= 100 and all(map(clean_text, value)):
                fields[key] = value
        elif key == "external_ids":
            cleaned = _clean_external_ids(value)
            if cleaned is not None:
                fields[key] = cleaned
        elif clean_text(value):
            fields[key] = value
    return fields


def _cleanup_stale_subdir(root: Path, folder: Path, subdir: str, keep_files: set[str]) -> None:
    target_dir = root / folder / DIRECTORY / subdir
    if not target_dir.is_dir() or target_dir.is_symlink():
        return
    for entry in list(target_dir.iterdir()):
        if (
            entry.is_file()
            and not entry.is_symlink()
            and f"{subdir}/{entry.name}" not in keep_files
        ):
            with suppress(OSError):
                entry.unlink()
    with suppress(OSError):
        target_dir.rmdir()


def _track_sha256(
    database,
    root: Path,
    track_id: str | None,
    relative: Path,
    size_bytes: int | None = None,
    mtime_ns: int | None = None,
    cached_sha: str | None = None,
) -> str:
    with open_source(root, relative) as stream:
        before = os.fstat(stream.fileno())
        if (
            isinstance(cached_sha, str)
            and _SHA256_RE.fullmatch(cached_sha)
            and size_bytes == before.st_size
            and mtime_ns == before.st_mtime_ns
        ):
            return cached_sha
        media_hash = digest(stream)
        after = os.fstat(stream.fileno())
        if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
            raise OSError("source_changed_while_hashing")
    if track_id:
        with database.connect(write=True) as db:
            db.execute(
                "UPDATE tracks SET sha256=? WHERE id=? AND size_bytes=? AND mtime_ns=?",
                (media_hash, track_id, after.st_size, after.st_mtime_ns),
            )
    return media_hash


def _bundle_has_markup(value) -> bool:
    if isinstance(value, str):
        return bool(MARKUP.search(value))
    if isinstance(value, list):
        return any(_bundle_has_markup(item) for item in value)
    if isinstance(value, dict):
        return any(_bundle_has_markup(k) or _bundle_has_markup(v) for k, v in value.items())
    return False


def _bundle_has_rich_data(bundle: dict) -> bool:
    if bundle.get("layers"):
        return True
    if bundle.get("format", "lrc") != "lrc":
        return True
    return any(
        line.get("end_ms") is not None or bool(line.get("words"))
        for line in bundle.get("lines", [])
    )


def _parse_lyric_bundle_bytes(data: bytes) -> dict | None:
    if len(data) > MAX_LYRIC_BUNDLE:
        return None
    try:
        raw = json.loads(data)
    except (ValueError, RecursionError):
        return None
    if not isinstance(raw, dict) or raw.get("schema") != LYRIC_BUNDLE:
        return None
    if _bundle_has_markup(raw):
        return None
    candidate_input = {key: raw[key] for key in ("kind", "format", "lines", "layers") if key in raw}
    try:
        validated = normalize_bundle({"normalized": candidate_input}, "wildstring-sidecar")
    except ValueError:
        return None
    result = {
        "schema": LYRIC_BUNDLE,
        "kind": validated["kind"],
        "format": validated.get("format", "lrc"),
        "source": validated["source"],
        "lines": validated["lines"],
    }
    if validated.get("layers"):
        result["layers"] = validated["layers"]
    for extra_key, limit in (("source_id", 256), ("source_url", 1024)):
        val = raw.get(extra_key)
        if clean_text(val) and len(val) <= limit:
            result[extra_key] = val
    return result


def read_music_sidecar_lyrics(
    database,
    root: Path,
    track_id: str | None,
    relative: Path,
    size_bytes: int,
    mtime_ns: int,
    cached_sha: str | None,
) -> dict | None:
    folder = album_folder(relative)
    manifest = read_manifest(root, folder, MUSIC)
    if manifest is None or not isinstance(manifest.get("tracks"), list):
        return None
    try:
        media_hash = _track_sha256(
            database, root, track_id, relative, size_bytes, mtime_ns, cached_sha
        )
    except OSError:
        return None
    entry = next(
        (
            item
            for item in manifest["tracks"]
            if isinstance(item, dict) and item.get("sha256") == media_hash
        ),
        None,
    )
    if entry is None:
        return None
    bundle_rel = Path("lyrics") / f"{media_hash}.json"
    if entry.get("lyric_bundle_file") == bundle_rel.as_posix():
        raw_bundle = read_asset(root, folder / DIRECTORY / bundle_rel, MAX_LYRIC_BUNDLE)
        if raw_bundle is not None:
            bundle = _parse_lyric_bundle_bytes(raw_bundle)
            if bundle is not None:
                return display_lyrics(bundle)
    lrc_rel = Path("lyrics") / f"{media_hash}.lrc"
    if entry.get("lyric_file") == lrc_rel.as_posix():
        raw_lrc = read_asset(root, folder / DIRECTORY / lrc_rel, MAX_TEXT_BYTES)
        if raw_lrc is not None:
            with suppress(UnicodeDecodeError, ValidationError):
                decoded = raw_lrc.decode("utf-8")
                if not MARKUP.search(decoded):
                    valid_text = LyricsText(text=decoded).text
                    if valid_text is not None:
                        return parse_lyrics(valid_text, "wildstring-sidecar")
    return None


def _cleanup_artwork_blobs(
    database, candidate_keys: set[str], exported_track_ids: set[str]
) -> None:
    for key in candidate_keys:
        if not _SHA256_RE.fullmatch(key):
            continue
        with database.connect(scoped=False) as db:
            rows = db.execute(
                "SELECT track_id, source_url FROM artwork_choices WHERE filename=?",
                (key,),
            ).fetchall()
            if any(
                row["track_id"] not in exported_track_ids
                or row["source_url"] not in {"upload", "wildstring-sidecar"}
                for row in rows
            ):
                continue
            pending = db.execute(
                "SELECT 1 FROM agent_drafts WHERE kind='cover' AND status='pending' "
                "AND json_extract(payload, '$.image_sha256')=? LIMIT 1",
                (key,),
            ).fetchone()
            if pending is not None:
                continue
        _unlink_asset(database.path.parent, Path("artwork") / key)


def _export_track_cover(
    database,
    root: Path,
    assets: TrackAssets,
    folder: Path,
    row,
    media_hash: str,
    fallback_folders: list[Path] = (),
    previous_hashes: tuple[str | None, ...] = (),
) -> tuple[bytes | None, bool, str | None]:
    choice = row["cover_choice"]
    if isinstance(choice, str) and _SHA256_RE.fullmatch(choice):
        cleanup_key = choice if row["cover_source"] in {"upload", "wildstring-sidecar"} else None
        filenames = [
            f"covers/{value}.jpg"
            for value in dict.fromkeys((media_hash, row["sha256"], *previous_hashes))
            if value
        ]
        for search_folder in (folder, *fallback_folders):
            for rel_name in (*filenames, "cover.jpg"):
                reused = verified_cover_bytes(root, search_folder, rel_name, choice, reencode=False)
                if reused is not None:
                    return reused, True, cleanup_key
        raw_path = database.path.parent / "artwork" / choice
        try:
            raw_bytes = raw_path.read_bytes()
        except OSError:
            raw_bytes = b""
        jpeg = ensure_jpeg_cover(raw_bytes) if raw_bytes else None
        if jpeg is not None:
            return jpeg, True, cleanup_key
    local = None
    with suppress(HTTPException):
        local = assets.local_cover(row["id"], size=768)
    return (local[0], False, None) if local else (None, False, None)


def export_music(database, root, library_id, folders=None, *, previous_hashes=None):
    with database.connect(scoped=False) as db:
        rows = db.execute(
            """SELECT t.id,t.path,t.size_bytes,t.mtime_ns,t.sha256,
                      t.title,t.artists,t.album,t.album_artists,t.track_number,
                      t.disc_number,t.extra,m.observed,m.overrides,
                      ll.text AS lyric,ll.selected_candidate,ll.portable_bundle,
                      a.filename AS cover_choice,a.source_url AS cover_source
               FROM tracks t LEFT JOIN track_metadata m ON m.track_id=t.id
                 LEFT JOIN track_lyrics ll ON ll.track_id=t.id
                 LEFT JOIN artwork_choices a ON a.track_id=t.id
               WHERE t.library_id=? AND t.status='available' ORDER BY t.path""",
            (library_id,),
        ).fetchall()
    albums = defaultdict(list)
    for row in rows:
        folder = album_folder(Path(row["path"]))
        if folders is None or folder in folders:
            albums[folder].append(row)
    assets = TrackAssets(LibraryRepository(database, root, fixed=True))
    published = 0
    cleanup_artwork_keys: set[str] = set()
    exported_track_ids: set[str] = set()
    empty_folders = [folder for folder in (folders or ()) if not albums.get(folder)]
    for folder, tracks in albums.items():
        values = []
        keep_lyrics: set[str] = set()
        keep_covers: set[str] = set()
        album_locks: set[str] = set()
        track_covers: list[tuple[dict, str, bytes | None, bool, str | None]] = []
        for row in tracks:
            try:
                media_hash = _track_sha256(
                    database,
                    root,
                    row["id"],
                    Path(row["path"]),
                    row["size_bytes"],
                    row["mtime_ns"],
                    row["sha256"],
                )
            except OSError:
                continue
            override_dict = json.loads(row["overrides"] or "{}")
            extra = DETAIL_DEFAULTS | json.loads(row["extra"] or "{}")
            effective = extra | {
                "title": row["title"],
                "artists": json.loads(row["artists"] or "[]"),
                "album": row["album"],
                "album_artists": json.loads(row["album_artists"] or "[]"),
                "track_number": row["track_number"],
                "disc_number": row["disc_number"],
            }
            entry = portable_values(effective)
            entry["sha256"] = media_hash
            locked = sorted(set(override_dict) & set(entry))
            entry["locked_fields"] = locked
            album_locks.update(key for key in locked if key in {"album", "album_artists"})

            bundle = None
            lyric = row["lyric"]
            if row["selected_candidate"]:
                with database.connect(scoped=False) as db:
                    cand = selected_lyrics(db, row["selected_candidate"])
                if cand is not None:
                    with suppress(ValueError):
                        bundle = build_portable_lyric_bundle(
                            cand,
                            source_id=cand.get("source_id"),
                            source_url=cand.get("source_url"),
                        )
                    if lyric is None:
                        lyric = lyric_text(cand)
            if bundle is None and row["portable_bundle"]:
                with suppress(ValueError, KeyError, TypeError):
                    parsed = json.loads(row["portable_bundle"])
                    if isinstance(parsed, dict) and parsed.get("schema") == LYRIC_BUNDLE:
                        bundle = parsed
                        if lyric is None:
                            lyric = lyric_text(bundle)
            if isinstance(lyric, str) and not MARKUP.search(lyric):
                text = lyric.encode("utf-8")
                if len(text) <= MAX_TEXT_BYTES:
                    relative = Path("lyrics") / f"{media_hash}.lrc"
                    write_asset(root, folder / DIRECTORY / relative, text)
                    entry["lyric_file"] = relative.as_posix()
                    keep_lyrics.add(relative.as_posix())
            if (
                bundle is not None
                and _bundle_has_rich_data(bundle)
                and not _bundle_has_markup(bundle)
            ):
                bundle_bytes = json.dumps(bundle, ensure_ascii=False).encode("utf-8")
                if len(bundle_bytes) <= MAX_LYRIC_BUNDLE:
                    bundle_rel = Path("lyrics") / f"{media_hash}.json"
                    write_asset(root, folder / DIRECTORY / bundle_rel, bundle_bytes)
                    entry["lyric_bundle_file"] = bundle_rel.as_posix()
                    keep_lyrics.add(bundle_rel.as_posix())

            cover_bytes, is_custom, cleanup_key = _export_track_cover(
                database,
                root,
                assets,
                folder,
                row,
                media_hash,
                empty_folders,
                (previous_hashes or {}).get(row["path"], ()),
            )
            track_covers.append((entry, media_hash, cover_bytes, is_custom, cleanup_key))
            values.append(entry)

        _cleanup_stale_subdir(root, folder, "lyrics", keep_lyrics)
        if values:
            album_cover = next(
                (cb for _, _, cb, is_custom, _ in track_covers if is_custom and cb),
                next((cb for _, _, cb, _, _ in track_covers if cb), None),
            )
            album_cover_sha = hashlib.sha256(album_cover).hexdigest() if album_cover else None
            for idx, (entry, media_hash, cover_bytes, is_custom, cleanup_key) in enumerate(
                track_covers
            ):
                row_id = tracks[idx]["id"]
                if is_custom and cover_bytes:
                    exported_track_ids.add(row_id)
                    if cleanup_key:
                        cleanup_artwork_keys.add(cleanup_key)
                    track_sha = hashlib.sha256(cover_bytes).hexdigest()
                    if track_sha != album_cover_sha:
                        cov_rel = Path("covers") / f"{media_hash}.jpg"
                        write_asset(root, folder / DIRECTORY / cov_rel, cover_bytes)
                        entry["cover_file"] = cov_rel.as_posix()
                        entry["cover_sha256"] = track_sha
                        keep_covers.add(cov_rel.as_posix())
            _cleanup_stale_subdir(root, folder, "covers", keep_covers)
            manifest: dict = {"schema": MUSIC, "tracks": values}
            if clean_text(values[0].get("album")):
                manifest["album"] = values[0]["album"]
            if values[0].get("album_artists"):
                manifest["album_artists"] = values[0]["album_artists"]
            if album_locks:
                manifest["locked_fields"] = sorted(album_locks)
            mtime_ns, manifest_sha = commit_manifest(root, folder, manifest, album_cover)
            if mtime_ns is not None:
                save_sidecar_state(database, library_id, folder, mtime_ns, manifest_sha)
            published += 1
    for folder in empty_folders:
        remove_sidecar_dir(root, folder)
        with database.connect(write=True) as db:
            db.execute(
                "DELETE FROM music_sidecar_states WHERE library_id=? AND folder=?",
                (library_id, folder.as_posix()),
            )
    if cleanup_artwork_keys:
        _cleanup_artwork_blobs(database, cleanup_artwork_keys, exported_track_ids)
    return published


def read_music_sidecar_fields(
    source_root: Path, relative: Path, media_hash: str
) -> tuple[dict, set[str]]:
    """Read whitelisted public metadata for one source audio file from .wildstring if present."""
    for folder in dict.fromkeys((album_folder(relative), relative.parent)):
        manifest = read_manifest(source_root, folder, MUSIC)
        if manifest is None or not isinstance(manifest.get("tracks"), list):
            continue
        entry = next(
            (
                item
                for item in manifest["tracks"]
                if isinstance(item, dict) and item.get("sha256") == media_hash
            ),
            None,
        )
        if entry is None:
            continue
        fields = portable_values(entry)
        locked = (
            set(entry["locked_fields"])
            if isinstance(entry.get("locked_fields"), list)
            else set(fields)
        )
        if isinstance(manifest.get("locked_fields"), list):
            locked.update(manifest["locked_fields"])
        return fields, locked
    return {}, set()


def _validate_override_fields(fields: dict) -> dict:
    validated: dict = {}
    for key, value in fields.items():
        try:
            dumped = Overrides.model_validate({key: value}).model_dump(exclude_unset=True)
        except ValidationError:
            continue
        validated.update(dumped)
    return validated


def _extract_sidecar_lyrics(source_root: Path, folder: Path, entry: dict, media_hash: str):
    lyric = None
    bundle = None
    lyrics_file = Path("lyrics") / f"{media_hash}.lrc"
    if entry.get("lyric_file") == lyrics_file.as_posix():
        data = read_asset(source_root, folder / DIRECTORY / lyrics_file, MAX_TEXT_BYTES)
        if data is not None:
            with suppress(UnicodeDecodeError, ValidationError):
                decoded = data.decode("utf-8")
                if not MARKUP.search(decoded):
                    lyric = LyricsText(text=decoded).text
    bundle_file = Path("lyrics") / f"{media_hash}.json"
    if entry.get("lyric_bundle_file") == bundle_file.as_posix():
        raw_bundle = read_asset(source_root, folder / DIRECTORY / bundle_file, MAX_LYRIC_BUNDLE)
        if raw_bundle is not None:
            bundle = _parse_lyric_bundle_bytes(raw_bundle)
            if bundle is not None and lyric is None:
                lyric = lyric_text(bundle)
    return lyric, bundle


def _extract_sidecar_cover(
    source_root: Path, folder: Path, manifest: dict, entry: dict, media_hash: str, *, reencode: bool
) -> bytes | None:
    expected_track_rel = f"covers/{media_hash}.jpg"
    if entry.get("cover_file") == expected_track_rel and isinstance(entry.get("cover_sha256"), str):
        cov = verified_cover_bytes(
            source_root, folder, expected_track_rel, entry["cover_sha256"], reencode=reencode
        )
        if cov is not None:
            return cov
    if manifest.get("cover_file") == "cover.jpg" and isinstance(manifest.get("cover_sha256"), str):
        return verified_cover_bytes(
            source_root, folder, "cover.jpg", manifest["cover_sha256"], reencode=reencode
        )
    return None


def restore_music_track(
    database,
    library_root,
    library_id,
    relative,
    source_root,
    folder,
    *,
    sync_unlocked: bool = False,
):
    manifest = read_manifest(source_root, folder, MUSIC)
    if manifest is None or not isinstance(manifest.get("tracks"), list):
        return False
    with database.connect(scoped=False) as db:
        row = db.execute(
            """SELECT t.id,t.size_bytes,t.mtime_ns,t.sha256,m.overrides
               FROM tracks t JOIN track_metadata m ON m.track_id=t.id
               WHERE t.library_id=? AND t.path=?""",
            (library_id, relative.as_posix()),
        ).fetchone()
    if row is None:
        return False
    try:
        media_hash = _track_sha256(
            database,
            library_root,
            row["id"],
            relative,
            row["size_bytes"],
            row["mtime_ns"],
            row["sha256"],
        )
    except OSError:
        return False
    entry = next(
        (
            item
            for item in manifest["tracks"]
            if isinstance(item, dict) and item.get("sha256") == media_hash
        ),
        None,
    )
    if entry is None:
        return False
    fields = portable_values(entry)
    if isinstance(entry.get("locked_fields"), list):
        wanted_keys = set(entry["locked_fields"])
        if isinstance(manifest.get("locked_fields"), list):
            wanted_keys.update(manifest["locked_fields"])
        fields = {key: val for key, val in fields.items() if key in wanted_keys}
    lyric, bundle = _extract_sidecar_lyrics(source_root, folder, entry, media_hash)
    external_source = Path(source_root).resolve() != Path(library_root).resolve()
    jpeg = _extract_sidecar_cover(
        source_root, folder, manifest, entry, media_hash, reencode=external_source
    )
    bundle_json = json.dumps(bundle, ensure_ascii=False) if bundle is not None else None
    has_local_cover = None
    if not jpeg and sync_unlocked:
        assets = TrackAssets(LibraryRepository(database, library_root, fixed=True))
        with suppress(HTTPException):
            has_local_cover = 1 if assets.local_cover(row["id"], 96) is not None else 0
    if jpeg and external_source:
        key = hashlib.sha256(jpeg).hexdigest()
        write_asset(database.path.parent, Path("artwork") / key, jpeg)

    with database.connect(write=True) as db:
        db.execute("BEGIN IMMEDIATE")
        latest = db.execute(
            "SELECT m.overrides FROM track_metadata m WHERE m.track_id=?",
            (row["id"],),
        ).fetchone()
        if latest is None:
            return False
        overrides = json.loads(latest["overrides"])
        incoming = _validate_override_fields(fields)
        effective = incoming | overrides
        if effective != overrides:
            db.execute(
                "UPDATE track_metadata SET overrides=?,version=version+1 WHERE track_id=?",
                (json.dumps(effective, ensure_ascii=False), row["id"]),
            )
            apply_effective(db, row["id"])

        locked_row = db.execute(
            "SELECT locked FROM lyric_locks WHERE track_id=?", (row["id"],)
        ).fetchone()
        existing_lyric = db.execute(
            "SELECT text, selected_candidate, portable_bundle FROM track_lyrics WHERE track_id=?",
            (row["id"],),
        ).fetchone()
        if existing_lyric is None:
            if lyric is not None or bundle_json is not None:
                db.execute(
                    "INSERT INTO track_lyrics(track_id,text,portable_bundle) VALUES (?,?,?)",
                    (row["id"], lyric, bundle_json),
                )
        elif sync_unlocked and not (locked_row and locked_row[0]):
            if lyric is not None or bundle_json is not None:
                if (existing_lyric["text"], existing_lyric["portable_bundle"]) != (
                    lyric,
                    bundle_json,
                ):
                    db.execute(
                        "UPDATE track_lyrics SET text=?,portable_bundle=?,selected_candidate=NULL,version=version+1 "
                        "WHERE track_id=?",
                        (lyric, bundle_json, row["id"]),
                    )
            elif existing_lyric["selected_candidate"] is None and (
                existing_lyric["text"] is not None or existing_lyric["portable_bundle"] is not None
            ):
                db.execute(
                    "UPDATE track_lyrics SET text=NULL,portable_bundle=NULL,version=version+1 WHERE track_id=?",
                    (row["id"],),
                )

        existing_art = db.execute(
            "SELECT filename, source_url FROM artwork_choices WHERE track_id=?",
            (row["id"],),
        ).fetchone()
        if jpeg:
            key = hashlib.sha256(jpeg).hexdigest()
            if existing_art is None:
                db.execute(
                    """INSERT INTO artwork_choices(track_id,filename,source_url,mode)
                       VALUES (?,?,'wildstring-sidecar','chosen')""",
                    (row["id"], key),
                )
                db.execute("UPDATE tracks SET has_cover=1 WHERE id=?", (row["id"],))
            elif (
                sync_unlocked
                and existing_art["source_url"] == "wildstring-sidecar"
                and existing_art["filename"] != key
            ):
                db.execute(
                    "UPDATE artwork_choices SET filename=?,version=version+1 WHERE track_id=?",
                    (key, row["id"]),
                )
                db.execute("UPDATE tracks SET has_cover=1 WHERE id=?", (row["id"],))
        elif sync_unlocked and existing_art and existing_art["source_url"] == "wildstring-sidecar":
            db.execute("DELETE FROM artwork_choices WHERE track_id=?", (row["id"],))
            db.execute(
                "UPDATE tracks SET has_cover=? WHERE id=?", (has_local_cover or 0, row["id"])
            )

    if external_source:
        export_music(database, library_root, library_id, {album_folder(relative)})
    return True


def load_sidecar_states(database, library_id: str | None) -> dict[str, tuple[int, str]]:
    if not library_id:
        return {}
    with database.connect(scoped=False) as db:
        rows = db.execute(
            "SELECT folder, manifest_mtime_ns, manifest_sha256 FROM music_sidecar_states WHERE library_id=?",
            (library_id,),
        ).fetchall()
    return {row["folder"]: (row["manifest_mtime_ns"], row["manifest_sha256"]) for row in rows}


def inspect_folder_sidecar(
    root: Path, folder: Path, known: tuple[int, str] | None
) -> tuple[str, int | None, str | None]:
    manifest_rel = folder / DIRECTORY / "manifest.json"
    try:
        with open_source(root, manifest_rel) as stream:
            before = os.fstat(stream.fileno())
            if known is not None and before.st_mtime_ns == known[0]:
                return "unchanged", before.st_mtime_ns, known[1]
            data = stream.read(MAX_MANIFEST + 1)
            if len(data) > MAX_MANIFEST:
                return ("removed" if known is not None else "absent"), None, None
            sha = hashlib.sha256(data).hexdigest()
            if known is not None and sha == known[1]:
                return "touched", before.st_mtime_ns, sha
            return "changed", before.st_mtime_ns, sha
    except OSError:
        return ("removed" if known is not None else "absent"), None, None


def save_sidecar_state(database, library_id: str, folder: Path, mtime_ns: int, sha256: str) -> None:
    with database.connect(write=True) as db:
        db.execute(
            """INSERT INTO music_sidecar_states(library_id, folder, manifest_mtime_ns, manifest_sha256)
               VALUES (?,?,?,?)
               ON CONFLICT(library_id, folder) DO UPDATE SET
                   manifest_mtime_ns=excluded.manifest_mtime_ns,
                   manifest_sha256=excluded.manifest_sha256""",
            (library_id, folder.as_posix(), mtime_ns, sha256),
        )


def clear_removed_sidecar(database, root: Path, library_id: str, folder: Path) -> None:
    assets = TrackAssets(LibraryRepository(database, root, fixed=True))
    with database.connect(scoped=False) as db:
        tracks = db.execute(
            """SELECT t.id, t.path, a.source_url FROM tracks t
               LEFT JOIN artwork_choices a ON a.track_id=t.id
               WHERE t.library_id=? AND t.status='available'""",
            (library_id,),
        ).fetchall()
    folder_tracks = [row for row in tracks if album_folder(Path(row["path"])) == folder]
    has_local: dict[str, int] = {}
    for row in folder_tracks:
        if row["source_url"] == "wildstring-sidecar":
            has_local[row["id"]] = 0
            with suppress(HTTPException):
                has_local[row["id"]] = 1 if assets.local_cover(row["id"], 96) is not None else 0
    with database.connect(write=True) as db:
        db.execute("BEGIN IMMEDIATE")
        db.execute(
            "DELETE FROM music_sidecar_states WHERE library_id=? AND folder=?",
            (library_id, folder.as_posix()),
        )
        for tid, local_flag in has_local.items():
            db.execute(
                "DELETE FROM artwork_choices WHERE track_id=? AND source_url='wildstring-sidecar'",
                (tid,),
            )
            db.execute("UPDATE tracks SET has_cover=? WHERE id=?", (local_flag, tid))


def export_books(database, root, library_id, book_id=None):
    with database.connect(scoped=False) as db:
        books = db.execute(
            "SELECT * FROM books WHERE library_id=? AND (? IS NULL OR id=?)",
            (library_id, book_id, book_id),
        ).fetchall()
        for row in books:
            identity = row["id"]
            manifest = {"schema": BOOK}
            manifest.update(
                {key: row[key] for key in BOOK_TEXT if key != "sort_title" and clean_text(row[key])}
            )
            for key, column in BOOK_ARRAY.items():
                manifest[key] = [value for value in json.loads(row[column]) if clean_text(value)]
            for key in ("series_index", "published_year"):
                if row[key] is not None:
                    manifest[key] = row[key]
            locks = json.loads(row["locked_fields_json"])
            for key in locks:
                if (
                    key
                    in (set(BOOK_TEXT) - {"title", "sort_title"})
                    | {"series_index", "published_year"}
                    and row[key] is None
                ):
                    manifest[key] = None
            manifest["locked_fields"] = [key for key in locks if key in manifest]
            ebook = db.execute(
                "SELECT format,sha256 FROM book_ebooks WHERE book_id=?", (identity,)
            ).fetchone()
            if ebook is not None:
                manifest["ebook"] = dict(ebook)
            audio = db.execute(
                "SELECT file_index,sha256 FROM book_audiobook_files WHERE book_id=? ORDER BY file_index",
                (identity,),
            ).fetchall()
            if audio:
                rows = db.execute(
                    """SELECT chapter_index,file_index,title,start_file_ms,end_file_ms
                       FROM book_audiobook_chapters WHERE book_id=? ORDER BY chapter_index""",
                    (identity,),
                )
                manifest["audiobook"] = {
                    "files": [dict(item) for item in audio],
                    "chapters": [dict(item) for item in rows if clean_text(item["title"])],
                }
            raw_cover = (
                read_asset(root, Path(row["cover_path"]), MAX_COVER_BYTES)
                if row["cover_path"]
                else None
            )
            cover = None
            if raw_cover is not None:
                with suppress(OSError, ValueError):
                    cover = normalized_image(raw_cover)
            commit_manifest(root, Path(row["managed_dir"]), manifest, cover)
        return len(books)


def restore_book(database, library_root, book_id, source_root, folder):
    manifest = read_manifest(source_root, folder, BOOK)
    if manifest is None:
        return False
    with database.connect(write=True) as db:
        db.execute("BEGIN IMMEDIATE")
        book = db.execute("SELECT * FROM books WHERE id=?", (book_id,)).fetchone()
        if book is None:
            return False
        ebook = db.execute("SELECT sha256 FROM book_ebooks WHERE book_id=?", (book_id,)).fetchone()
        audio = db.execute(
            "SELECT sha256 FROM book_audiobook_files WHERE book_id=? ORDER BY file_index",
            (book_id,),
        ).fetchall()
        ebook_entry = manifest.get("ebook")
        audio_entry = manifest.get("audiobook")
        audio_files = audio_entry.get("files") if isinstance(audio_entry, dict) else None
        audio_matches = (
            bool(audio)
            and isinstance(audio_files, list)
            and (
                [item.get("sha256") for item in audio_files if isinstance(item, dict)]
                == [row[0] for row in audio]
            )
        )
        ebook_matches = (
            ebook and isinstance(ebook_entry, dict) and ebook_entry.get("sha256") == ebook[0]
        )
        if not (ebook_matches or audio_matches):
            return False
        locked = set(json.loads(book["locked_fields_json"]))
        protected = locked | set(json.loads(book["overrides_json"] or "{}"))
        fields: dict = {}
        for key in BOOK_TEXT:
            if key == "sort_title":
                continue
            if key not in protected and clean_text(manifest.get(key)):
                fields[key] = manifest[key]
        if "title" in fields:
            fields["sort_title"] = normalize(fields["title"])
        for key, column in BOOK_ARRAY.items():
            value = manifest.get(key)
            if key not in protected and isinstance(value, list) and all(map(clean_text, value)):
                fields[column] = json.dumps(value, ensure_ascii=False)
        for key in ("series_index", "published_year"):
            value = manifest.get(key)
            numeric_types = (int, float) if key == "series_index" else (int,)
            if key not in protected and type(value) in numeric_types and 0 <= value <= 9999:
                fields[key] = value
        incoming_locks = manifest.get("locked_fields")
        if isinstance(incoming_locks, list):
            nullable = (set(BOOK_TEXT) - {"title", "sort_title"}) | {
                "series_index",
                "published_year",
            }
            for key in incoming_locks:
                if not isinstance(key, str):
                    continue
                if (
                    key in nullable
                    and key not in protected
                    and key in manifest
                    and manifest[key] is None
                ):
                    fields[key] = None
                if key in nullable or key == "title" or key in BOOK_ARRAY:
                    locked.add(key)
        fields["locked_fields_json"] = json.dumps(sorted(locked))
        if fields:
            sql = ",".join(f"{key}=?" for key in fields)
            db.execute(f"UPDATE books SET {sql} WHERE id=?", (*fields.values(), book_id))  # nosec B608
        cover = cover_asset(source_root, folder, manifest)
        if cover and not book["cover_path"]:
            relative = Path(book["managed_dir"]) / "cover.jpg"
            write_asset(library_root, relative, cover)
            db.execute(
                "UPDATE books SET cover_path=?,cover_hash=? WHERE id=?",
                (relative.as_posix(), hashlib.sha256(cover).hexdigest(), book_id),
            )
        if audio_matches and isinstance(audio_entry.get("chapters"), list):
            for chapter in audio_entry["chapters"]:
                if (
                    isinstance(chapter, dict)
                    and clean_text(chapter.get("title"))
                    and type(chapter.get("chapter_index")) is int
                ):
                    db.execute(
                        """UPDATE book_audiobook_chapters SET title=? WHERE book_id=?
                           AND chapter_index=? AND file_index=? AND start_file_ms=? AND end_file_ms=?""",
                        (
                            chapter["title"],
                            book_id,
                            chapter["chapter_index"],
                            chapter.get("file_index"),
                            chapter.get("start_file_ms"),
                            chapter.get("end_file_ms"),
                        ),
                    )
    return True


def refresh_music_track(repository, track_id):
    refresh_music_tracks(repository, (track_id,))


def refresh_music_tracks(repository, track_ids):
    folders = defaultdict(set)
    for track_id in track_ids:
        source = repository.source(track_id)
        if source is not None:
            root = Path(source["library_root"])
            folders[(root, source["library_id"])].add(album_folder(Path(source["path"])))
    if not folders:
        return
    lock = FileLock(repository.database.path.parent / "library-scan.lock", timeout=2)
    with suppress(Timeout), lock:
        for (root, library_id), albums in folders.items():
            with suppress(OSError, ValueError):
                export_music(repository.database, root, library_id, albums)
