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
import unicodedata
from bisect import bisect_left, bisect_right
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
    decode_text,
    normalized_image,
    parse_ebook,
    tag,
    txt_heading_level,
)
from wildstring.books.intake import cleaned_preview, ignore_pending, ignored_path, plain_description
from wildstring.diagnostics import record_event
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
    DIRECTORY,
    clean_text,
    export_books,
    read_asset,
    read_manifest,
    restore_book,
    write_asset,
)

EBOOK_SUFFIXES = {".epub", ".txt"}
BOOK_AUDIO_SUFFIXES = AUDIO_SUFFIXES & {".m4b", ".m4a", ".mp3", ".flac", ".ogg", ".opus"}
DESCRIPTION_NAMES = ("desc.txt",)
METADATA_TEXT_NAMES = {*DESCRIPTION_NAMES, "reader.txt"}
TXT_SCAN_BYTES = 16 * 1024
LOCAL_COVER_BYTES = 64 * 1024 * 1024
LOCAL_COVER_PIXELS = 80_000_000
DISC_DIRECTORY = re.compile(r"(?:disc|disk|cd)[ _-]*(\d+)?", re.I)
SERIES_VOLUME = re.compile(
    r"(?:(?P<prefix>.*?)\s*[-·：:]?\s*)?"
    r"(?:第\s*(?P<cn>[零〇一二两三四五六七八九十百\d]+)\s*[卷季部册]"
    r"|(?:vol(?:ume)?\.?|season|book|part)\s*(?P<en>\d+))"
    r"(?:\s+.*|\s*[-·：:].*)?",
    re.I,
)
EBOOK_CACHE_REVISION = 2
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


def _natural_path(path):
    return [
        (1, int(part)) if part.isdigit() else (0, part.casefold())
        for part in re.split(r"([0-9]+)", path.as_posix())
    ], path.as_posix()


def _audio_folder(root, directory):
    while directory != root and DISC_DIRECTORY.fullmatch(directory.name):
        directory = directory.parent
    return directory


def _source_layout(
    root: Path, suffixes: set[str], patterns: list[str]
) -> tuple[dict[Path, list[Path]], set[Path]]:
    folders: dict[Path, list[Path]] = {}
    restricted_txt_dirs: set[Path] = set()
    for folder, dirs, names in os.walk(root, followlinks=False):
        directory = Path(folder)
        dirs[:] = sorted(
            name
            for name in dirs
            if not name.startswith(".") and not (directory / name).is_symlink()
        )
        if dirs:
            restricted_txt_dirs.add(directory)
        for name in sorted(names):
            path = directory / name
            suffix = path.suffix.lower()
            if name.startswith(".") or suffix not in suffixes or path.is_symlink():
                continue
            if ignored_path(path.relative_to(root), patterns):
                continue
            folders.setdefault(directory, []).append(path)
            if suffix in BOOK_AUDIO_SUFFIXES:
                restricted_txt_dirs.update((directory, _audio_folder(root, directory)))
    return folders, restricted_txt_dirs


def _scan_txt(root: Path, path: Path, ebook_sources, restricted_txt_dirs: set[Path]) -> bool:
    if str(path) in ebook_sources:
        return True
    if path.name.casefold() in METADATA_TEXT_NAMES:
        return False
    if path.parent not in restricted_txt_dirs:
        return True
    try:
        with open_source(root, path.relative_to(root)) as stream:
            if os.fstat(stream.fileno()).st_size >= TXT_SCAN_BYTES:
                return True
            text, _ = decode_text(stream.read(TXT_SCAN_BYTES))
    except (OSError, ValueError):
        return False
    return any(txt_heading_level(line.strip()) > 0 for line in text.splitlines())


def _disc_number(path):
    for parent in path.parents:
        if match := DISC_DIRECTORY.fullmatch(parent.name):
            return int(match[1] or 1)
    return 1


def _audio_text(value):
    value = value.strip()
    if not value or value.isascii():
        return value
    if "\ufffd" in value:
        return ""
    if not all(ord(char) <= 255 for char in value):
        return value
    raw = value.encode("latin-1")
    for encoding in ("utf-8", "gb18030"):
        try:
            candidate = raw.decode(encoding)
        except UnicodeDecodeError:
            continue
        # Require clear UTF-8 mojibake or a run of CJK glyphs from high bytes.
        han = len(re.findall(r"[\u3400-\u9fff]", candidate))
        if encoding == "utf-8" or (han >= 2 and han * 2 >= len(candidate)):
            return candidate
    if any(128 <= ord(char) < 160 for char in value) or re.search(r"[À-ÿ]{4}", value):
        return ""
    return value


def _series_volume(folder, parent=None):
    name = unicodedata.normalize("NFKC", folder.name).strip()
    match = SERIES_VOLUME.fullmatch(name)
    if match is not None:
        prefix = (match["prefix"] or "").strip(" -·：:")
        value = match["cn"] or match["en"]
        if value.isdecimal():
            index = int(value)
        else:
            digits = dict(zip("零一二三四五六七八九", range(10), strict=True)) | {"两": 2, "〇": 0}
            index = digit = 0
            for char in value:
                if char in "十百":
                    index += (digit or 1) * (10 if char == "十" else 100)
                    digit = 0
                else:
                    digit = digits.get(char, 0)
            index += digit
        return prefix or folder.parent.name, index
    if parent is not None:
        parent_name = unicodedata.normalize("NFKC", parent.name).strip()
        if parent_name and name.casefold().startswith(parent_name.casefold()):
            suffix = name[len(parent_name) :].lstrip(" -·：:_")
            if number_match := re.match(r"([1-9]\d{0,2}|0[1-9]\d?)(?!\d)", suffix):
                return parent.name.strip(), int(number_match[1])
    return None


def _remap_ebook_anchors(db, book_id, old_blocks, chapters):
    old_starts = {}
    for spine, position, blocks in old_blocks:
        for block in blocks:
            old_starts[spine, block["block_index"]] = position
            position += block["char_len"]

    starts, anchors = [], []
    total = 0
    for spine, chapter in enumerate(chapters):
        for block in chapter["blocks"]:
            starts.append(total)
            anchors.append((spine, block["block_index"], block["char_len"]))
            total += block["char_len"]

    def mapped(spine, block, offset, *, end=False):
        position = min(total, old_starts.get((spine, block), 0) + offset)
        index = max(0, (bisect_left if end else bisect_right)(starts, position) - 1)
        new_spine, new_block, length = anchors[index]
        return new_spine, new_block, min(length, position - starts[index]), position

    for row in db.execute("SELECT * FROM book_reading_progress WHERE book_id=?", (book_id,)):
        spine, block, offset, position = mapped(
            row["spine_index"], row["block_index"], row["char_offset"]
        )
        db.execute(
            """UPDATE book_reading_progress SET spine_index=?,block_index=?,char_offset=?,
               chapter_title=?,overall_ratio=?,version=version+1,session_id='',device_id='',sequence=0
               WHERE book_id=? AND user_id=?""",
            (
                spine,
                block,
                offset,
                chapters[spine]["title"],
                position / total,
                book_id,
                row["user_id"],
            ),
        )
    for row in db.execute(
        "SELECT * FROM book_bookmarks WHERE book_id=? AND kind='ebook'", (book_id,)
    ):
        spine, block, offset, _ = mapped(row["spine_index"], row["block_index"], row["char_offset"])
        db.execute(
            "UPDATE book_bookmarks SET spine_index=?,block_index=?,char_offset=? WHERE id=?",
            (spine, block, offset, row["id"]),
        )
    for row in db.execute("SELECT * FROM book_annotations WHERE book_id=?", (book_id,)):
        spine, block, offset, _ = mapped(
            row["spine_index"], row["start_block_index"], row["start_char_offset"]
        )
        end_spine, end_block, end_offset, _ = mapped(
            row["spine_index"],
            row["end_block_index"],
            row["end_char_offset"],
            end=row["end_char_offset"] > 0,
        )
        if end_spine != spine:
            raise HTTPException(409, "book_repair_annotation_spans_chapters")
        db.execute(
            """UPDATE book_annotations SET spine_index=?,start_block_index=?,start_char_offset=?,
               end_block_index=?,end_char_offset=? WHERE id=?""",
            (spine, block, offset, end_block, end_offset, row["id"]),
        )


class Books:
    def __init__(self, database, settings):
        self.database = database
        self.cache_root = settings.data_dir / "book_cache"
        self.lock = settings.data_dir / "library-scan.lock"

    @contextmanager
    def write(self, library_id, *, timeout: float = 5.0, operation="write", book_id=None):
        def migration_busy():
            with self.database.connect() as db:
                return (
                    db.execute(
                        """SELECT 1 FROM book_library_migrations WHERE library_id=?
                       AND status IN ('queued','running')""",
                        (library_id,),
                    ).fetchone()
                    is not None
                )

        def conflict(code):
            record_event(
                "books.write_conflict",
                level="WARNING",
                task_id=library_id,
                batch_id=book_id,
                operation=operation,
                code=code,
                http_status=409,
            )
            return HTTPException(409, code)

        try:
            with FileLock(self.lock, timeout=timeout):
                if migration_busy():
                    raise conflict("library_migration_busy")
                yield
        except Timeout as error:
            code = "library_migration_busy" if migration_busy() else "scan_busy"
            raise conflict(code) from error

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

    def _save_cover(self, managed_root: Path, book_id: str, jpeg: bytes, *, refresh=False) -> None:
        relative = Path(book_id) / "cover.jpg"
        write_asset(managed_root, relative, jpeg)
        with self.database.connect(write=True) as db:
            db.execute(
                "UPDATE books SET cover_path=?,cover_hash=?,updated_at=? "
                "WHERE id=? AND (? OR cover_path IS NULL OR cover_path='')",
                (
                    relative.as_posix(),
                    hashlib.sha256(jpeg).hexdigest(),
                    time.time(),
                    book_id,
                    refresh,
                ),
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
        repair=False,
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
        key = f"{book_id}-{value[:16]}-r{EBOOK_CACHE_REVISION}"
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
                        chapter["level"],
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
                        "SELECT source_path,sha256,cache_key FROM book_ebooks WHERE book_id=?",
                        (book_id,),
                    ).fetchone()
                    if (
                        remote is None
                        and prev_ebook is not None
                        and prev_ebook["source_path"] != source_path
                    ):
                        raise HTTPException(409, "book_ebook_already_attached")
                    if repair and prev_ebook["sha256"] != value:
                        raise HTTPException(409, "book_repair_source_changed")
                    if (
                        suffix == ".txt"
                        and prev_ebook["sha256"] == value
                        and prev_ebook["cache_key"] != key
                    ):

                        def cached_blocks():
                            for old in db.execute(
                                "SELECT spine_index,start_global_char FROM book_ebook_chapters WHERE book_id=?",
                                (book_id,),
                            ):
                                spine = old["spine_index"]
                                with open_source(
                                    self.cache_root, Path(prev_ebook["cache_key"]) / f"{spine}.json"
                                ) as cached:
                                    yield (
                                        spine,
                                        old["start_global_char"],
                                        json.load(cached)["blocks"],
                                    )

                        _remap_ebook_anchors(db, book_id, cached_blocks(), chapters)
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
        repair=False,
        grouped_discs=False,
        combine_books=(),
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

                def text(*keys, clean=True, tags=tags):
                    for key in keys:
                        value = tags.get(key)
                        if value:
                            raw = str(value[0] if isinstance(value, list) else value)
                            return _audio_text(raw) if clean else raw
                    return ""

                duration = round(audio.info.length * 1000)
                track_no = number(text("tracknumber", "TRCK"))
                disc_no = number(text("discnumber", "TPOS"))
                if isinstance(audio, MP4):
                    track_no = (tags.get("trkn") or [(0, 0)])[0][0]
                    disc_no = (tags.get("disk") or [(0, 0)])[0][0]
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
                raw_title = text("title", "TIT2", "©nam", clean=False)
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
                        "tag_title": _audio_text(raw_title),
                        "raw_title": raw_title or relative.stem,
                        "album": text("album", "TALB", "©alb"),
                        "author": text("author", "TXXX:AUTHOR", "TXXX:Author", "©aut"),
                        "narrator": text("narrator", "TXXX:NARRATOR", "TXXX:Narrator", "©nrt"),
                        "order": (disc_no or _disc_number(relative), track_no or 0),
                        "chapters": chapter_tags,
                    }
                )
        title_stems: dict[str, set[str]] = {}
        if len(entries) > 1:
            for item in entries:
                if not item["chapters"] and item["tag_title"]:
                    title_stems.setdefault(normalize(item["tag_title"]), set()).add(
                        item["relative"].stem
                    )
        repeated_titles = {title for title, stems in title_stems.items() if len(stems) > 1}
        orders = {item["order"] for item in entries}
        if len(orders) == len(entries) and all(disc > 0 and track > 0 for disc, track in orders):
            entries.sort(key=lambda item: item["order"])
        else:
            entries.sort(key=lambda item: _natural_path(item["relative"]))
        first = entries[0]
        title = (
            title_default
            if grouped_discs
            else first["album"]
            or (
                (first["tag_title"] or first["relative"].stem)
                if len(entries) == 1
                else title_default
            )
        )
        authors = list(dict.fromkeys(item["author"] for item in entries if item["author"]))
        narrators = list(dict.fromkeys(item["narrator"] for item in entries if item["narrator"]))
        if book_id is None:
            book_id, pair_key = self.choose_book(
                library, title, authors, "audiobook", allow_auto_pair=allow_auto_pair
            )
        else:
            pair_key = _pair_key(title, authors)
        previous_books = (book_id, *combine_books)
        placeholders = ",".join("?" for _ in previous_books)
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
                f"""SELECT f.source_path, f.sha256, c.start_file_ms, c.end_file_ms, c.title
                   FROM book_audiobook_chapters c
                   JOIN book_audiobook_files f ON f.book_id=c.book_id AND f.file_index=c.file_index
                   WHERE c.book_id IN ({placeholders})""",  # nosec B608
                previous_books,
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
                        start: chapter_title or item["raw_title"]
                        for start, chapter_title in item["chapters"]
                        if 0 <= start < duration
                    }.items()
                )
                if not chapters or chapters[0][0] != 0:
                    chapters.insert(0, (0, item["raw_title"]))
                repeated_title = (
                    not item["chapters"]
                    and item["tag_title"]
                    and normalize(item["tag_title"]) in repeated_titles
                )
                for offset, (start, chapter_title) in enumerate(chapters):
                    end = chapters[offset + 1][0] if offset + 1 < len(chapters) else duration
                    hash_key = (item["value"], start, end)
                    effective_title = preserved_by_source.get((source_str, *hash_key))
                    if effective_title is None and hash_key not in claimed_title_hashes:
                        effective_title = preserved_by_hash.get(hash_key)
                    if effective_title is None or (
                        repair
                        and (
                            effective_title == chapter_title
                            or (repeated_title and effective_title == item["tag_title"])
                        )
                    ):
                        effective_title = (
                            relative.stem
                            if repeated_title
                            else _audio_text(chapter_title) or item["tag_title"] or relative.stem
                        )
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
                    f"""SELECT c.book_id, c.chapter_index, f.source_path, f.sha256,
                              c.start_file_ms, c.end_file_ms
                       FROM book_audiobook_chapters c
                       JOIN book_audiobook_files f ON f.book_id=c.book_id AND f.file_index=c.file_index
                       WHERE c.book_id IN ({placeholders})
                       ORDER BY c.book_id,c.chapter_index""",  # nosec B608
                    previous_books,
                ).fetchall()
                chapter_remap: dict[tuple[str, int], tuple[int, int, int]] = {}
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
                        chapter_remap[old_row["book_id"], old_row["chapter_index"]] = matched
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
                    chapter_remap[old_row["book_id"], old_row["chapter_index"]] = chosen
                    claimed_new.add(chosen[0])

                if repair and len(chapter_remap) != len(old_chapters):
                    raise HTTPException(409, "book_repair_source_changed")

                retired_books = []
                if combine_books:
                    duplicate_progress = db.execute(
                        f"""SELECT user_id FROM book_listening_progress
                            WHERE book_id IN ({placeholders})
                            GROUP BY user_id HAVING COUNT(*)>1 LIMIT 1""",  # nosec B608
                        previous_books,
                    ).fetchone()
                    if duplicate_progress:
                        raise HTTPException(409, "book_repair_multiple_audio_books")
                    target = db.execute("SELECT * FROM books WHERE id=?", (book_id,)).fetchone()
                    locks = set(json.loads(target["locked_fields_json"]))
                    overrides = json.loads(target["overrides_json"])
                    adopted = {}
                    for identity in combine_books:
                        other = db.execute("SELECT * FROM books WHERE id=?", (identity,)).fetchone()
                        other_locks = set(json.loads(other["locked_fields_json"]))
                        other_overrides = json.loads(other["overrides_json"])
                        if other["has_ebook"]:
                            raise HTTPException(409, "book_repair_multiple_audio_books")
                        for field in other_locks | other_overrides.keys():
                            column = BOOK_ARRAY.get(field, field)
                            value = other[column]
                            if field in locks or field in overrides:
                                if adopted.get(column, target[column]) != value:
                                    raise HTTPException(409, "book_repair_multiple_audio_books")
                            adopted[column] = value
                        locks.update(other_locks)
                        overrides.update(other_overrides)
                        retired_books.append(Path(other["managed_dir"]))
                        old_managed_files.update(
                            row[0]
                            for row in db.execute(
                                "SELECT managed_path FROM book_audiobook_files WHERE book_id=?",
                                (identity,),
                            )
                        )
                        if other["cover_path"] and not target["cover_path"]:
                            adopted.setdefault("cover_path", other["cover_path"])
                            adopted.setdefault("cover_hash", other["cover_hash"])
                    adopted["locked_fields_json"] = json.dumps(sorted(locks))
                    adopted["overrides_json"] = json.dumps(overrides, ensure_ascii=False)
                    if "title" in adopted:
                        adopted["sort_title"] = normalize(adopted["title"])
                    assignments = ",".join(f"{key}=?" for key in adopted)
                    db.execute(
                        f"UPDATE books SET {assignments} WHERE id=?",  # nosec B608
                        (*adopted.values(), book_id),
                    )
                db.execute(
                    """INSERT INTO books(id,library_id,managed_dir,title,sort_title,authors_json,
                        narrators_json,has_audiobook,pair_key,created_at,updated_at) VALUES (?,?,?,?,?,?,?,1,?,?,?)
                       ON CONFLICT(id) DO UPDATE SET has_audiobook=1,updated_at=excluded.updated_at""",
                    (
                        book_id,
                        library["id"],
                        book_id,
                        title,
                        normalize(title),
                        json.dumps(authors, ensure_ascii=False),
                        json.dumps(narrators, ensure_ascii=False),
                        pair_key,
                        stamp,
                        stamp,
                    ),
                )
                if repair or narrators:
                    book = db.execute("SELECT * FROM books WHERE id=?", (book_id,)).fetchone()
                    protected = set(json.loads(book["locked_fields_json"])) | set(
                        json.loads(book["overrides_json"])
                    )
                    fields = (
                        {"narrators_json": json.dumps(narrators, ensure_ascii=False)}
                        if narrators
                        else {}
                    )
                    if repair and not book["has_ebook"]:
                        fields |= {
                            "title": title,
                            "authors_json": json.dumps(authors, ensure_ascii=False),
                        }
                    if not repair and book["narrators_json"] != "[]":
                        fields.pop("narrators_json", None)
                    fields = {
                        key: value
                        for key, value in fields.items()
                        if key.removesuffix("_json") not in protected
                    }
                    if "title" in fields:
                        fields["sort_title"] = normalize(title)
                    if fields:
                        assignments = ",".join(f"{key}=?" for key in fields)
                        db.execute(
                            f"UPDATE books SET {assignments} WHERE id=?",  # nosec B608
                            (*fields.values(), book_id),
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
                        f"""SELECT book_id,user_id,chapter_index,chapter_position_ms,book_position_ms
                            FROM book_listening_progress WHERE book_id IN ({placeholders})""",  # nosec B608
                        previous_books,
                    ).fetchall():
                        source_id = progress_row["book_id"]
                        mapped = chapter_remap.get((source_id, progress_row["chapter_index"]))
                        if mapped is None:
                            continue
                        new_idx, new_start_book_ms, new_dur_ms = mapped
                        new_pos = min(progress_row["chapter_position_ms"], new_dur_ms)
                        new_book_pos = new_start_book_ms + new_pos
                        if (book_id, new_idx, new_pos, new_book_pos) != (
                            source_id,
                            progress_row["chapter_index"],
                            progress_row["chapter_position_ms"],
                            progress_row["book_position_ms"],
                        ):
                            db.execute(
                                """UPDATE book_listening_progress SET book_id=?,chapter_index=?,
                                   chapter_position_ms=?,book_position_ms=? WHERE user_id=? AND book_id=?""",
                                (
                                    book_id,
                                    new_idx,
                                    new_pos,
                                    new_book_pos,
                                    progress_row["user_id"],
                                    source_id,
                                ),
                            )
                    for mark_row in db.execute(
                        f"""SELECT book_id,id,chapter_index,position_ms FROM book_bookmarks
                            WHERE kind='audio' AND book_id IN ({placeholders})""",  # nosec B608
                        previous_books,
                    ).fetchall():
                        source_id = mark_row["book_id"]
                        mapped = chapter_remap.get((source_id, mark_row["chapter_index"]))
                        if mapped is None:
                            continue
                        new_idx, _, new_dur_ms = mapped
                        new_pos = (
                            min(mark_row["position_ms"], new_dur_ms)
                            if mark_row["position_ms"] is not None
                            else None
                        )
                        if (book_id, new_idx, new_pos) != (
                            source_id,
                            mark_row["chapter_index"],
                            mark_row["position_ms"],
                        ):
                            db.execute(
                                "UPDATE book_bookmarks SET book_id=?,chapter_index=?,position_ms=? WHERE id=?",
                                (book_id, new_idx, new_pos, mark_row["id"]),
                            )
                if repair and (
                    combine_books
                    or any(old_index != new[0] for (_, old_index), new in chapter_remap.items())
                ):
                    db.execute(
                        """UPDATE book_listening_progress
                           SET version=version+1,session_id='',device_id='',sequence=0 WHERE book_id=?""",
                        (book_id,),
                    )
                for identity in combine_books:
                    db.execute("DELETE FROM books WHERE id=?", (identity,))
        except Exception:
            for path in published_paths:
                path.unlink(missing_ok=True)
            raise
        for stale in old_managed_files - new_managed_files:
            with suppress(OSError):
                (root / stale).unlink()
        for directory in retired_books:
            with suppress(OSError):
                (root / directory / DIRECTORY / "manifest.json").unlink(missing_ok=True)
        if extract_cover and embedded_cover is not None:
            try:
                self._save_cover(root, book_id, embedded_cover)
            except Exception:
                logger.warning(
                    "Failed to save embedded cover for audiobook %s", book_id, exc_info=True
                )
        return book_id

    def directory_metadata(self, library, book_id, root, folder, defaults=None):
        metadata = dict(defaults or {})
        patterns = json.loads(library["ignore_patterns_json"])
        external_names = (
            ("metadata.opf", "metadata.json")
            if library["external_metadata_mode"] == "sanitized"
            else ()
        )
        for name in external_names:
            if ignored_path(folder / name, patterns):
                continue
            content = read_asset(root, folder / name, 2 * 1024 * 1024)
            if content is None:
                continue
            try:
                if name.endswith(".json"):
                    payload = json.loads(content)
                    if not isinstance(payload, dict):
                        continue
                    if isinstance(series := payload.get("series"), list):
                        for entry in series:
                            if not clean_text(entry) or not entry.strip():
                                continue
                            parts = re.fullmatch(r"(.+?)\s*#(\d+(?:\.\d+)?)", entry.strip())
                            payload.setdefault(
                                "series_name", parts[1].strip() if parts else entry.strip()
                            )
                            if parts:
                                payload.setdefault("series_index", float(parts[2]))
                            break
                    if "publishedYear" in payload:
                        year = payload["publishedYear"]
                        if isinstance(year, str) and re.fullmatch(r"[0-9]{4}", year.strip()):
                            year = int(year)
                        payload.setdefault("published_year", year)
                    authors = payload.get("authors")
                    if (
                        folder != Path(".")
                        and defaults
                        and "series_index" in defaults
                        and isinstance(authors, list)
                        and len(authors) == 1
                        and isinstance(authors[0], str)
                        and normalize(authors[0].strip()) == normalize((root / folder).parent.name)
                    ):
                        payload.pop("authors")
                    metadata.update(payload)
                else:
                    parser = ElementTree.fromstring(content)
                    for element in parser.iter():
                        key = tag(element)
                        if key == "description":
                            inner = (element.text or "") + "".join(
                                ElementTree.tostring(child, encoding="unicode") for child in element
                            )
                            metadata[key] = inner
                        elif key in BOOK_TEXT and key != "sort_title" and clean_text(element.text):
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
        if "description" in metadata:
            raw = metadata.pop("description")
            if isinstance(raw, str):
                value = plain_description(raw)
                if value and clean_text(value):
                    metadata["description"] = value
        with suppress(OSError):
            names = {entry.name.casefold(): entry.name for entry in (root / folder).iterdir()}
            for name in ("reader.txt", *DESCRIPTION_NAMES):
                if name not in names or ignored_path(folder / names[name], patterns):
                    continue
                content = read_asset(root, folder / names[name], 64 * 1024)
                if content:
                    with suppress(ValueError):
                        value, encoding = decode_text(content)
                        # Big5 bytes can decode as GB18030 with private-use or kana glyphs.
                        if encoding == "gb18030" and re.search(
                            r"[\u3040-\u30ff\ue000-\uf8ff]", value
                        ):
                            with suppress(UnicodeDecodeError):
                                traditional = content.decode("big5")
                                if not re.search(r"[\u3040-\u30ff\ue000-\uf8ff]", traditional):
                                    value = traditional
                        value = value.strip()
                        if clean_text(value):
                            if name == "reader.txt":
                                metadata.setdefault("narrators", [value])
                            else:
                                metadata.setdefault("description", value)
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

    def apply_import_metadata(self, library, book_id, root, folder):
        directory = root / folder
        parent = directory.parent if directory.parent != root else None
        series = _series_volume(directory, parent=parent) if directory != root else None
        defaults = {"series_name": series[0], "series_index": series[1]} if series else None
        managed = Path(library["managed_root"])
        self.directory_metadata(library, book_id, root, folder, defaults)
        restore_book(self.database, managed, book_id, root, folder)
        self._apply_folder_cover(
            managed, book_id, root, folder, patterns=json.loads(library["ignore_patterns_json"])
        )

    def _apply_folder_cover(
        self,
        managed_root: Path,
        book_id: str,
        source_root: Path,
        folder: Path,
        *,
        patterns: list[str],
        refresh=False,
    ):
        with self.database.connect(scoped=False) as db:
            row = db.execute("SELECT cover_path,title FROM books WHERE id=?", (book_id,)).fetchone()
            if row is None or (row["cover_path"] and not refresh):
                return
        stems = (
            "cover",
            "folder",
            "front",
            (source_root / folder).name.casefold(),
            row["title"].casefold(),
        )
        try:
            entries = sorted((source_root / folder).iterdir())
        except OSError:
            return
        candidates: dict[str, list[Path]] = {}
        for entry in entries:
            stem = entry.stem.casefold()
            if (
                stem in stems
                and not ignored_path(entry.relative_to(source_root), patterns)
                and entry.suffix.casefold() in IMAGE_SUFFIXES
                and not entry.name.startswith(".")
                and not entry.is_symlink()
            ):
                candidates.setdefault(stem, []).append(entry)
        for stem in dict.fromkeys(stems):
            for entry in candidates.get(stem, ()):
                raw = read_asset(source_root, folder / entry.name, LOCAL_COVER_BYTES)
                if raw is None:
                    continue
                try:
                    jpeg = normalized_image(
                        raw, max_bytes=LOCAL_COVER_BYTES, max_pixels=LOCAL_COVER_PIXELS
                    )
                    self._save_cover(managed_root, book_id, jpeg, refresh=refresh)
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
        """Snapshot watched sources and detect new media or queue changes."""
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

            skipped = {
                row["source_path"]: row
                for row in db.execute(
                    """SELECT source_path,source_root,file_size,source_mtime_ns,status
                       FROM book_scan_skipped_files WHERE library_id=?""",
                    (identity,),
                )
            }

        patterns = json.loads(library["ignore_patterns_json"])
        watched_suffixes = EBOOK_SUFFIXES | BOOK_AUDIO_SUFFIXES | IMAGE_SUFFIXES | {".opf", ".json"}
        has_unimported = False
        source_entries: list[tuple[str, int, int]] = []
        txt_contexts = []
        probed_roots = set()
        for source_root in sources:
            if not source_root.is_dir() or source_root.is_symlink():
                continue
            probed_roots.add(str(source_root))
            folders, restricted_txt_dirs = _source_layout(source_root, watched_suffixes, patterns)
            txt_contexts.append(tuple(sorted(restricted_txt_dirs)))
            for paths in folders.values():
                for path in paths:
                    if library["external_metadata_mode"] == "off" and path.name.casefold() in {
                        "metadata.opf",
                        "metadata.json",
                    }:
                        continue
                    suffix = path.suffix.lower()
                    try:
                        stat_info = path.stat(follow_symlinks=False)
                    except OSError:
                        continue
                    key_str = str(path)
                    source_entries.append((key_str, stat_info.st_size, stat_info.st_mtime_ns))
                    if (
                        suffix in EBOOK_SUFFIXES | BOOK_AUDIO_SUFFIXES
                        and path.name.casefold() not in METADATA_TEXT_NAMES
                        and key_str not in ebook_sources
                        and key_str not in audio_sources
                    ):
                        known = skipped.get(key_str)
                        same = known is not None and (
                            known["file_size"],
                            known["source_mtime_ns"],
                        ) == (stat_info.st_size, stat_info.st_mtime_ns)
                        if not same or (
                            known["status"] == "pending"
                            and _scan_txt(source_root, path, ebook_sources, restricted_txt_dirs)
                        ):
                            has_unimported = True

        if not has_unimported:
            seen = {path for path, _, _ in source_entries}
            has_unimported = any(
                row["status"] == "pending"
                and row["source_root"] in probed_roots
                and (path not in seen or path in ebook_sources)
                for path, row in skipped.items()
            )

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
            tuple(txt_contexts),
            tuple(patterns),
            library["external_metadata_mode"],
        )
        return has_unimported, snapshot

    def rescan_book(self, library, book_id):
        """Rebuild one book while its library write lock is held."""
        identity = library["id"]
        managed = Path(library["managed_root"])
        with self.database.connect(scoped=False) as db:
            roots = [
                Path(row[0])
                for row in db.execute(
                    "SELECT root FROM book_library_sources WHERE library_id=?", (identity,)
                )
            ]
            ebook = db.execute("SELECT * FROM book_ebooks WHERE book_id=?", (book_id,)).fetchone()
            audio = db.execute(
                "SELECT * FROM book_audiobook_files WHERE book_id=? ORDER BY file_index", (book_id,)
            ).fetchall()
            other_audio = {
                row[0]
                for row in db.execute(
                    """SELECT f.source_path FROM book_audiobook_files f JOIN books b ON b.id=f.book_id
                   WHERE b.library_id=? AND f.book_id<>?""",
                    (identity, book_id),
                )
            }

        def source(path):
            match = next((root for root in roots if path.is_relative_to(root)), None)
            if match is None:
                raise HTTPException(409, "book_repair_source_changed")
            return match

        metadata_folders = []
        audio_relatives = []
        patterns = json.loads(library["ignore_patterns_json"])
        if audio:
            if any(not row["source_path"] for row in audio):
                raise HTTPException(409, "book_repair_source_changed")
            paths = [Path(row["source_path"]) for row in audio]
            root = source(paths[0])
            folder = _audio_folder(root, paths[0].parent)
            if any(
                not path.is_relative_to(root) or _audio_folder(root, path.parent) != folder
                for path in paths
            ):
                raise HTTPException(409, "book_repair_source_changed")
            files = set(paths)
            for directory, dirs, names in os.walk(folder, followlinks=False):
                parent = Path(directory)
                dirs[:] = [
                    name
                    for name in dirs
                    if DISC_DIRECTORY.fullmatch(name) and not (parent / name).is_symlink()
                ]
                for name in names:
                    path = parent / name
                    if (
                        not name.startswith(".")
                        and not path.is_symlink()
                        and path.suffix.lower() in BOOK_AUDIO_SUFFIXES
                        and str(path) not in other_audio
                        and not ignored_path(path.relative_to(root), patterns)
                    ):
                        files.add(path)
            audio_relatives = [file.relative_to(root) for file in sorted(files)]
            self.audiobook(
                library,
                root,
                audio_relatives,
                folder.name,
                book_id=book_id,
                repair=True,
                extract_cover=False,
                grouped_discs=any(file.parent != folder for file in files),
            )
            metadata_folders.append((root, folder))

        if ebook:
            path = Path(ebook["source_path"] or ebook["managed_path"])
            if ebook["source_path"]:
                root = source(path)
                relative = path.relative_to(root)
                if (root, path.parent) not in metadata_folders:
                    metadata_folders.append((root, path.parent))
            else:
                root, relative = managed, path
            with open_source(root, relative) as stream:
                self.ebook(
                    library,
                    stream,
                    path.name,
                    ebook["link_mode"],
                    ebook["source_path"],
                    book_id,
                    extract_cover=False,
                    repair=True,
                )

        for root, folder in metadata_folders:
            relative = folder.relative_to(root)
            parent = folder.parent if folder.parent != root else None
            series = _series_volume(folder, parent=parent) if folder != root else None
            defaults = {"series_name": series[0], "series_index": series[1]} if series else {}
            self.directory_metadata(library, book_id, root, relative, defaults)
        if metadata_folders:
            root, folder = metadata_folders[0]
            self._apply_folder_cover(
                managed, book_id, root, folder.relative_to(root), patterns=patterns, refresh=True
            )
            paths = [Path(ebook["source_path"])] if ebook and ebook["source_path"] else []
            self._apply_embedded_cover(
                managed,
                book_id,
                root,
                audio_relatives,
                [path for path in paths if path.is_relative_to(root)],
            )
        export_books(self.database, managed, identity, book_id)

    def _update_skipped_files(
        self, library_id, previous, skipped_files, scanned_roots, ebook_sources, audio_sources
    ):
        owners: dict[Path, set[str]] = {}
        roots = sorted((Path(root) for root in scanned_roots), key=lambda path: -len(path.parts))
        for source, book_id in audio_sources.items():
            folder = Path(source).parent
            root = next((root for root in roots if folder.is_relative_to(root)), None)
            if root is not None:
                owners.setdefault(_audio_folder(root, folder), set()).add(book_id)
        for source, book_id in ebook_sources.items():
            owners.setdefault(Path(source).parent, set()).add(book_id)

        rows = []
        seen = set()
        for root, path in skipped_files:
            relative = path.relative_to(root)
            try:
                with open_source(root, relative) as stream:
                    stat = os.fstat(stream.fileno())
                    data = stream.read(TXT_SCAN_BYTES)
            except OSError:
                continue
            decoded = ""
            with suppress(ValueError):
                decoded = decode_text(data)[0]
            preview = decoded[:800]
            cleaned = cleaned_preview(decoded)[:800]
            candidates = owners.get(path.parent, set()) | owners.get(
                _audio_folder(root, path.parent), set()
            )
            rows.append(
                (
                    uuid4().hex,
                    library_id,
                    next(iter(candidates)) if len(candidates) == 1 else None,
                    str(root),
                    str(path),
                    relative.as_posix(),
                    stat.st_size,
                    stat.st_mtime_ns,
                    preview,
                    cleaned,
                    time.time(),
                )
            )
            seen.add(str(path))

        with self.database.connect(write=True) as db:
            db.execute("BEGIN IMMEDIATE")
            current = db.execute(
                "SELECT ignore_patterns_json FROM book_libraries WHERE id=?", (library_id,)
            ).fetchone()
            if current is None:
                return
            patterns = json.loads(current["ignore_patterns_json"])
            registered = {
                row[0]
                for row in db.execute(
                    "SELECT root FROM book_library_sources WHERE library_id=?", (library_id,)
                )
            }
            db.executemany(
                """INSERT INTO book_scan_skipped_files
                   (id,library_id,book_id,source_root,source_path,relative_path,file_size,source_mtime_ns,
                    reason,status,preview_text,cleaned_preview,updated_at)
                   VALUES (?,?,?,?,?,?,?,?,'txt_admission','pending',?,?,?)
                   ON CONFLICT(library_id,source_path) DO UPDATE SET
                       book_id=excluded.book_id, file_size=excluded.file_size,
                       source_mtime_ns=excluded.source_mtime_ns, status='pending',
                       preview_text=excluded.preview_text, cleaned_preview=excluded.cleaned_preview,
                       updated_at=excluded.updated_at
                   WHERE book_scan_skipped_files.file_size<>excluded.file_size
                      OR book_scan_skipped_files.source_mtime_ns<>excluded.source_mtime_ns
                      OR (book_scan_skipped_files.status='pending' AND book_scan_skipped_files.book_id IS NOT excluded.book_id)""",
                [
                    row
                    for row in rows
                    if row[3] in registered and not ignored_path(Path(row[5]), patterns)
                ],
            )
            db.executemany(
                "DELETE FROM book_scan_skipped_files WHERE id=? AND status='pending'",
                [
                    (row["id"],)
                    for source, row in previous.items()
                    if source in ebook_sources
                    or row["source_root"] not in registered
                    or (
                        row["source_root"] in scanned_roots
                        and source not in seen
                        and not (
                            ignored_path(Path(source).relative_to(row["source_root"]), patterns)
                            and Path(source).is_file()
                            and not Path(source).is_symlink()
                        )
                    )
                ],
            )
            ignore_pending(db, library_id, patterns)

    def scan(self, library, *, watched_only: bool = False, repair: bool = False):
        identity = library["id"]
        job_id = uuid4().hex
        with self.write(
            identity, timeout=0.0 if watched_only else 5.0, operation="repair" if repair else "scan"
        ):
            with self.database.connect(write=True) as db:
                library = db.execute(
                    "SELECT * FROM book_libraries WHERE id=?", (identity,)
                ).fetchone()
                if library is None:
                    raise HTTPException(404, "book_library_not_found")
                patterns = json.loads(library["ignore_patterns_json"])
                skipped = {
                    row["source_path"]: row
                    for row in db.execute(
                        """SELECT id,source_path,source_root,book_id,file_size,source_mtime_ns,status
                           FROM book_scan_skipped_files WHERE library_id=?""",
                        (identity,),
                    )
                }
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

            def publish_progress(status="running"):
                with self.database.connect(write=True) as db:
                    db.execute(
                        """UPDATE book_scan_jobs SET status=?,scanned_files=?,added_books=?,
                           updated_books=?,paired_books=?,sidecars_applied=?,error_message=?,finished_at=?
                           WHERE id=?""",
                        (
                            status,
                            scanned,
                            added,
                            updated,
                            paired,
                            sidecars_applied,
                            last_error,
                            None if status == "running" else time.time(),
                            job_id,
                        ),
                    )

            try:
                folder_items = {}
                skipped_files = []
                scanned_roots = set()
                for source_root in sources:
                    if not source_root.is_dir() or source_root.is_symlink():
                        failures += 1
                        last_error = last_error or "book_scan_file_unavailable"
                        continue
                    scanned_roots.add(str(source_root))
                    folders, restricted_txt_dirs = _source_layout(
                        source_root, EBOOK_SUFFIXES | BOOK_AUDIO_SUFFIXES, patterns
                    )
                    for directory, paths in folders.items():
                        audio = []
                        ebooks = []
                        for path in paths:
                            suffix = path.suffix.lower()
                            if suffix in BOOK_AUDIO_SUFFIXES:
                                audio.append(path.relative_to(source_root))
                            elif suffix != ".txt" or str(path) in ebook_sources:
                                ebooks.append(path)
                            elif path.name.casefold() not in METADATA_TEXT_NAMES:
                                previous = skipped.get(str(path))
                                if previous is not None and previous["status"] != "pending":
                                    try:
                                        stat = path.stat(follow_symlinks=False)
                                    except OSError:
                                        continue
                                    if (stat.st_size, stat.st_mtime_ns) == (
                                        previous["file_size"],
                                        previous["source_mtime_ns"],
                                    ):
                                        continue
                                if _scan_txt(source_root, path, ebook_sources, restricted_txt_dirs):
                                    ebooks.append(path)
                                else:
                                    skipped_files.append((source_root, path))
                        if ebooks:
                            folder_items.setdefault((source_root, directory), ([], []))[1].extend(
                                ebooks
                            )
                        if audio:
                            book_directory = _audio_folder(source_root, directory)
                            folder_items.setdefault((source_root, book_directory), ([], []))[
                                0
                            ].extend(audio)

                volumes = {
                    (root, directory): series
                    for root, directory in folder_items
                    if directory != root
                    and (
                        series := _series_volume(
                            directory,
                            parent=directory.parent if directory.parent != root else None,
                        )
                    )
                }
                # Fallback for numbered sibling folders (e.g. "01 七星鲁王宫", "02 秦岭神树") under a shared series parent.
                numbered_by_parent: dict[tuple[Path, Path], list[tuple[Path, int]]] = {}
                for root, directory in folder_items:
                    if (
                        directory == root
                        or directory.parent == root
                        or (root, directory) in volumes
                    ):
                        continue
                    normalized_name = unicodedata.normalize("NFKC", directory.name).strip()
                    if sibling_match := re.match(
                        r"([1-9]\d{0,2}|0[1-9]\d?)[\s._·-]+.+", normalized_name
                    ):
                        numbered_by_parent.setdefault((root, directory.parent), []).append(
                            (directory, int(sibling_match[1]))
                        )
                for (root, parent), items in numbered_by_parent.items():
                    if len(items) >= 2:
                        for directory, idx in items:
                            volumes[root, directory] = (parent.name.strip(), idx)
                series_by_parent: dict[tuple[Path, Path], set[str]] = {}
                for (root, directory), series in volumes.items():
                    series_by_parent.setdefault((root, directory.parent), set()).add(series[0])

                managed_root = Path(library["managed_root"])
                for (source_root, directory), (audio, ebooks) in folder_items.items():
                    scanned += len(audio) + len(ebooks)
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
                    retired = ()
                    if repair and len(dir_audio_books) > 1:
                        with self.database.connect(scoped=False) as db:
                            candidates = [
                                row
                                for row in db.execute(
                                    "SELECT id,has_ebook FROM books WHERE library_id=? "
                                    "ORDER BY has_ebook DESC,created_at,id",
                                    (identity,),
                                )
                                if row["id"] in dir_audio_books
                            ]
                        audio_book = candidates[0]["id"]
                        retired = tuple(row["id"] for row in candidates[1:])
                    imported: set[str] = set()
                    newly_paired: set[str] = set()
                    if new_audio or (repair and audio_book is not None):
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
                                repair=repair,
                                combine_books=retired,
                                grouped_discs=any(
                                    (source_root / rel).parent != directory for rel in audio
                                ),
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
                            imported.update(dir_audio_books)
                            if retired:
                                audio_book = None
                    elif audio_book is not None:
                        imported.add(audio_book)

                    for path in ebooks:
                        key_str = str(path)
                        existing_ebook = ebook_sources.get(key_str)
                        if existing_ebook is not None and not (
                            repair and path.suffix.lower() == ".txt"
                        ):
                            imported.add(existing_ebook)
                            continue
                        target_book = existing_ebook
                        if target_book is None and len(ebooks) == 1 and audio_book is not None:
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
                                    repair=repair,
                                )
                            imported.add(book_id)
                            ebook_sources[key_str] = book_id
                            if existing_ebook is not None:
                                updated += 1
                            elif target_book is not None and book_id == audio_book:
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
                        defaults = {}
                        if series := volumes.get((source_root, directory)):
                            defaults = {"series_name": series[0], "series_index": series[1]}
                        else:
                            parent_series = series_by_parent.get((source_root, directory), set())
                            for path in ebooks:
                                if ebook_sources.get(str(path)) != book_id:
                                    continue
                                stem_key = normalize(path.stem)
                                matched_series = next(
                                    (
                                        name
                                        for name in parent_series
                                        if stem_key == normalize(name)
                                        or (
                                            directory != source_root
                                            and stem_key.startswith(normalize(name))
                                        )
                                    ),
                                    None,
                                )
                                if matched_series:
                                    defaults = {"series_name": matched_series}
                                    break
                        self.directory_metadata(library, book_id, source_root, dir_rel, defaults)
                        if restore_book(self.database, managed_root, book_id, source_root, dir_rel):
                            sidecars_applied += 1
                        self._apply_folder_cover(
                            managed_root, book_id, source_root, dir_rel, patterns=patterns
                        )
                        self._apply_embedded_cover(
                            managed_root, book_id, source_root, audio, ebooks
                        )
                        if repair:
                            export_books(self.database, managed_root, identity, book_id)
                    publish_progress()

                self._update_skipped_files(
                    identity, skipped, skipped_files, scanned_roots, ebook_sources, audio_sources
                )

                if repair:
                    with self.database.connect(scoped=False) as db:
                        managed_txt = db.execute(
                            """SELECT e.book_id,e.managed_path,e.link_mode FROM book_ebooks e
                               JOIN books b ON b.id=e.book_id
                               WHERE b.library_id=? AND e.format='txt' AND e.source_path IS NULL""",
                            (identity,),
                        ).fetchall()
                    for entry in managed_txt:
                        scanned += 1
                        try:
                            path = Path(entry["managed_path"])
                            with open_source(managed_root, path) as stream:
                                self.ebook(
                                    library,
                                    stream,
                                    path.name,
                                    entry["link_mode"],
                                    book_id=entry["book_id"],
                                    extract_cover=False,
                                    repair=True,
                                )
                            updated += 1
                            export_books(self.database, managed_root, identity, entry["book_id"])
                        except (OSError, ValueError, HTTPException) as exc:
                            record_failure(exc)
                        publish_progress()

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

                    publish_progress()

                status = "completed_with_errors" if failures else "completed"
                publish_progress(status)
            except Exception:
                last_error = "book_scan_failed"
                publish_progress("failed")
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
