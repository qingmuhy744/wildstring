"""Ingest library files without editing the original ebook or audio."""

import base64
import binascii
import hashlib
import json
import logging
import os
import re
import shutil
import subprocess
import time
from contextlib import contextmanager, suppress
from pathlib import Path
from uuid import uuid4

import mutagen
from defusedxml import ElementTree
from defusedxml.common import DefusedXmlException
from fastapi import HTTPException
from filelock import FileLock, Timeout
from mutagen.flac import FLAC, Picture
from mutagen.id3 import ID3
from mutagen.mp3 import MP3
from mutagen.mp4 import MP4

from wildstring.books.ebooks import (
    AUDIO_SUFFIXES,
    IMAGE_SUFFIXES,
    normalized_image,
    parse_ebook,
    tag,
)
from wildstring.library.import_files import (
    HardlinkError,
    component,
    copy_exclusive,
    digest,
    link_exclusive,
)
from wildstring.library.metadata import normalize, number
from wildstring.library.scanner import SourceChangedError, open_source
from wildstring.library.sidecar import (
    BOOK,
    BOOK_ARRAY,
    BOOK_TEXT,
    clean_text,
    read_asset,
    read_manifest,
    restore_book,
    write_asset,
)

EBOOK_SUFFIXES = {".epub", ".txt"}
BOOK_AUDIO_SUFFIXES = AUDIO_SUFFIXES & {".m4b", ".m4a", ".mp3", ".flac", ".ogg", ".opus"}
logger = logging.getLogger(__name__)


def probe_mp4_chapters(stream):
    ffprobe = shutil.which("ffprobe")
    if ffprobe is None:
        return []
    stream.seek(0)
    fd = stream.fileno()
    try:
        result = subprocess.run(
            [ffprobe, "-v", "error", "-show_chapters", "-of", "json", f"/dev/fd/{fd}"],
            pass_fds=(fd,),
            capture_output=True,
            timeout=15,
            check=True,
        )
        return [
            (round(float(entry["start_time"]) * 1000), entry.get("tags", {}).get("title", ""))
            for entry in json.loads(result.stdout).get("chapters", [])
        ]
    except (subprocess.SubprocessError, OSError, ValueError, OverflowError, KeyError):
        return []


def _extract_embedded_audio_cover(stream, *, audio=None) -> bytes | None:
    if audio is None:
        stream.seek(0)
        try:
            audio = mutagen.File(stream)
        except (OSError, mutagen.MutagenError, ValueError, TypeError, IndexError):
            return None
    if audio is None:
        return None
    candidates: list[bytes] = []
    if isinstance(audio, FLAC):
        candidates = [
            picture.data for picture in sorted(audio.pictures, key=lambda pic: pic.type != 3)
        ]
    elif isinstance(audio, MP3) and audio.tags:
        candidates = [
            frame.data
            for frame in sorted(audio.tags.getall("APIC"), key=lambda frame: frame.type != 3)
        ]
    elif isinstance(audio, MP4):
        candidates = [bytes(picture) for picture in (audio.tags or {}).get("covr", [])]
    elif audio.tags:
        for value in audio.tags.get("metadata_block_picture", []):
            if len(value) > 12 * 1024 * 1024:
                continue
            with suppress(binascii.Error, mutagen.MutagenError, ValueError):
                candidates.append(Picture(base64.b64decode(value, validate=True)).data)
    for raw in candidates:
        try:
            return normalized_image(raw)
        except (OSError, ValueError):
            continue
    return None


def _pair_key(title: str, authors: list[str]) -> str | None:
    clean = normalize(title)
    if not clean:
        return None
    author = normalize(authors[0]) if authors else ""
    return f"{author}::{clean}"


class Books:
    def __init__(self, database, settings):
        self.database = database
        self.cache_root = settings.data_dir / "book_cache"
        self.lock = settings.data_dir / "library-scan.lock"

    @contextmanager
    def write(self, library_id, *, timeout: float = 5.0):
        try:
            with FileLock(self.lock, timeout=timeout):
                with self.database.connect() as db:
                    if db.execute(
                        """SELECT 1 FROM book_library_migrations WHERE library_id=?
                           AND status IN ('queued','running')""",
                        (library_id,),
                    ).fetchone():
                        raise HTTPException(409, "library_migration_busy")
                yield
        except Timeout as error:
            raise HTTPException(409, "scan_busy") from error

    def cache(self, key, chapters, images):
        root = self.cache_root / key
        root.mkdir(parents=True, exist_ok=True)
        for index, chapter in enumerate(chapters):
            self.cache_file(
                root / f"{index}.json", json.dumps(chapter, ensure_ascii=False).encode()
            )
        for name, content in images.items():
            self.cache_file(root / name, content)

    @staticmethod
    def cache_file(path, data):
        temporary = path.with_name(f".{uuid4().hex}")
        try:
            temporary.write_bytes(data)
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)

    def _save_cover(self, managed_root: Path, book_id: str, jpeg: bytes) -> None:
        relative = Path(book_id) / "cover.jpg"
        write_asset(managed_root, relative, jpeg)
        with self.database.connect(write=True) as db:
            db.execute(
                "UPDATE books SET cover_path=?,cover_hash=?,updated_at=? "
                "WHERE id=? AND (cover_path IS NULL OR cover_path='')",
                (relative.as_posix(), hashlib.sha256(jpeg).hexdigest(), time.time(), book_id),
            )

    def choose_book(self, library, title, authors, kind, *, allow_auto_pair: bool = True):
        key = _pair_key(title, authors)
        if allow_auto_pair and library["auto_pair"] and key is not None:
            with self.database.connect(scoped=False) as db:
                rows = db.execute(
                    """SELECT id FROM books WHERE library_id=? AND pair_key=?
                       AND has_ebook=? AND has_audiobook=? LIMIT 2""",
                    (library["id"], key, kind == "audiobook", kind == "ebook"),
                ).fetchall()
                if len(rows) == 1:
                    return rows[0][0], key
        return uuid4().hex, key

    def ebook(
        self,
        library,
        source,
        name,
        mode,
        source_path=None,
        book_id=None,
        *,
        allow_auto_pair: bool = True,
        extract_cover: bool = True,
        remote=None,
    ):
        suffix = Path(name).suffix.lower()
        value = digest(source)
        metadata, chapters, images, encoding = parse_ebook(source, suffix)
        title = metadata.get("title") or Path(name).stem
        authors = metadata.get("authors", [])
        if book_id is None:
            book_id, pair_key = self.choose_book(
                library, title, authors, "ebook", allow_auto_pair=allow_auto_pair
            )
        else:
            pair_key = _pair_key(title, authors)
        relative = Path(book_id) / f"ebook-{value[:16]}{suffix}"
        key = f"{book_id}-{value[:16]}"
        root = Path(library["managed_root"])
        published: Path | None = None
        if remote is not None:
            source_path = remote(source)
        elif not (root / relative).exists():
            publish = link_exclusive if mode == "hardlink" else copy_exclusive
            publish(source, root, relative, value)
            published = root / relative
        else:
            with open_source(root, relative) as saved:
                if digest(saved) != value:
                    raise HTTPException(409, "book_file_conflict")
        try:
            self.cache(key, chapters, images)
            stamp = time.time()
            char_count = 0
            rows = []
            for index, chapter in enumerate(chapters):
                count = sum(block["char_len"] for block in chapter["blocks"])
                rows.append(
                    (
                        book_id,
                        index,
                        chapter.get("href"),
                        chapter["title"],
                        1,
                        len(chapter["blocks"]),
                        count,
                        char_count,
                    )
                )
                char_count += count
            with self.database.connect(write=True) as db:
                db.execute("BEGIN IMMEDIATE")
                existing = db.execute(
                    "SELECT has_ebook FROM books WHERE id=?", (book_id,)
                ).fetchone()
                if existing is not None and existing["has_ebook"]:
                    prev_ebook = db.execute(
                        "SELECT source_path FROM book_ebooks WHERE book_id=?", (book_id,)
                    ).fetchone()
                    if (
                        remote is None
                        and prev_ebook is not None
                        and prev_ebook["source_path"] != source_path
                    ):
                        raise HTTPException(409, "book_ebook_already_attached")
                db.execute(
                    """INSERT INTO books(id,library_id,managed_dir,title,sort_title,authors_json,
                        publisher,language,description,has_ebook,pair_key,created_at,updated_at)
                       VALUES (?,?,?,?,?,?,?,?,?,1,?,?,?)
                       ON CONFLICT(id) DO UPDATE SET
                         has_ebook=1,
                         publisher=COALESCE(NULLIF(books.publisher,''), excluded.publisher),
                         language=COALESCE(NULLIF(books.language,''), excluded.language),
                         description=COALESCE(NULLIF(books.description,''), excluded.description),
                         updated_at=excluded.updated_at""",
                    (
                        book_id,
                        library["id"],
                        book_id,
                        title,
                        normalize(title),
                        json.dumps(authors, ensure_ascii=False),
                        metadata.get("publisher"),
                        metadata.get("language"),
                        metadata.get("description"),
                        pair_key,
                        stamp,
                        stamp,
                    ),
                )
                db.execute(
                    """INSERT INTO book_ebooks(id,book_id,format,managed_path,source_path,link_mode,
                        file_size,sha256,encoding,spine_count,total_chars,cache_key,parsed_at)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
                       ON CONFLICT(book_id) DO UPDATE SET format=excluded.format,
                         managed_path=excluded.managed_path,source_path=excluded.source_path,
                         link_mode=excluded.link_mode,file_size=excluded.file_size,sha256=excluded.sha256,
                         encoding=excluded.encoding,spine_count=excluded.spine_count,
                         total_chars=excluded.total_chars,cache_key=excluded.cache_key,parsed_at=excluded.parsed_at""",
                    (
                        uuid4().hex,
                        book_id,
                        suffix[1:],
                        relative.as_posix(),
                        source_path,
                        mode,
                        os.fstat(source.fileno()).st_size,
                        value,
                        encoding,
                        len(chapters),
                        char_count,
                        key,
                        stamp,
                    ),
                )
                if remote is not None:
                    remote.register(db, book_id)
                db.execute("DELETE FROM book_ebook_chapters WHERE book_id=?", (book_id,))
                db.executemany(
                    """INSERT INTO book_ebook_chapters
                    (book_id,spine_index,href,title,level,block_count,char_count,start_global_char)
                    VALUES (?,?,?,?,?,?,?,?)""",
                    rows,
                )
        except Exception:
            if published is not None:
                published.unlink(missing_ok=True)
            raise
        if extract_cover and metadata.get("cover_bytes"):
            try:
                self._save_cover(root, book_id, metadata["cover_bytes"])
            except Exception:
                logger.warning("Failed to save embedded cover for book %s", book_id, exc_info=True)
        return book_id

    def audiobook(
        self,
        library,
        source_root,
        files,
        title_default,
        *,
        book_id=None,
        allow_auto_pair: bool = True,
        extract_cover: bool = True,
        remote=None,
    ):
        entries = []
        embedded_cover: bytes | None = None
        for relative in files:
            with remote.open(relative) if remote else open_source(source_root, relative) as stream:
                audio = mutagen.File(stream)
                if audio is None or getattr(audio.info, "length", 0) <= 0:
                    raise ValueError("book_audio_invalid")
                size = remote.size(relative) if remote else os.fstat(stream.fileno()).st_size
                tags = audio.tags or {}

                def text(*keys, tags=tags):
                    for key in keys:
                        value = tags.get(key)
                        if value:
                            return str(value[0] if isinstance(value, list) else value)
                    return ""

                duration = round(audio.info.length * 1000)
                track_no = text("tracknumber", "TRCK", "trkn")
                chapter_tags = []
                if isinstance(tags, ID3):
                    chapter_tags = sorted(
                        (item.start_time, str(item.sub_frames.get("TIT2", "")))
                        for item in tags.getall("CHAP")
                    )
                elif getattr(audio, "chapters", None):
                    chapter_tags = [
                        (round(chapter.start * 1000), chapter.title) for chapter in audio.chapters
                    ]
                elif relative.suffix.lower() in {".m4a", ".m4b"}:
                    if remote:
                        with remote.materialize(relative) as materialized:
                            chapter_tags = probe_mp4_chapters(materialized)
                    else:
                        chapter_tags = probe_mp4_chapters(stream)
                if embedded_cover is None and extract_cover:
                    embedded_cover = _extract_embedded_audio_cover(stream, audio=audio)
                entries.append(
                    {
                        "relative": relative,
                        "value": remote.signature(relative) if remote else digest(stream),
                        "size": size,
                        "duration": duration,
                        "codec": relative.suffix.lower()[1:],
                        "bitrate": getattr(audio.info, "bitrate", None),
                        "sample_rate": getattr(audio.info, "sample_rate", None),
                        "channels": getattr(audio.info, "channels", None),
                        "title": text("title", "TIT2", "©nam") or relative.stem,
                        "album": text("album", "TALB", "©alb"),
                        "author": text("albumartist", "TPE2", "aART", "artist", "TPE1", "©ART"),
                        "number": number(track_no) or 0,
                        "chapters": chapter_tags,
                    }
                )
        entries.sort(
            key=lambda item: (
                item["number"],
                [
                    (1, int(part)) if part.isdigit() else (0, part.casefold())
                    for part in re.split(r"(\d+)", item["relative"].as_posix())
                ],
            )
        )
        title = entries[0]["album"] or (entries[0]["title"] if len(entries) == 1 else title_default)
        authors = [entries[0]["author"]] if entries[0]["author"] else []
        if book_id is None:
            book_id, pair_key = self.choose_book(
                library, title, authors, "audiobook", allow_auto_pair=allow_auto_pair
            )
        else:
            pair_key = _pair_key(title, authors)
        root = Path(library["managed_root"])
        mode = library["storage_mode"]
        existing_paths: dict[str, tuple[str, str]] = {}
        preserved_by_source: dict[tuple[str, str, int, int], str] = {}
        preserved_by_hash: dict[tuple[str, int, int], str] = {}
        claimed_title_hashes: set[tuple[str, int, int]] = set()
        current_source_paths = {
            remote.source(item["relative"]) if remote else str(source_root / item["relative"])
            for item in entries
        }
        old_managed_files: set[str] = set()
        with self.database.connect(scoped=False) as db:
            for row in db.execute(
                "SELECT managed_path, link_mode, sha256 FROM book_audiobook_files WHERE book_id=?",
                (book_id,),
            ):
                existing_paths[row["sha256"]] = (row["managed_path"], row["link_mode"])
                old_managed_files.add(row["managed_path"])
            for row in db.execute(
                """SELECT f.source_path, f.sha256, c.start_file_ms, c.end_file_ms, c.title
                   FROM book_audiobook_chapters c
                   JOIN book_audiobook_files f ON f.book_id=c.book_id AND f.file_index=c.file_index
                   WHERE c.book_id=?""",
                (book_id,),
            ):
                hash_key = (row["sha256"], row["start_file_ms"], row["end_file_ms"])
                if row["source_path"] is not None:
                    preserved_by_source[(row["source_path"], *hash_key)] = row["title"]
                    if row["source_path"] in current_source_paths:
                        claimed_title_hashes.add(hash_key)
                preserved_by_hash.setdefault(hash_key, row["title"])

        book_position = 0
        files_rows = []
        chapters_rows = []
        file_source_by_index: dict[int, tuple[str, str]] = {}
        published_paths: list[Path] = []
        new_managed_files: set[str] = set()
        try:
            for index, item in enumerate(entries):
                relative = item["relative"]
                source_str = remote.source(relative) if remote else str(source_root / relative)
                file_source_by_index[index] = (source_str, item["value"])
                managed = (
                    Path(book_id)
                    / f"{index:04}-{component(relative.stem, 'audio')}{relative.suffix.lower()}"
                )
                file_mode = mode
                prev = existing_paths.get(item["value"])
                if remote:
                    file_mode = "managed_only"
                elif prev is not None and (root / prev[0]).exists():
                    managed = Path(prev[0])
                    file_mode = prev[1]
                elif (root / managed).exists():
                    with open_source(root, managed) as existing_stream:
                        if digest(existing_stream) != item["value"]:
                            managed = (
                                Path(book_id)
                                / f"{index:04}-{item['value'][:8]}-{component(relative.stem, 'audio')}{relative.suffix.lower()}"
                            )
                if remote is None and not (root / managed).exists():
                    with open_source(source_root, relative) as stream:
                        publish = link_exclusive if mode == "hardlink" else copy_exclusive
                        publish(stream, root, managed, item["value"])
                    published_paths.append(root / managed)
                new_managed_files.add(managed.as_posix())
                duration = item["duration"]
                files_rows.append(
                    (
                        book_id,
                        index,
                        managed.as_posix(),
                        source_str,
                        file_mode,
                        relative.name,
                        duration,
                        item["codec"],
                        item["bitrate"],
                        item["sample_rate"],
                        item["channels"],
                        item["size"],
                        item["value"],
                        book_position,
                    )
                )
                chapters = sorted(
                    {
                        start: chapter_title or item["title"]
                        for start, chapter_title in item["chapters"]
                        if 0 <= start < duration
                    }.items()
                )
                if not chapters or chapters[0][0] != 0:
                    chapters.insert(0, (0, item["title"]))
                for offset, (start, chapter_title) in enumerate(chapters):
                    end = chapters[offset + 1][0] if offset + 1 < len(chapters) else duration
                    hash_key = (item["value"], start, end)
                    effective_title = preserved_by_source.get((source_str, *hash_key))
                    if effective_title is None and hash_key not in claimed_title_hashes:
                        effective_title = preserved_by_hash.get(hash_key)
                    if effective_title is None:
                        effective_title = chapter_title
                    chapters_rows.append(
                        (
                            book_id,
                            len(chapters_rows),
                            index,
                            effective_title,
                            start,
                            end,
                            book_position + start,
                            end - start,
                        )
                    )
                book_position += duration

            new_by_source: dict[tuple[str, str, int, int], tuple[int, int, int]] = {}
            new_by_hash: dict[tuple[str, int, int], list[tuple[int, int, int]]] = {}
            for _, ch_idx, f_idx, _, start_f, end_f, start_b, dur in chapters_rows:
                src_str, file_sha = file_source_by_index[f_idx]
                target = (ch_idx, start_b, dur)
                new_by_source[(src_str, file_sha, start_f, end_f)] = target
                new_by_hash.setdefault((file_sha, start_f, end_f), []).append(target)

            stamp = time.time()
            with self.database.connect(write=True) as db:
                db.execute("BEGIN IMMEDIATE")
                old_chapters = db.execute(
                    """SELECT c.chapter_index, f.source_path, f.sha256, c.start_file_ms, c.end_file_ms
                       FROM book_audiobook_chapters c
                       JOIN book_audiobook_files f ON f.book_id=c.book_id AND f.file_index=c.file_index
                       WHERE c.book_id=?
                       ORDER BY c.chapter_index""",
                    (book_id,),
                ).fetchall()
                chapter_remap: dict[int, tuple[int, int, int]] = {}
                claimed_new: set[int] = set()
                unmatched_old = []
                for old_row in old_chapters:
                    hash_key = (
                        old_row["sha256"],
                        old_row["start_file_ms"],
                        old_row["end_file_ms"],
                    )
                    matched = (
                        new_by_source.get((old_row["source_path"], *hash_key))
                        if old_row["source_path"] is not None
                        else None
                    )
                    if matched is not None:
                        chapter_remap[old_row["chapter_index"]] = matched
                        claimed_new.add(matched[0])
                    else:
                        unmatched_old.append(old_row)
                for old_row in unmatched_old:
                    hash_key = (
                        old_row["sha256"],
                        old_row["start_file_ms"],
                        old_row["end_file_ms"],
                    )
                    candidates = new_by_hash.get(hash_key, [])
                    if not candidates:
                        continue
                    chosen = next(
                        (item for item in candidates if item[0] not in claimed_new),
                        candidates[0],
                    )
                    chapter_remap[old_row["chapter_index"]] = chosen
                    claimed_new.add(chosen[0])

                db.execute(
                    """INSERT INTO books(id,library_id,managed_dir,title,sort_title,authors_json,
                        has_audiobook,pair_key,created_at,updated_at) VALUES (?,?,?,?,?,?,1,?,?,?)
                       ON CONFLICT(id) DO UPDATE SET has_audiobook=1,updated_at=excluded.updated_at""",
                    (
                        book_id,
                        library["id"],
                        book_id,
                        title,
                        normalize(title),
                        json.dumps(authors, ensure_ascii=False),
                        pair_key,
                        stamp,
                        stamp,
                    ),
                )
                db.execute(
                    """INSERT INTO book_audiobooks(id,book_id,is_multi_file,total_duration_ms,chapter_count,
                       total_bytes,codec_summary,created_at) VALUES (?,?,?,?,?,?,?,?)
                       ON CONFLICT(book_id) DO UPDATE SET
                         is_multi_file=excluded.is_multi_file,
                         total_duration_ms=excluded.total_duration_ms,
                         chapter_count=excluded.chapter_count,
                         total_bytes=excluded.total_bytes,
                         codec_summary=excluded.codec_summary""",
                    (
                        uuid4().hex,
                        book_id,
                        len(entries) > 1,
                        book_position,
                        len(chapters_rows),
                        sum(item["size"] for item in entries),
                        ",".join(sorted({item["codec"] for item in entries})),
                        stamp,
                    ),
                )
                db.execute("DELETE FROM book_audiobook_chapters WHERE book_id=?", (book_id,))
                db.execute("DELETE FROM book_audiobook_files WHERE book_id=?", (book_id,))
                db.executemany(
                    """INSERT INTO book_audiobook_files(book_id,file_index,managed_path,source_path,link_mode,
                        relative_name,duration_ms,codec,bitrate,sample_rate,channels,file_size,sha256,start_book_ms)
                        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                    files_rows,
                )
                db.executemany(
                    """INSERT INTO book_audiobook_chapters(book_id,chapter_index,file_index,title,
                        start_file_ms,end_file_ms,start_book_ms,duration_ms) VALUES (?,?,?,?,?,?,?,?)""",
                    chapters_rows,
                )
                if remote is not None:
                    remote.register(db, book_id, entries)
                if chapter_remap:
                    for progress_row in db.execute(
                        """SELECT user_id, chapter_index, chapter_position_ms, book_position_ms
                           FROM book_listening_progress WHERE book_id=?""",
                        (book_id,),
                    ).fetchall():
                        mapped = chapter_remap.get(progress_row["chapter_index"])
                        if mapped is None:
                            continue
                        new_idx, new_start_book_ms, new_dur_ms = mapped
                        new_pos = min(progress_row["chapter_position_ms"], new_dur_ms)
                        new_book_pos = new_start_book_ms + new_pos
                        if (new_idx, new_pos, new_book_pos) != (
                            progress_row["chapter_index"],
                            progress_row["chapter_position_ms"],
                            progress_row["book_position_ms"],
                        ):
                            db.execute(
                                """UPDATE book_listening_progress
                                   SET chapter_index=?, chapter_position_ms=?, book_position_ms=?
                                   WHERE user_id=? AND book_id=?""",
                                (new_idx, new_pos, new_book_pos, progress_row["user_id"], book_id),
                            )
                    for mark_row in db.execute(
                        """SELECT id, chapter_index, position_ms
                           FROM book_bookmarks WHERE book_id=? AND kind='audio'""",
                        (book_id,),
                    ).fetchall():
                        mapped = chapter_remap.get(mark_row["chapter_index"])
                        if mapped is None:
                            continue
                        new_idx, _, new_dur_ms = mapped
                        new_pos = (
                            min(mark_row["position_ms"], new_dur_ms)
                            if mark_row["position_ms"] is not None
                            else None
                        )
                        if (new_idx, new_pos) != (
                            mark_row["chapter_index"],
                            mark_row["position_ms"],
                        ):
                            db.execute(
                                "UPDATE book_bookmarks SET chapter_index=?, position_ms=? WHERE id=?",
                                (new_idx, new_pos, mark_row["id"]),
                            )
        except Exception:
            for path in published_paths:
                path.unlink(missing_ok=True)
            raise
        for stale in old_managed_files - new_managed_files:
            with suppress(OSError):
                (root / stale).unlink()
        if extract_cover and embedded_cover is not None:
            try:
                self._save_cover(root, book_id, embedded_cover)
            except Exception:
                logger.warning(
                    "Failed to save embedded cover for audiobook %s", book_id, exc_info=True
                )
        return book_id

    def directory_metadata(self, book_id, root, folder):
        metadata = {}
        for name in ("metadata.opf", "metadata.json"):
            content = read_asset(root, folder / name, 2 * 1024 * 1024)
            if content is None:
                continue
            try:
                if name.endswith(".json"):
                    payload = json.loads(content)
                    if isinstance(payload, dict):
                        metadata.update(payload)
                else:
                    parser = ElementTree.fromstring(content)
                    for element in parser.iter():
                        key = tag(element)
                        if key in BOOK_TEXT and key != "sort_title" and clean_text(element.text):
                            metadata[key] = element.text.strip()
                        elif key == "creator" and clean_text(element.text):
                            metadata.setdefault("authors", []).append(element.text.strip())
                        elif key == "date" and element.text:
                            year_match = re.match(r"(\d{4})", element.text.strip())
                            if year_match:
                                metadata["published_year"] = int(year_match.group(1))
                        elif key == "meta" and element.get("name") == "calibre:series_index":
                            with suppress(ValueError, TypeError):
                                metadata["series_index"] = float(element.get("content", ""))
            except (ValueError, DefusedXmlException, ElementTree.ParseError):
                continue
        for name, key in (("reader.txt", "narrators"), ("desc.txt", "description")):
            if content := read_asset(root, folder / name, 32 * 1024):
                value = content.decode("utf-8", errors="replace").strip()
                if clean_text(value):
                    metadata.setdefault(key, [value] if key == "narrators" else value)
        fields = {
            key: metadata[key]
            for key in BOOK_TEXT
            if key != "sort_title" and clean_text(metadata.get(key))
        }
        for key, column in BOOK_ARRAY.items():
            value = metadata.get(key)
            if isinstance(value, list) and all(map(clean_text, value)):
                fields[column] = json.dumps(value, ensure_ascii=False)
        for key, numeric_types in (("series_index", (int, float)), ("published_year", (int,))):
            value = metadata.get(key)
            if type(value) in numeric_types and 0 <= value <= 9999:
                fields[key] = value
        if fields:
            with self.database.connect(write=True) as db:
                book = db.execute(
                    "SELECT locked_fields_json, overrides_json FROM books WHERE id=?", (book_id,)
                ).fetchone()
                if book is None:
                    return
                locked = set(json.loads(book["locked_fields_json"])) | set(
                    json.loads(book["overrides_json"] or "{}")
                )
                fields = {
                    key: value
                    for key, value in fields.items()
                    if key not in locked and key.removesuffix("_json") not in locked
                }
                if "title" in fields:
                    fields["sort_title"] = normalize(fields["title"])
                if fields:
                    columns = ",".join(f"{key}=?" for key in fields)
                    db.execute(
                        f"UPDATE books SET {columns} WHERE id=?",  # nosec B608
                        (*fields.values(), book_id),
                    )

    def _apply_folder_cover(
        self, managed_root: Path, book_id: str, source_root: Path, folder: Path
    ):
        with self.database.connect(scoped=False) as db:
            row = db.execute("SELECT cover_path FROM books WHERE id=?", (book_id,)).fetchone()
            if row is None or row["cover_path"]:
                return
        for stem in ("cover", "folder", "front"):
            for ext in IMAGE_SUFFIXES:
                raw = read_asset(source_root, folder / f"{stem}{ext}", 8 * 1024 * 1024)
                if raw is not None:
                    try:
                        jpeg = normalized_image(raw)
                        self._save_cover(managed_root, book_id, jpeg)
                        return
                    except (OSError, ValueError):
                        continue

    def _apply_embedded_cover(
        self, managed_root: Path, book_id: str, source_root: Path, audio_relatives, ebook_paths
    ):
        with self.database.connect(scoped=False) as db:
            row = db.execute("SELECT cover_path FROM books WHERE id=?", (book_id,)).fetchone()
            if row is None or row["cover_path"]:
                return
        for path in ebook_paths:
            if path.suffix.lower() == ".epub":
                try:
                    with open_source(source_root, path.relative_to(source_root)) as stream:
                        meta, _, _, _ = parse_ebook(stream, ".epub")
                        if meta.get("cover_bytes"):
                            self._save_cover(managed_root, book_id, meta["cover_bytes"])
                            return
                except (OSError, ValueError, HTTPException):
                    continue
        for rel in audio_relatives:
            try:
                with open_source(source_root, rel) as stream:
                    cover = _extract_embedded_audio_cover(stream)
                    if cover is not None:
                        self._save_cover(managed_root, book_id, cover)
                        return
            except OSError:
                continue

    def _recover_managed_directory(self, library, managed_root: Path, folder_name: str) -> bool:
        manifest = read_manifest(managed_root, Path(folder_name), BOOK)
        if manifest is None:
            return False
        book_dir = managed_root / folder_name
        recovered_id = None
        ebook_entry = manifest.get("ebook")
        if isinstance(ebook_entry, dict) and isinstance(ebook_entry.get("sha256"), str):
            fmt = ebook_entry.get("format")
            if fmt in {"epub", "txt"}:
                for entry in sorted(book_dir.iterdir(), key=lambda p: p.name):
                    if (
                        entry.is_file()
                        and not entry.is_symlink()
                        and entry.suffix.lower() == f".{fmt}"
                    ):
                        with open_source(managed_root, Path(folder_name) / entry.name) as stream:
                            if digest(stream) == ebook_entry["sha256"]:
                                mode = "hardlink" if entry.stat().st_nlink > 1 else "managed_only"
                                recovered_id = self.ebook(
                                    library,
                                    stream,
                                    entry.name,
                                    mode,
                                    source_path=None,
                                    book_id=folder_name,
                                    allow_auto_pair=False,
                                    extract_cover=False,
                                )
                                break
        audio_entry = manifest.get("audiobook")
        if isinstance(audio_entry, dict) and isinstance(audio_entry.get("files"), list):
            by_hash: dict[str, Path] = {}
            for entry in sorted(book_dir.iterdir(), key=lambda p: p.name):
                if (
                    entry.is_file()
                    and not entry.is_symlink()
                    and entry.suffix.lower() in BOOK_AUDIO_SUFFIXES
                ):
                    with open_source(managed_root, Path(folder_name) / entry.name) as stream:
                        by_hash[digest(stream)] = Path(folder_name) / entry.name
            ordered = [
                by_hash[item["sha256"]]
                for item in audio_entry["files"]
                if isinstance(item, dict) and item.get("sha256") in by_hash
            ]
            if ordered and len(ordered) == len(audio_entry["files"]):
                recovered_id = self.audiobook(
                    library,
                    managed_root,
                    ordered,
                    manifest.get("title") or folder_name,
                    book_id=recovered_id or folder_name,
                    allow_auto_pair=False,
                    extract_cover=False,
                )
        if recovered_id is None:
            return False
        restore_book(self.database, managed_root, recovered_id, managed_root, Path(folder_name))
        return True

    def watch_probe(self, library) -> tuple[bool, tuple]:
        """Collect an os.stat snapshot for watched source roots without reading files."""
        identity = library["id"]
        with self.database.connect(scoped=False) as db:
            sources = [
                Path(row[0])
                for row in db.execute(
                    "SELECT root FROM book_library_sources "
                    "WHERE library_id=? AND watch_enabled=1 ORDER BY id",
                    (identity,),
                )
            ]
            ebook_sources = {
                row[0]
                for row in db.execute(
                    """SELECT e.source_path FROM book_ebooks e
                       JOIN books b ON b.id=e.book_id
                       WHERE b.library_id=? AND e.source_path IS NOT NULL""",
                    (identity,),
                )
            }
            audio_sources = {
                row[0]
                for row in db.execute(
                    """SELECT a.source_path FROM book_audiobook_files a
                       JOIN books b ON b.id=a.book_id
                       WHERE b.library_id=? AND a.source_path IS NOT NULL""",
                    (identity,),
                )
            }
            known_dirs = {
                row[0]
                for row in db.execute(
                    "SELECT managed_dir FROM books WHERE library_id=?", (identity,)
                )
            }

        watched_suffixes = (
            EBOOK_SUFFIXES
            | BOOK_AUDIO_SUFFIXES
            | IMAGE_SUFFIXES
            | {
                ".opf",
                ".json",
                ".txt",
            }
        )
        has_unimported = False
        source_entries: list[tuple[str, int, int]] = []
        for source_root in sources:
            if not source_root.is_dir() or source_root.is_symlink():
                continue
            for folder, dirs, names in os.walk(source_root, followlinks=False):
                directory = Path(folder)
                dirs[:] = sorted(
                    name
                    for name in dirs
                    if not name.startswith(".") and not (directory / name).is_symlink()
                )
                for name in sorted(names):
                    if name.startswith("."):
                        continue
                    path = directory / name
                    if path.is_symlink():
                        continue
                    suffix = path.suffix.lower()
                    if suffix not in watched_suffixes:
                        continue
                    try:
                        stat_info = path.stat(follow_symlinks=False)
                    except OSError:
                        continue
                    key_str = str(path)
                    source_entries.append((key_str, stat_info.st_size, stat_info.st_mtime_ns))
                    if (
                        suffix in EBOOK_SUFFIXES | BOOK_AUDIO_SUFFIXES
                        and path.name not in {"desc.txt", "reader.txt"}
                        and key_str not in ebook_sources
                        and key_str not in audio_sources
                    ):
                        has_unimported = True

        managed_entries: list[tuple[str, int, int]] = []
        managed_root = Path(library["managed_root"])
        if managed_root.is_dir() and not managed_root.is_symlink():
            for entry in sorted(os.scandir(managed_root), key=lambda item: item.name):
                if (
                    entry.name.startswith(".")
                    or entry.is_symlink()
                    or not entry.is_dir(follow_symlinks=False)
                    or entry.name in known_dirs
                ):
                    continue
                manifest = managed_root / entry.name / ".wildstring" / "manifest.json"
                if manifest.is_file() and not manifest.is_symlink():
                    try:
                        stat_info = manifest.stat(follow_symlinks=False)
                    except OSError:
                        continue
                    managed_entries.append((entry.name, stat_info.st_size, stat_info.st_mtime_ns))
                    has_unimported = True

        snapshot = (
            tuple(str(root) for root in sources),
            tuple(source_entries),
            tuple(managed_entries),
        )
        return has_unimported, snapshot

    def scan(self, library, *, watched_only: bool = False):
        identity = library["id"]
        job_id = uuid4().hex
        with self.write(identity, timeout=0.0 if watched_only else 5.0):
            with self.database.connect(write=True) as db:
                query = (
                    "SELECT root FROM book_library_sources WHERE library_id=? AND watch_enabled=1 ORDER BY id"
                    if watched_only
                    else "SELECT root FROM book_library_sources WHERE library_id=? ORDER BY id"
                )
                sources = [Path(row[0]) for row in db.execute(query, (identity,))]
                ebook_sources = {
                    row[0]: row[1]
                    for row in db.execute(
                        """SELECT e.source_path, e.book_id FROM book_ebooks e
                           JOIN books b ON b.id=e.book_id
                           WHERE b.library_id=? AND e.source_path IS NOT NULL""",
                        (identity,),
                    )
                }
                audio_sources = {
                    row[0]: row[1]
                    for row in db.execute(
                        """SELECT a.source_path, a.book_id FROM book_audiobook_files a
                           JOIN books b ON b.id=a.book_id
                           WHERE b.library_id=? AND a.source_path IS NOT NULL""",
                        (identity,),
                    )
                }
                db.execute(
                    "UPDATE book_scan_jobs SET status='failed',error_message='scan_interrupted',finished_at=? "
                    "WHERE library_id=? AND status='running'",
                    (time.time(), identity),
                )
                db.execute(
                    "INSERT INTO book_scan_jobs(id,library_id,status,started_at) VALUES (?,?,'running',?)",
                    (job_id, identity, time.time()),
                )
            scanned = added = updated = paired = sidecars_applied = failures = 0
            last_error: str | None = None

            def record_failure(exc: Exception) -> None:
                nonlocal failures, last_error
                failures += 1
                if isinstance(exc, HardlinkError):
                    last_error = exc.code
                elif isinstance(exc, SourceChangedError):
                    last_error = "book_scan_source_changed"
                elif isinstance(exc, HTTPException) and isinstance(exc.detail, str):
                    last_error = exc.detail
                elif last_error is None:
                    last_error = "book_scan_file_unavailable"

            try:
                folder_items = []
                for source_root in sources:
                    if not source_root.is_dir() or source_root.is_symlink():
                        failures += 1
                        last_error = last_error or "book_scan_file_unavailable"
                        continue
                    for folder, dirs, names in os.walk(source_root, followlinks=False):
                        directory = Path(folder)
                        dirs[:] = sorted(
                            name
                            for name in dirs
                            if not name.startswith(".") and not (directory / name).is_symlink()
                        )
                        audio = []
                        ebooks = []
                        for name in sorted(names):
                            path = directory / name
                            suffix = path.suffix.lower()
                            if (
                                name.startswith(".")
                                or path.is_symlink()
                                or suffix not in EBOOK_SUFFIXES | BOOK_AUDIO_SUFFIXES
                                or path.name in {"desc.txt", "reader.txt"}
                            ):
                                continue
                            scanned += 1
                            if suffix in EBOOK_SUFFIXES:
                                ebooks.append(path)
                            else:
                                audio.append(path.relative_to(source_root))
                        if audio or ebooks:
                            folder_items.append((source_root, directory, audio, ebooks))

                managed_root = Path(library["managed_root"])
                for source_root, directory, audio, ebooks in folder_items:
                    dir_rel = directory.relative_to(source_root)
                    dir_audio_books = {
                        audio_sources[str(source_root / rel)]
                        for rel in audio
                        if str(source_root / rel) in audio_sources
                    }
                    new_audio = [
                        rel for rel in audio if str(source_root / rel) not in audio_sources
                    ]
                    audio_book = next(iter(dir_audio_books)) if len(dir_audio_books) == 1 else None
                    imported: set[str] = set()
                    newly_paired: set[str] = set()
                    if new_audio:
                        try:
                            target_audio_book = audio_book
                            existed_before = target_audio_book is not None
                            audio_book = self.audiobook(
                                library,
                                source_root,
                                audio if existed_before else new_audio,
                                directory.name,
                                book_id=target_audio_book,
                                allow_auto_pair=len(ebooks) == 0,
                                extract_cover=False,
                            )
                            imported.add(audio_book)
                            if existed_before:
                                updated += 1
                            else:
                                added += 1
                            for rel in audio:
                                audio_sources[str(source_root / rel)] = audio_book
                        except (
                            OSError,
                            ValueError,
                            mutagen.MutagenError,
                            HTTPException,
                            SourceChangedError,
                            TypeError,
                            IndexError,
                        ) as exc:
                            record_failure(exc)
                    elif audio_book is not None:
                        imported.add(audio_book)

                    for path in ebooks:
                        key_str = str(path)
                        if key_str in ebook_sources:
                            imported.add(ebook_sources[key_str])
                            continue
                        target_book = None
                        if len(ebooks) == 1 and audio_book is not None:
                            with self.database.connect(scoped=False) as db:
                                row = db.execute(
                                    "SELECT has_ebook FROM books WHERE id=?", (audio_book,)
                                ).fetchone()
                                if row is not None and not row["has_ebook"]:
                                    target_book = audio_book
                        try:
                            with open_source(source_root, path.relative_to(source_root)) as stream:
                                book_id = self.ebook(
                                    library,
                                    stream,
                                    path.name,
                                    library["storage_mode"],
                                    key_str,
                                    target_book,
                                    allow_auto_pair=(target_book is None and len(ebooks) == 1),
                                    extract_cover=False,
                                )
                            imported.add(book_id)
                            ebook_sources[key_str] = book_id
                            if target_book is not None and book_id == audio_book:
                                newly_paired.add(book_id)
                                paired += 1
                            elif book_id != audio_book:
                                added += 1
                        except (
                            OSError,
                            ValueError,
                            HTTPException,
                            SourceChangedError,
                        ) as exc:
                            record_failure(exc)

                    for book_id in imported:
                        if book_id in newly_paired:
                            updated += 1
                        self.directory_metadata(book_id, source_root, dir_rel)
                        if restore_book(self.database, managed_root, book_id, source_root, dir_rel):
                            sidecars_applied += 1
                        self._apply_folder_cover(managed_root, book_id, source_root, dir_rel)
                        self._apply_embedded_cover(
                            managed_root, book_id, source_root, audio, ebooks
                        )

                # Recover untracked book folders inside managed_root that already carry .wildstring/.
                if managed_root.is_dir() and not managed_root.is_symlink():
                    with self.database.connect(scoped=False) as db:
                        known_dirs = {
                            row[0]
                            for row in db.execute(
                                "SELECT managed_dir FROM books WHERE library_id=?", (identity,)
                            )
                        }
                    for entry in sorted(os.scandir(managed_root), key=lambda item: item.name):
                        if (
                            entry.name.startswith(".")
                            or entry.is_symlink()
                            or not entry.is_dir(follow_symlinks=False)
                            or entry.name in known_dirs
                        ):
                            continue
                        if (managed_root / entry.name / ".wildstring" / "manifest.json").is_file():
                            try:
                                if self._recover_managed_directory(
                                    library, managed_root, entry.name
                                ):
                                    added += 1
                                    sidecars_applied += 1
                            except (
                                OSError,
                                ValueError,
                                HTTPException,
                                mutagen.MutagenError,
                            ) as exc:
                                record_failure(exc)

                status = "completed_with_errors" if failures else "completed"
                error = (last_error or "book_scan_file_unavailable") if failures else None
                with self.database.connect(write=True) as db:
                    db.execute(
                        """UPDATE book_scan_jobs
                           SET status=?,scanned_files=?,added_books=?,updated_books=?,
                               paired_books=?,sidecars_applied=?,error_message=?,finished_at=?
                           WHERE id=?""",
                        (
                            status,
                            scanned,
                            added,
                            updated,
                            paired,
                            sidecars_applied,
                            error,
                            time.time(),
                            job_id,
                        ),
                    )
            except Exception as exc:
                with self.database.connect(write=True) as db:
                    db.execute(
                        "UPDATE book_scan_jobs SET status='failed',error_message=?,finished_at=? WHERE id=?",
                        ("book_scan_failed", time.time(), job_id),
                    )
                if isinstance(exc, HTTPException):
                    raise
                raise
        return {
            "id": job_id,
            "status": status,
            "scanned_files": scanned,
            "added_books": added,
            "updated_books": updated,
            "paired_books": paired,
            "sidecars_applied": sidecars_applied,
            "errors": failures,
        }
