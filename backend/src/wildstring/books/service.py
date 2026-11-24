"""Ingest library files without editing the original ebook or audio."""

import json
import os
import re
import shutil
import subprocess
import time
from contextlib import contextmanager
from pathlib import Path
from uuid import uuid4

import mutagen
from defusedxml import ElementTree
from defusedxml.common import DefusedXmlException
from fastapi import HTTPException
from filelock import FileLock, Timeout
from mutagen.id3 import ID3

from wildstring.books.ebooks import AUDIO_SUFFIXES, parse_ebook, tag
from wildstring.library.import_files import component, copy_exclusive, digest, link_exclusive
from wildstring.library.metadata import normalize, number
from wildstring.library.scanner import open_source
from wildstring.library.sidecar import BOOK_ARRAY, BOOK_TEXT, clean_text, read_asset, restore_book

EBOOK_SUFFIXES = {".epub", ".txt"}
BOOK_AUDIO_SUFFIXES = AUDIO_SUFFIXES & {".m4b", ".m4a", ".mp3", ".flac", ".ogg", ".opus"}


def probe_mp4_chapters(stream):
    ffprobe = shutil.which("ffprobe")
    if ffprobe is None:
        return []
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


class Books:
    def __init__(self, database, settings):
        self.database = database
        self.cache_root = settings.data_dir / "book_cache"
        self.lock = settings.data_dir / "library-scan.lock"

    @contextmanager
    def write(self, library_id):
        try:
            with FileLock(self.lock, timeout=0), self.database.connect() as db:
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

    def choose_book(self, library, title, authors, kind):
        key = "::".join(normalize(part) for part in (authors[0] if authors else "", title))
        if library["auto_pair"]:
            with self.database.connect(scoped=False) as db:
                rows = db.execute(
                    """SELECT id FROM books WHERE library_id=? AND pair_key=?
                       AND has_ebook=? AND has_audiobook=? LIMIT 2""",
                    (library["id"], key, kind == "audiobook", kind == "ebook"),
                ).fetchall()
                if len(rows) == 1:
                    return rows[0][0], key
        return uuid4().hex, key

    def ebook(self, library, source, name, mode, source_path=None, book_id=None):
        suffix = Path(name).suffix.lower()
        value = digest(source)
        metadata, chapters, images, encoding = parse_ebook(source, suffix)
        title = metadata.get("title") or Path(name).stem
        authors = metadata.get("authors", [])
        if book_id is None:
            book_id, pair_key = self.choose_book(library, title, authors, "ebook")
        else:
            pair_key = None
        relative = Path(book_id) / f"ebook-{value[:16]}{suffix}"
        key = f"{book_id}-{value[:16]}"
        root = Path(library["managed_root"])
        if not (root / relative).exists():
            publish = link_exclusive if mode == "hardlink" else copy_exclusive
            publish(source, root, relative, value)
        else:
            with open_source(root, relative) as saved:
                if digest(saved) != value:
                    raise HTTPException(409, "book_file_conflict")
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
            db.execute(
                """INSERT INTO books(id,library_id,managed_dir,title,sort_title,authors_json,
                    publisher,language,description,has_ebook,pair_key,created_at,updated_at)
                   VALUES (?,?,?,?,?,?,?,?,?,1,?,?,?)
                   ON CONFLICT(id) DO UPDATE SET has_ebook=1,updated_at=excluded.updated_at""",
                (
                    book_id,
                    library["id"],
                    book_id,
                    title,
                    normalize(title),
                    json.dumps(authors),
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
            db.execute("DELETE FROM book_ebook_chapters WHERE book_id=?", (book_id,))
            db.executemany(
                """INSERT INTO book_ebook_chapters
                (book_id,spine_index,href,title,level,block_count,char_count,start_global_char)
                VALUES (?,?,?,?,?,?,?,?)""",
                rows,
            )
        return book_id

    def audiobook(self, library, source_root, files, title_default):
        entries = []
        for relative in files:
            with open_source(source_root, relative) as stream:
                audio = mutagen.File(stream)
                if audio is None or getattr(audio.info, "length", 0) <= 0:
                    raise ValueError("book_audio_invalid")
                info = os.fstat(stream.fileno())
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
                    chapter_tags = probe_mp4_chapters(stream)
                entries.append(
                    {
                        "relative": relative,
                        "value": digest(stream),
                        "size": info.st_size,
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
        book_id, pair_key = self.choose_book(library, title, authors, "audiobook")
        root = Path(library["managed_root"])
        mode = library["storage_mode"]
        book_position = 0
        files_rows = []
        chapters_rows = []
        for index, item in enumerate(entries):
            relative = item["relative"]
            managed = (
                Path(book_id)
                / f"{index:04}-{component(relative.stem, 'audio')}{relative.suffix.lower()}"
            )
            with open_source(source_root, relative) as stream:
                publish = link_exclusive if mode == "hardlink" else copy_exclusive
                publish(stream, root, managed, item["value"])
            duration = item["duration"]
            files_rows.append(
                (
                    book_id,
                    index,
                    managed.as_posix(),
                    str(source_root / relative),
                    mode,
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
                chapters_rows.append(
                    (
                        book_id,
                        len(chapters_rows),
                        index,
                        chapter_title,
                        start,
                        end,
                        book_position + start,
                        end - start,
                    )
                )
            book_position += duration
        stamp = time.time()
        with self.database.connect(write=True) as db:
            db.execute("BEGIN IMMEDIATE")
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
                    json.dumps(authors),
                    pair_key,
                    stamp,
                    stamp,
                ),
            )
            db.execute(
                """INSERT INTO book_audiobooks(id,book_id,is_multi_file,total_duration_ms,chapter_count,
                   total_bytes,codec_summary,created_at) VALUES (?,?,?,?,?,?,?,?)""",
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
                        if key in BOOK_TEXT and clean_text(element.text):
                            metadata[key] = element.text.strip()
                        elif key == "creator" and clean_text(element.text):
                            metadata.setdefault("authors", []).append(element.text.strip())
            except (ValueError, DefusedXmlException, ElementTree.ParseError):
                continue
        for name, key in (("reader.txt", "narrators"), ("desc.txt", "description")):
            if content := read_asset(root, folder / name, 32 * 1024):
                value = content.decode("utf-8", errors="replace").strip()
                if clean_text(value):
                    metadata.setdefault(key, [value] if key == "narrators" else value)
        fields = {key: metadata[key] for key in BOOK_TEXT if clean_text(metadata.get(key))}
        for key, column in BOOK_ARRAY.items():
            value = metadata.get(key)
            if isinstance(value, list) and all(map(clean_text, value)):
                fields[column] = json.dumps(value, ensure_ascii=False)
        if fields:
            with self.database.connect(write=True) as db:
                book = db.execute(
                    "SELECT locked_fields_json FROM books WHERE id=?", (book_id,)
                ).fetchone()
                locked = set(json.loads(book[0]))
                fields = {
                    key: value
                    for key, value in fields.items()
                    if key not in locked and key.removesuffix("_json") not in locked
                }
                if fields:
                    columns = ",".join(f"{key}=?" for key in fields)
                    db.execute(
                        f"UPDATE books SET {columns} WHERE id=?",  # nosec B608
                        (*fields.values(), book_id),
                    )

    def scan(self, library):
        identity = library["id"]
        job_id = uuid4().hex
        with self.write(identity):
            with self.database.connect(write=True) as db:
                sources = [
                    Path(row[0])
                    for row in db.execute(
                        "SELECT root FROM book_library_sources WHERE library_id=? ORDER BY id",
                        (identity,),
                    )
                ]
                existing = {
                    row[0]
                    for row in db.execute(
                        """SELECT e.source_path FROM book_ebooks e JOIN books b ON b.id=e.book_id WHERE b.library_id=?
                       UNION SELECT a.source_path FROM book_audiobook_files a JOIN books b ON b.id=a.book_id
                       WHERE b.library_id=?""",
                        (identity, identity),
                    )
                }
                db.execute(
                    "UPDATE book_scan_jobs SET status='failed',error_message='scan_interrupted' "
                    "WHERE library_id=? AND status='running'",
                    (identity,),
                )
                db.execute(
                    "INSERT INTO book_scan_jobs(id,library_id,status,started_at) VALUES (?,?,'running',?)",
                    (job_id, identity, time.time()),
                )
            scanned = added = failures = 0
            for source_root in sources:
                if not source_root.is_dir() or source_root.is_symlink():
                    failures += 1
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
                        if str(path) in existing:
                            continue
                        if suffix in EBOOK_SUFFIXES:
                            ebooks.append(path)
                        else:
                            audio.append(path.relative_to(source_root))
                    audio_book = None
                    imported = set()
                    if audio:
                        try:
                            audio_book = self.audiobook(library, source_root, audio, directory.name)
                            imported.add(audio_book)
                            added += 1
                        except (OSError, ValueError, mutagen.MutagenError):
                            failures += 1
                    for path in ebooks:
                        try:
                            with open_source(source_root, path.relative_to(source_root)) as stream:
                                book_id = self.ebook(
                                    library,
                                    stream,
                                    path.name,
                                    library["storage_mode"],
                                    str(path),
                                    audio_book if len(ebooks) == 1 else None,
                                )
                            imported.add(book_id)
                            added += int(book_id != audio_book)
                        except (OSError, ValueError, HTTPException):
                            failures += 1
                    for book_id in imported:
                        self.directory_metadata(
                            book_id, source_root, directory.relative_to(source_root)
                        )
                        restore_book(
                            self.database,
                            Path(library["managed_root"]),
                            book_id,
                            source_root,
                            directory.relative_to(source_root),
                        )
            status = "completed_with_errors" if failures else "completed"
            error = "book_scan_file_unavailable" if failures else None
            with self.database.connect(write=True) as db:
                db.execute(
                    """UPDATE book_scan_jobs SET status=?,scanned_files=?,added_books=?,error_message=?,
                       finished_at=? WHERE id=?""",
                    (status, scanned, added, error, time.time(), job_id),
                )
        return {
            "id": job_id,
            "status": status,
            "scanned_files": scanned,
            "added_books": added,
            "errors": failures,
        }
