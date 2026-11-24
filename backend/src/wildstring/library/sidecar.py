"""Portable, content-bound public metadata. Source directories are only read."""

import hashlib
import json
import os
import re
from collections import defaultdict
from contextlib import suppress
from pathlib import Path
from uuid import uuid4

from fastapi import HTTPException
from pydantic import ValidationError

from wildstring.books.ebooks import normalized_image
from wildstring.library.assets import MAX_COVER_BYTES, TrackAssets
from wildstring.library.edits import Overrides, apply_effective
from wildstring.library.import_files import digest, target_directory
from wildstring.library.lyrics import MAX_TEXT_BYTES
from wildstring.library.repository import LibraryRepository
from wildstring.library.scanner import open_source

DIRECTORY = ".wildstring"
MUSIC = "wildstring.sidecar.music.v1"
BOOK = "wildstring.sidecar.book.v1"
MAX_MANIFEST = 2 * 1024 * 1024
MARKUP = re.compile(r"<\s*/?\s*[a-z!]", re.I)
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
    "external_ids",
)


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


def read_manifest(root, folder, schema):
    data = read_asset(root, folder / DIRECTORY / "manifest.json", MAX_MANIFEST)
    if data is None:
        return None
    try:
        manifest = json.loads(data)
    except (ValueError, RecursionError):
        return None
    return manifest if isinstance(manifest, dict) and manifest.get("schema") == schema else None


def cover_asset(root, folder, manifest):
    expected = manifest.get("cover_sha256")
    if manifest.get("cover_file") != "cover.jpg" or not isinstance(expected, str):
        return None
    payload = read_asset(root, folder / DIRECTORY / "cover.jpg", MAX_COVER_BYTES)
    if payload is None or hashlib.sha256(payload).hexdigest() != expected:
        return None
    try:
        return normalized_image(payload)
    except (OSError, ValueError):
        return None


def commit_manifest(root, folder, manifest, cover):
    sidecar = folder / DIRECTORY
    if cover:
        manifest.update(cover_file="cover.jpg", cover_sha256=hashlib.sha256(cover).hexdigest())
    data = json.dumps(manifest, ensure_ascii=False, indent=2).encode()
    if len(data) > MAX_MANIFEST:
        raise ValueError("sidecar_manifest_too_large")
    if cover:
        write_asset(root, sidecar / "cover.jpg", cover)
    write_asset(root, sidecar / "manifest.json", data)


def album_folder(relative):
    return (
        relative.parent.parent
        if re.fullmatch(r"CD\d+", relative.parent.name, re.I)
        else relative.parent
    )


def portable_values(raw):
    fields = {}
    for key in TRACK_FIELDS:
        value = raw.get(key)
        if key in {"track_number", "disc_number"}:
            if type(value) is int and 1 <= value <= 99999:
                fields[key] = value
        elif key in {"artists", "album_artists"}:
            if isinstance(value, list) and len(value) <= 100 and all(map(clean_text, value)):
                fields[key] = value
        elif key == "external_ids":
            if isinstance(value, dict) and len(value) <= 50:
                fields[key] = {k: v for k, v in value.items() if clean_text(k) and clean_text(v)}
        elif clean_text(value):
            fields[key] = value
    return fields


def export_music(database, root, library_id, folders=None):
    with database.connect(scoped=False) as db:
        rows = db.execute(
            """SELECT t.id,t.path,t.title,t.artists,t.album,t.album_artists,t.track_number,
                      t.disc_number,coalesce(json_extract(m.overrides,'$.external_ids'),
                      json_extract(m.observed,'$.external_ids'),'{}') AS external_ids,
                      m.overrides,ll.text AS lyric
               FROM tracks t LEFT JOIN track_metadata m ON m.track_id=t.id
                 LEFT JOIN track_lyrics ll ON ll.track_id=t.id
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
    for folder, tracks in albums.items():
        values = []
        for row in tracks:
            try:
                with open_source(root, Path(row["path"])) as stream:
                    media_hash = digest(stream)
            except OSError:
                continue
            effective = dict(row)
            for key in ("artists", "album_artists", "external_ids"):
                effective[key] = json.loads(effective[key])
            entry = portable_values(effective)
            entry["sha256"] = media_hash
            entry["locked_fields"] = sorted(set(json.loads(row["overrides"] or "{}")) & set(entry))
            lyric = row["lyric"]
            if isinstance(lyric, str) and not MARKUP.search(lyric):
                text = lyric.encode()
                if len(text) <= MAX_TEXT_BYTES:
                    relative = Path("lyrics") / f"{media_hash}.lrc"
                    write_asset(root, folder / DIRECTORY / relative, text)
                    entry["lyric_file"] = relative.as_posix()
            values.append(entry)
        if values:
            result = None
            with suppress(HTTPException):
                result = assets.cover(tracks[0]["id"], size=768)
            commit_manifest(
                root, folder, {"schema": MUSIC, "tracks": values}, result[0] if result else None
            )
            published += 1
    return published


def restore_music_track(database, library_root, library_id, relative, source_root, folder):
    manifest = read_manifest(source_root, folder, MUSIC)
    if manifest is None or not isinstance(manifest.get("tracks"), list):
        return False
    with open_source(library_root, relative) as stream:
        media_hash = digest(stream)
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
    lyric = None
    lyrics_file = Path("lyrics") / f"{media_hash}.lrc"
    if entry.get("lyric_file") == lyrics_file.as_posix():
        data = read_asset(source_root, folder / DIRECTORY / lyrics_file, MAX_TEXT_BYTES)
        with suppress(UnicodeDecodeError):
            lyric = data.decode("utf-8") if data is not None else None
    jpeg = cover_asset(source_root, folder, manifest)
    with database.connect(write=True) as db:
        db.execute("BEGIN IMMEDIATE")
        row = db.execute(
            """SELECT t.id,m.overrides FROM tracks t JOIN track_metadata m ON m.track_id=t.id
               WHERE t.library_id=? AND t.path=?""",
            (library_id, relative.as_posix()),
        ).fetchone()
        if row is None:
            return False
        overrides = json.loads(row["overrides"])
        try:
            incoming = Overrides.model_validate(fields).model_dump(exclude_unset=True)
        except ValidationError:
            incoming = {}
        effective = incoming | overrides
        if effective != overrides:
            db.execute(
                "UPDATE track_metadata SET overrides=?,version=version+1 WHERE track_id=?",
                (json.dumps(effective, ensure_ascii=False), row["id"]),
            )
            apply_effective(db, row["id"])
        if lyric is not None and not MARKUP.search(lyric):
            db.execute(
                "INSERT OR IGNORE INTO track_lyrics(track_id,text) VALUES (?,?)",
                (row["id"], lyric),
            )
        if jpeg:
            key = hashlib.sha256(jpeg).hexdigest()
            write_asset(database.path.parent, Path("artwork") / key, jpeg)
            db.execute(
                """INSERT OR IGNORE INTO artwork_choices(track_id,filename,source_url,mode)
                   VALUES (?,?,'wildstring-sidecar','chosen')""",
                (row["id"], key),
            )
    return True


def export_books(database, root, library_id, book_id=None):
    with database.connect(scoped=False) as db:
        books = db.execute(
            "SELECT * FROM books WHERE library_id=? AND (? IS NULL OR id=?)",
            (library_id, book_id, book_id),
        ).fetchall()
        for row in books:
            identity = row["id"]
            manifest = {"schema": BOOK}
            manifest.update({key: row[key] for key in BOOK_TEXT if clean_text(row[key])})
            for key, column in BOOK_ARRAY.items():
                manifest[key] = [value for value in json.loads(row[column]) if clean_text(value)]
            for key in ("series_index", "published_year"):
                if row[key] is not None:
                    manifest[key] = row[key]
            manifest["locked_fields"] = [
                key for key in json.loads(row["locked_fields_json"]) if key in manifest
            ]
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
            cover = (
                read_asset(root, Path(row["cover_path"]), MAX_COVER_BYTES)
                if row["cover_path"]
                else None
            )
            commit_manifest(root, Path(row["managed_dir"]), manifest, cover)
        return len(books)


def restore_book(database, library_root, book_id, source_root, folder):
    manifest = read_manifest(source_root, folder, BOOK)
    if manifest is None:
        return False
    with database.connect(write=True) as db:
        db.execute("BEGIN IMMEDIATE")
        book = db.execute("SELECT * FROM books WHERE id=?", (book_id,)).fetchone()
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
        fields = {}
        for key in BOOK_TEXT:
            if key not in locked and clean_text(manifest.get(key)):
                fields[key] = manifest[key]
        for key, column in BOOK_ARRAY.items():
            value = manifest.get(key)
            if key not in locked and isinstance(value, list) and all(map(clean_text, value)):
                fields[column] = json.dumps(value, ensure_ascii=False)
        for key in ("series_index", "published_year"):
            value = manifest.get(key)
            if key not in locked and type(value) is int and 0 <= value <= 9999:
                fields[key] = value
        incoming_locks = manifest.get("locked_fields")
        if isinstance(incoming_locks, list):
            locked.update(
                key
                for key in incoming_locks
                if isinstance(key, str)
                and key in set(BOOK_TEXT) | set(BOOK_ARRAY) | {"series_index", "published_year"}
            )
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
    for (root, library_id), albums in folders.items():
        with suppress(OSError, ValueError):
            export_music(repository.database, root, library_id, albums)
