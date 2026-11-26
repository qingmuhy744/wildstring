"""Reconcile a Drive tree with the local music and bookshelf indexes."""

import hashlib
import io
import json
import mimetypes
from collections import defaultdict
from contextlib import contextmanager
from pathlib import Path
from tempfile import TemporaryFile

import mutagen
from fastapi import HTTPException
from filelock import FileLock, Timeout
from mutagen import MutagenError
from mutagen.mp3 import MP3
from mutagen.mp4 import MP4

from wildstring.books.ebooks import MAX_EBOOK_BYTES
from wildstring.books.service import (
    BOOK_AUDIO_SUFFIXES,
    EBOOK_SUFFIXES,
    Books,
    _extract_embedded_audio_cover,
)
from wildstring.library.assets import TrackAssets
from wildstring.library.import_files import component
from wildstring.library.lyrics import MAX_TEXT_BYTES, decode_text, flac_lyric_texts
from wildstring.library.metadata import SUPPORTED_SUFFIXES, read_metadata
from wildstring.library.metadata_inference import enrich_metadata
from wildstring.library.repository import COUNTERS, LibraryRepository, now
from wildstring.library.upload import MAX_AUDIO_BYTES
from wildstring.storage.gdrive import FOLDER, DriveError
from wildstring.storage.media import RemoteObject, RemoteRangeFile

MUSIC_SUFFIXES = SUPPORTED_SUFFIXES | {".ogg", ".opus"}
LYRIC_SUFFIXES = {".lrc", ".lryc", ".txt"}


def register(db, binding, kind, identity, ref, info=None):
    previous = db.execute(
        """DELETE FROM remote_media_objects WHERE account_id=? AND entity_kind=?
           AND remote_file_id=? AND entity_id<>? RETURNING entity_id""",
        (binding["account_id"], kind, ref.id, identity),
    ).fetchone()
    if previous and kind == "track":
        db.execute("UPDATE tracks SET status='missing' WHERE id=?", (previous[0],))
    db.execute(
        """INSERT INTO remote_media_objects
           (entity_kind,entity_id,collection,library_id,account_id,remote_file_id,
            remote_md5,remote_modified_at,remote_version,size_bytes,media_info)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(entity_kind,entity_id) DO UPDATE SET
             remote_file_id=excluded.remote_file_id,remote_md5=excluded.remote_md5,
             remote_modified_at=excluded.remote_modified_at,remote_version=excluded.remote_version,
             size_bytes=excluded.size_bytes,media_info=excluded.media_info,available=1""",
        (
            kind,
            identity,
            binding["collection"],
            binding["library_id"],
            binding["account_id"],
            ref.id,
            ref.md5,
            ref.modified,
            ref.version,
            ref.size,
            json.dumps(info or {}),
        ),
    )


def matches(record, ref):
    return (
        record
        and record["available"]
        and (
            record["remote_version"],
            record["remote_md5"],
            record["size_bytes"],
        )
        == (ref.version, ref.md5, ref.size)
    )


@contextmanager
def temporary_media(drive, ref, directory, maximum):
    if ref.size > maximum:
        raise HTTPException(413, "file_too_large")
    with TemporaryFile(dir=directory) as stream:
        if ref.size:
            for chunk in drive.iter_range(ref, 0, ref.size - 1):
                stream.write(chunk)
        stream.seek(0)
        yield stream


class RemoteEbook:
    def __init__(self, drive, binding, path, *, ref=None, size=None):
        self.drive, self.binding, self.path = drive, binding, path
        self.ref, self.size = ref, size

    def __call__(self, source):
        if self.ref is None:
            self.ref = self.drive.upload_stream(
                self.binding["root_folder_id"],
                self.path,
                source,
                self.size,
                mimetypes.guess_type(self.path.name)[0] or "application/octet-stream",
            )
        return f"gdrive:{self.ref.id}"

    def register(self, db, book_id):
        register(db, self.binding, "book_ebook", book_id, self.ref)


class RemoteAudiobook:
    def __init__(self, drive, binding, items, directory):
        self.drive, self.binding, self.items, self.directory = drive, binding, items, directory

    def open(self, relative):
        return io.BufferedReader(RemoteRangeFile(self.drive, self.items[relative], relative))

    def materialize(self, relative):
        return temporary_media(self.drive, self.items[relative], self.directory, MAX_AUDIO_BYTES)

    def source(self, relative):
        return f"gdrive:{self.items[relative].id}"

    def size(self, relative):
        return self.items[relative].size

    def signature(self, relative):
        ref = self.items[relative]
        return hashlib.sha256(repr((ref.id, ref.md5 or ref.version)).encode()).hexdigest()

    def register(self, db, book_id, entries):
        db.execute(
            """DELETE FROM remote_media_objects WHERE entity_kind='book_audiobook_file'
               AND entity_id LIKE ?""",
            (f"{book_id}:%",),
        )
        for index, entry in enumerate(entries):
            register(
                db,
                self.binding,
                "book_audiobook_file",
                f"{book_id}:{index}",
                self.items[entry["relative"]],
            )


def reachable(tree, root):
    children = defaultdict(list)
    for item in tree.values():
        if not item.get("trashed"):
            for parent in item.get("parents", []):
                children[parent].append(item)
    paths = {}
    folders = [(root, Path())]
    while folders:
        parent, path = folders.pop()
        for item in children[parent]:
            identity = item["id"]
            if identity in paths or identity == root:
                continue
            child = path / component(item["name"], identity)
            paths[identity] = child
            if item["mimeType"] == FOLDER:
                folders.append((identity, child))
    return paths


def embedded_lyrics(audio):
    tags = audio.tags or {}
    if isinstance(audio, MP3):
        if audio.tags:
            for frame in audio.tags.getall("SYLT"):
                if frame.format == 2 and frame.text:
                    return "\n".join(
                        f"[{stamp // 60000:02}:{stamp % 60000 / 1000:06.3f}]{line}"
                        for line, stamp in frame.text
                    )
            frames = audio.tags.getall("USLT")
            return frames[0].text if frames else None
        return None
    if isinstance(audio, MP4):
        values = tags.get("©lyr", [])
    else:
        values = flac_lyric_texts(tags)
    return str(next(iter(values), "")) or None


def music_info(audio, metadata):
    codec = metadata.format
    if isinstance(audio, MP4):
        codec = getattr(audio.info, "codec", "").lower()
        if codec.startswith("mp4a"):
            codec = "aac"
    return {
        "codec": codec,
        "container": metadata.format,
        "lossless": codec in {"flac", "alac"},
        "bitrate_kbps": round((getattr(audio.info, "bitrate", None) or 0) / 1000) or None,
        "sample_rate": metadata.sample_rate,
        "channels": metadata.channels or 2,
        "bit_depth": getattr(audio.info, "bits_per_sample", None),
        "duration_ms": metadata.duration_ms,
    }


class Sync:
    def __init__(self, database, settings):
        self.db, self.settings = database, settings
        self.books = Books(database, settings)

    @contextmanager
    def write(self):
        try:
            with FileLock(self.settings.data_dir / "library-scan.lock", timeout=0):
                yield
        except Timeout:
            raise HTTPException(409, "scan_busy") from None

    def tree(self, drive, binding, full):
        root = binding["root_folder_id"]
        token = binding["changes_page_token"]
        if token and not full:
            with self.db.connect(scoped=False) as db:
                previous = {
                    row[0]: json.loads(row[1])
                    for row in db.execute(
                        "SELECT file_id,metadata FROM remote_drive_tree WHERE collection=? AND library_id=?",
                        (binding["collection"], binding["library_id"]),
                    )
                }
            try:
                changes, cursor = drive.list_changes(root, token)
            except DriveError as error:
                if error.status not in {400, 404, 410}:
                    raise
            else:
                if root in changes:
                    if not changes[root] or changes[root].get("trashed"):
                        return {}, cursor
                    if not previous:
                        return drive.list_tree(root), cursor
                tree = previous.copy()
                for key, value in changes.items():
                    if key != root:
                        if value and not value.get("trashed"):
                            tree[key] = value
                        else:
                            tree.pop(key, None)
                for identity in reachable(tree, root):
                    if identity not in previous and tree[identity]["mimeType"] == FOLDER:
                        tree.update(drive.list_tree(identity))
                return {key: tree[key] for key in reachable(tree, root)}, cursor
        cursor = drive.start_cursor()
        drive.folder(root)
        return drive.list_tree(root), cursor

    def run(self, drive, binding, library, *, full=False, on_start=None):
        with self.write():
            with self.db.connect(scoped=False) as db:
                binding = dict(
                    db.execute(
                        "SELECT * FROM library_remote_storage WHERE collection=? AND library_id=?",
                        (binding["collection"], binding["library_id"]),
                    ).fetchone()
                )
            tree, cursor = self.tree(drive, binding, full)
            paths = reachable(tree, binding["root_folder_id"])
            counts = dict.fromkeys(COUNTERS, 0)
            with self.db.connect(scoped=False) as db:
                records = {
                    row["remote_file_id"]: dict(row)
                    for row in db.execute(
                        """SELECT * FROM remote_media_objects WHERE collection=? AND library_id=?""",
                        (binding["collection"], binding["library_id"]),
                    )
                }
            if binding["collection"] == "music":
                repo = LibraryRepository(self.db, Path(library["root"]), fixed=True)
                scan_id = repo.begin_scan()
                if on_start:
                    on_start(scan_id)
                try:
                    self.music(
                        drive, binding, tree, paths, records, repo, scan_id, counts, full=full
                    )
                except BaseException:
                    repo.progress(scan_id, counts, "failed")
                    raise
            else:
                self.bookshelf(drive, binding, library, tree, paths, records, counts, full=full)
            with self.db.connect(write=True) as db:
                db.execute("BEGIN IMMEDIATE")
                db.execute(
                    "DELETE FROM remote_drive_tree WHERE collection=? AND library_id=?",
                    (binding["collection"], binding["library_id"]),
                )
                db.executemany(
                    "INSERT INTO remote_drive_tree VALUES (?,?,?,?)",
                    (
                        (binding["collection"], binding["library_id"], key, json.dumps(item))
                        for key, item in tree.items()
                    ),
                )
                db.execute(
                    """UPDATE library_remote_storage SET changes_page_token=?,last_synced_at=?
                       WHERE collection=? AND library_id=?""",
                    (cursor, now(), binding["collection"], binding["library_id"]),
                )
            status = "completed_with_errors" if counts["errors"] else "completed"
            if binding["collection"] == "music":
                repo.progress(scan_id, counts, status)
                return repo.scan(scan_id)
            return {"status": status, "counts": counts}

    def music(self, drive, binding, tree, paths, records, repo, scan_id, counts, *, full):
        sidecars = {}
        for identity, path in paths.items():
            if path.suffix.lower() in LYRIC_SUFFIXES and "size" in tree[identity]:
                sidecars[path.with_suffix("")] = tree[identity]
        active = set()
        for identity, path in paths.items():
            if path.suffix.lower() not in MUSIC_SUFFIXES or "size" not in tree[identity]:
                continue
            counts["visited"] += 1
            ref = RemoteObject.from_drive(tree[identity])
            entry = records.get(identity)
            active.add(identity)
            previous = json.loads(entry["media_info"]) if entry else {}
            lyric = sidecars.get(path.with_suffix(""))
            lyric_version = (lyric["id"], str(lyric.get("version", ""))) if lyric else None
            unchanged = not full and matches(entry, ref) and previous.get("path") == path.as_posix()
            if unchanged and previous.get("lyric_version") == (
                list(lyric_version) if lyric_version else None
            ):
                counts["unchanged"] += 1
                continue
            try:
                text = None
                if lyric and 0 < int(lyric["size"]) <= MAX_TEXT_BYTES:
                    lyric_object = RemoteObject.from_drive(lyric)
                    text = decode_text(
                        b"".join(drive.iter_range(lyric_object, 0, lyric_object.size - 1))
                    )
                if unchanged and text is not None:
                    self.set_lyrics(entry["entity_id"], text, lyric_version)
                else:
                    with io.BufferedReader(RemoteRangeFile(drive, ref, path)) as stream:
                        self.index_track(
                            binding,
                            repo,
                            ref,
                            path,
                            stream,
                            scan_id,
                            entry,
                            lyrics=text,
                            lyric_version=lyric_version,
                        )
                counts["updated" if entry else "added"] += 1
            except (MutagenError, ValueError, TypeError, IndexError, OverflowError):
                repo.error(scan_id, path.as_posix(), "metadata_invalid")
                counts["errors"] += 1
                if entry:
                    self.set_missing(entry, status="unreadable")
        for identity, entry in records.items():
            if identity not in active and entry["available"]:
                self.set_missing(entry)
                counts["missing"] += 1

    def set_missing(self, entry, *, status="missing"):
        with self.db.connect(write=True) as db:
            db.execute(
                "UPDATE remote_media_objects SET available=0 WHERE entity_kind=? AND entity_id=? AND remote_file_id=?",
                (entry["entity_kind"], entry["entity_id"], entry["remote_file_id"]),
            )
            if entry["entity_kind"] == "track":
                db.execute("UPDATE tracks SET status=? WHERE id=?", (status, entry["entity_id"]))

    @staticmethod
    def write_lyrics(db, track_id, text):
        db.execute(
            """INSERT INTO track_lyrics(track_id,remote_text) VALUES (?,?)
               ON CONFLICT(track_id) DO UPDATE SET remote_text=excluded.remote_text""",
            (track_id, text),
        )

    def set_lyrics(self, track_id, text, version=None):
        with self.db.connect(write=True) as db:
            db.execute("BEGIN IMMEDIATE")
            self.write_lyrics(db, track_id, text)
            db.execute(
                """UPDATE remote_media_objects SET media_info=json_set(media_info,'$.lyric_version',json(?))
                   WHERE entity_kind='track' AND entity_id=?""",
                (json.dumps(version), track_id),
            )

    def index_track(
        self,
        binding,
        repo,
        ref,
        path,
        stream,
        scan_id,
        entry=None,
        *,
        lyrics=None,
        lyric_version=None,
        sha256=None,
        observed=None,
    ):
        if observed is None:
            audio = mutagen.File(stream)
            if audio is None:
                raise ValueError("metadata_invalid")
            metadata = read_metadata(stream, path, audio=audio)
        else:
            audio, metadata = observed
        info = music_info(audio, metadata) | {
            "path": path.as_posix(),
            "lyric_version": lyric_version,
        }
        cover = _extract_embedded_audio_cover(stream, audio=audio) if metadata.has_cover else None
        relative = path.with_name(f"{path.stem} [{ref.id}]{path.suffix}")
        mtime = int.from_bytes(hashlib.sha256(ref.version.encode()).digest()[:7])
        with self.db.connect(write=True) as db:
            db.execute("BEGIN IMMEDIATE")
            if entry:
                db.execute(
                    "UPDATE tracks SET path=? WHERE id=?", (relative.as_posix(), entry["entity_id"])
                )
            track_id = repo.save(
                relative.as_posix(), metadata, ref.size, mtime, scan_id, sha256, connection=db
            )
            register(db, binding, "track", track_id, ref, info)
            self.write_lyrics(db, track_id, lyrics or embedded_lyrics(audio))
            cover_path = TrackAssets(repo).cache / f"remote-{track_id}.jpg"
            if cover:
                cover_path.parent.mkdir(parents=True, exist_ok=True)
                Books.cache_file(cover_path, cover)
            else:
                cover_path.unlink(missing_ok=True)
        return track_id

    def bookshelf(self, drive, binding, library, tree, paths, records, counts, *, full):
        groups = defaultdict(dict)
        active = set()
        for identity, path in paths.items():
            suffix = path.suffix.lower()
            if "size" not in tree[identity] or suffix not in EBOOK_SUFFIXES | BOOK_AUDIO_SUFFIXES:
                continue
            ref = RemoteObject.from_drive(tree[identity])
            entry = records.get(identity)
            active.add(identity)
            counts["visited"] += 1
            if suffix in BOOK_AUDIO_SUFFIXES:
                parent = next(iter(tree[identity].get("parents", [])), binding["root_folder_id"])
                group = (
                    identity if suffix == ".m4b" or parent == binding["root_folder_id"] else parent
                )
                groups[group][path.parent / ref.id / path.name] = ref
                continue
            if not full and matches(entry, ref):
                counts["unchanged"] += 1
                continue
            try:
                with temporary_media(drive, ref, self.settings.data_dir, MAX_EBOOK_BYTES) as stream:
                    self.books.ebook(
                        library,
                        stream,
                        path.name,
                        "managed_only",
                        book_id=entry["entity_id"] if entry else None,
                        remote=RemoteEbook(drive, binding, path, ref=ref),
                    )
                counts["updated" if entry else "added"] += 1
            except (ValueError, OSError, HTTPException):
                counts["errors"] += 1
        removed_books = {
            entry["entity_id"].split(":")[0]
            for identity, entry in records.items()
            if identity not in active and entry["entity_kind"] == "book_audiobook_file"
        }
        claimed = set()
        for group, items in groups.items():
            entries = [records.get(ref.id) for ref in items.values()]
            candidates = {entry["entity_id"].split(":")[0] for entry in entries if entry} - claimed
            book_id = min(candidates) if candidates else None
            if book_id:
                claimed.add(book_id)
            if (
                book_id
                and book_id not in removed_books
                and all(
                    matches(entry, ref) and entry["entity_id"].startswith(f"{book_id}:")
                    for entry, ref in zip(entries, items.values(), strict=True)
                )
            ):
                counts["unchanged"] += len(items)
                continue
            title = paths[group].stem if group in paths else next(iter(items.values())).name
            try:
                self.books.audiobook(
                    library,
                    Path(),
                    list(items),
                    title,
                    book_id=book_id,
                    remote=RemoteAudiobook(drive, binding, items, self.settings.data_dir),
                )
                counts["updated" if book_id else "added"] += len(items)
            except (MutagenError, ValueError, OSError, HTTPException):
                counts["errors"] += len(items)
        for identity, entry in records.items():
            if identity not in active and entry["available"]:
                self.set_missing(entry)
                counts["missing"] += 1

    def upload_music(self, drive, binding, library, file, relative, *, artist=None, album=None):
        suffix = relative.suffix.lower()
        if suffix not in MUSIC_SUFFIXES | LYRIC_SUFFIXES:
            raise HTTPException(422, "unsupported_audio_format")
        drive.writable()
        stream = file.file
        stream.seek(0, 2)
        size = stream.tell()
        stream.seek(0)
        if size <= 0:
            raise HTTPException(422, "metadata_invalid")
        if size > (MAX_TEXT_BYTES if suffix in LYRIC_SUFFIXES else MAX_AUDIO_BYTES):
            raise HTTPException(413, "file_too_large")
        root = binding["root_folder_id"]
        mime = mimetypes.guess_type(relative.name)[0] or "application/octet-stream"
        target = relative
        with self.write():
            if suffix in LYRIC_SUFFIXES:
                text = decode_text(stream.read())
                if text is None:
                    raise HTTPException(422, "metadata_invalid")
                with self.db.connect(scoped=False) as db:
                    matches_by_name = [
                        (row["entity_id"], Path(json.loads(row["media_info"])["path"]))
                        for row in db.execute(
                            """SELECT entity_id,media_info FROM remote_media_objects
                               WHERE collection='music' AND library_id=? AND available=1""",
                            (binding["library_id"],),
                        )
                    ]
                candidates = [
                    (identity, path)
                    for identity, path in matches_by_name
                    if path.stem.casefold() == relative.stem.casefold()
                ]
                exact = [
                    (identity, path)
                    for identity, path in candidates
                    if path.parent == relative.parent
                ]
                if len(exact or candidates) == 1:
                    track_id, path = (exact or candidates)[0]
                    target = path.with_suffix(suffix)
                else:
                    track_id = None
                stream.seek(0)
                ref = drive.upload_stream(root, target, stream, size, mime)
                if track_id:
                    self.set_lyrics(track_id, text, (ref.id, ref.version))
                return {
                    "status": "imported",
                    "kind": "sidecar",
                    "filename": file.filename,
                    "target_path": target.as_posix(),
                    "relative_path": relative.as_posix(),
                }
            try:
                audio = mutagen.File(stream)
                if audio is None:
                    raise ValueError
                metadata = enrich_metadata(
                    read_metadata(stream, relative, audio=audio),
                    relative,
                    override_artist=artist,
                    override_album=album,
                )
            except (MutagenError, ValueError, TypeError, IndexError):
                raise HTTPException(422, "metadata_invalid") from None
            # Preserve uploaded folder structure so separately uploaded lyrics remain discoverable.
            ref = drive.upload_stream(root, target, stream, size, mime)
            repo = LibraryRepository(self.db, Path(library["root"]), fixed=True)
            run_id = repo.begin_scan()
            self.index_track(binding, repo, ref, target, stream, run_id, observed=(audio, metadata))
            repo.progress(
                run_id, dict.fromkeys(COUNTERS, 0) | {"visited": 1, "added": 1}, "completed"
            )
        return {
            "status": "imported",
            "filename": file.filename,
            "relative_path": relative.as_posix(),
            "target_path": target.as_posix(),
            "title": metadata.title,
            "artist": "、".join(metadata.artists),
            "album": metadata.album,
            "duration_ms": metadata.duration_ms,
            "track_number": metadata.track_number,
            "disc_number": metadata.disc_number,
        }
