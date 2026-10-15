"""Copy a read-only source into an organized, application-managed library."""

import hashlib
import json
import os
import re
import unicodedata
from contextlib import ExitStack, contextmanager
from pathlib import Path
from uuid import uuid4

from filelock import FileLock, Timeout
from mutagen import MutagenError

from wildstring.config import Settings
from wildstring.database import Database
from wildstring.library.albums import album_key
from wildstring.library.assets import IMAGE_SUFFIXES, MAX_COVER_BYTES, TrackAssets
from wildstring.library.lyrics import MAX_TEXT_BYTES
from wildstring.library.metadata import SUPPORTED_SUFFIXES, Metadata, read_metadata
from wildstring.library.repository import LibraryRepository, now
from wildstring.library.scanner import (
    ScanBusyError,
    SourceChangedError,
    fingerprint,
    open_source,
    scan_library,
)

COUNTERS = ("copied", "duplicates", "unchanged", "assets_copied", "conflicts", "errors", "skipped")
RESERVED = re.compile(r"^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)", re.IGNORECASE)


def component(value: str, fallback: str, limit: int = 160) -> str:
    value = unicodedata.normalize("NFKC", value)
    value = re.sub(r'[<>:"/\\|?*\x00-\x1f\x7f]', "_", value)
    value = " ".join(value.split()).strip(" .") or fallback
    value = value.encode("utf-8")[:limit].decode("utf-8", errors="ignore").rstrip(" .") or fallback
    return "_" + value if RESERVED.match(value) else value


def organized_path(metadata: Metadata) -> Path:
    artists = metadata.album_artists or metadata.artists
    artist = component("、".join(artists), "未知艺人", 120)
    album = component(metadata.album or "", "未命名专辑")
    disc = max(1, metadata.disc_number or 1)
    number = (
        f"{metadata.track_number:02d}"
        if metadata.track_number and metadata.track_number > 0
        else "未编号"
    )
    name = component(f"{number} - {metadata.title}", "未命名歌曲")
    return Path(artist) / album / f"CD{disc:02d}" / f"{name}.{metadata.format}"


@contextmanager
def target_directory(root: Path, relative: Path):
    """Create/open parents without following directory symlinks on POSIX."""
    if relative.is_absolute() or not relative.parts or ".." in relative.parts:
        raise OSError("Invalid managed path")
    root.mkdir(parents=True, exist_ok=True)
    if os.open in os.supports_dir_fd:
        with ExitStack() as stack:
            flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
            directory = os.open(root, flags)
            stack.callback(os.close, directory)
            for part in relative.parts[:-1]:
                try:
                    os.mkdir(part, mode=0o700, dir_fd=directory)
                except FileExistsError:
                    pass
                directory = os.open(part, flags, dir_fd=directory)
                stack.callback(os.close, directory)
            yield directory
    else:
        parent = root
        for part in relative.parts[:-1]:
            parent = parent / part
            if parent.is_symlink() or not parent.resolve().is_relative_to(root):
                raise OSError("Managed directory is not safe")
            parent.mkdir(exist_ok=True)
        yield None


def digest(source) -> str:
    source.seek(0)
    hashed = hashlib.sha256()
    for chunk in iter(lambda: source.read(1024 * 1024), b""):
        hashed.update(chunk)
    return hashed.hexdigest()


def target_digest(root: Path, relative: Path) -> str | None:
    try:
        with open_source(root, relative) as stream:
            return digest(stream)
    except FileNotFoundError:
        return None


def copy_exclusive(source, root: Path, relative: Path, expected: str | None = None) -> str:
    """Publish a complete, fsynced file with an exclusive hard link; never replace a destination."""
    source.seek(0)
    before = os.fstat(source.fileno())
    with target_directory(root, relative) as directory:
        temporary = f".wildstring-import-{uuid4().hex}"
        temporary_path = root / relative.parent / temporary
        destination = relative.name if directory is not None else root / relative
        temp_name = temporary if directory is not None else temporary_path
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        descriptor = os.open(temp_name, flags, 0o600, dir_fd=directory)
        try:
            hashed = hashlib.sha256()
            with os.fdopen(descriptor, "wb") as output:
                for chunk in iter(lambda: source.read(1024 * 1024), b""):
                    output.write(chunk)
                    hashed.update(chunk)
                output.flush()
                os.fsync(output.fileno())
            value = hashed.hexdigest()
            if fingerprint(os.fstat(source.fileno())) != fingerprint(before) or (
                expected is not None and value != expected
            ):
                raise SourceChangedError
            os.link(
                temp_name,
                destination,
                src_dir_fd=directory,
                dst_dir_fd=directory,
                follow_symlinks=False,
            )
            return value
        finally:
            os.unlink(temp_name, dir_fd=directory)


class MusicImporter:
    def __init__(self, settings: Settings, database: Database):
        self.settings = settings
        self.database = database
        self.root = settings.library_dir
        self.counts = dict.fromkeys(COUNTERS, 0)
        self.errors: list[dict] = []
        self.run_id = uuid4().hex

    def progress(self, status="running"):
        with self.database.connect(write=True) as connection:
            connection.execute(
                "UPDATE import_runs SET status=?, finished_at=?, counts=?, errors=? WHERE id=?",
                (
                    status,
                    None if status == "running" else now(),
                    json.dumps(self.counts),
                    json.dumps(self.errors),
                    self.run_id,
                ),
            )

    def error(self, path: Path, code: str, *, conflict=False):
        self.counts["conflicts" if conflict else "errors"] += 1
        if len(self.errors) < 100:
            self.errors.append({"path": path.as_posix(), "code": code})

    def manifest(self, relative: Path):
        with self.database.connect() as connection:
            row = connection.execute(
                "SELECT * FROM imported_files WHERE source_root=? AND source_path=? AND target_root=?",
                (str(self.settings.music_dir), relative.as_posix(), str(self.root)),
            ).fetchone()
            return dict(row) if row else None

    def save(self, source: Path, target: Path, info, sha256: str):
        with self.database.connect(write=True) as connection:
            connection.execute(
                "INSERT OR REPLACE INTO imported_files VALUES (?,?,?,?,?,?,?)",
                (
                    str(self.settings.music_dir),
                    source.as_posix(),
                    str(self.root),
                    target.as_posix(),
                    info.st_size,
                    info.st_mtime_ns,
                    sha256,
                ),
            )

    def import_track(self, relative: Path):
        with open_source(self.settings.music_dir, relative) as source:
            before = os.fstat(source.fileno())
            previous = self.manifest(relative)
            if previous is not None:
                target = Path(previous["target_path"])
                # Existing managed edits are deliberately not hashed, replaced or renamed.
                with open_source(self.root, target):
                    pass
                if (before.st_size, before.st_mtime_ns) == (
                    previous["source_size"],
                    previous["source_mtime"],
                ):
                    self.counts["unchanged"] += 1
                elif digest(source) != previous["sha256"]:
                    self.error(relative, "source_changed_managed_copy_preserved", conflict=True)
                    return
                else:
                    self.save(relative, target, before, previous["sha256"])
                    self.counts["unchanged"] += 1
            else:
                metadata = read_metadata(source, relative)
                if fingerprint(os.fstat(source.fileno())) != fingerprint(before):
                    raise SourceChangedError
                sha256 = digest(source)
                if fingerprint(os.fstat(source.fileno())) != fingerprint(before):
                    raise SourceChangedError
                # Identical source recordings reuse an existing managed copy, even under another name.
                with self.database.connect() as connection:
                    duplicate = connection.execute(
                        "SELECT target_path FROM imported_files WHERE target_root=? AND sha256=? LIMIT 1",
                        (str(self.root), sha256),
                    ).fetchone()
                if duplicate is not None:
                    target = Path(duplicate[0])
                    with open_source(self.root, target):
                        pass
                    self.counts["duplicates"] += 1
                else:
                    target = organized_path(metadata)
                    for length in (0, 8, 16, 32, 64):
                        candidate = (
                            target
                            if length == 0
                            else target.with_name(
                                f"{target.stem} [{sha256[:length]}]{target.suffix}"
                            )
                        )
                        existing = target_digest(self.root, candidate)
                        if existing == sha256:
                            self.counts["duplicates"] += 1
                            target = candidate
                            break
                        if existing is None:
                            copy_exclusive(source, self.root, candidate, sha256)
                            self.counts["copied"] += 1
                            target = candidate
                            break
                    else:
                        self.error(relative, "target_collision", conflict=True)
                        return
                self.save(relative, target, before, sha256)
        self.import_sidecars(relative, target)

    def import_sidecars(self, relative: Path, target: Path):
        # Reuse the same exact-name rules as playback. No fuzzy lyric matching.
        source_assets = TrackAssets(LibraryRepository(self.database, self.settings.music_dir))
        candidates = list(
            source_assets.candidates(relative, [relative.stem], (".lrc", ".lryc", ".txt"))
        )
        pictures = list(
            source_assets.candidates(
                relative, [relative.stem, "cover", "folder", "front"], IMAGE_SUFFIXES
            )
        )
        candidates.extend(pictures[:1])
        for sidecar in candidates:
            extension = sidecar.suffix.lower()
            is_image = extension in IMAGE_SUFFIXES
            limit = MAX_COVER_BYTES if is_image else MAX_TEXT_BYTES
            destination = (
                target.with_suffix(extension)
                if not is_image or sidecar.stem.casefold() == relative.stem.casefold()
                else target.parent / f"cover{extension}"
            )
            with open_source(self.settings.music_dir, sidecar) as source:
                if os.fstat(source.fileno()).st_size > limit:
                    self.error(sidecar, "sidecar_too_large")
                    continue
                value = digest(source)
                existing = target_digest(self.root, destination)
                if existing is None:
                    copy_exclusive(source, self.root, destination, value)
                    self.counts["assets_copied"] += 1
                elif existing != value:
                    self.error(sidecar, "managed_sidecar_preserved", conflict=True)

    def migrate_legacy(self):
        # Preserve IDs from the earlier direct-source catalog while moving each imported path.
        with self.database.connect(write=True) as connection:
            old = connection.execute(
                "SELECT id FROM libraries WHERE root=?", (str(self.settings.music_dir),)
            ).fetchone()
            if old is None:
                return
            connection.execute(
                "INSERT OR IGNORE INTO libraries VALUES (?,?)", (uuid4().hex, str(self.root))
            )
            new = connection.execute(
                "SELECT id FROM libraries WHERE root=?", (str(self.root),)
            ).fetchone()[0]
            rows = connection.execute(
                """SELECT t.id, t.album, t.album_artists, i.target_path FROM tracks t
                JOIN imported_files i ON i.source_path=t.path
                WHERE t.library_id=? AND i.source_root=? AND i.target_root=?""",
                (old[0], str(self.settings.music_dir), str(self.root)),
            ).fetchall()
            for row in rows:
                collision = connection.execute(
                    "SELECT id FROM tracks WHERE library_id=? AND path=?", (new, row["target_path"])
                ).fetchone()
                if collision is None:
                    connection.execute(
                        "UPDATE tracks SET library_id=?, path=?, album_id=? WHERE id=?",
                        (
                            new,
                            row["target_path"],
                            album_key(
                                new,
                                row["target_path"],
                                row["album"],
                                json.loads(row["album_artists"]),
                            ),
                            row["id"],
                        ),
                    )
            if not connection.execute(
                "SELECT 1 FROM tracks WHERE library_id=? LIMIT 1", (old[0],)
            ).fetchone():
                connection.execute(
                    "UPDATE scan_runs SET library_id=? WHERE library_id=?", (new, old[0])
                )

    def run(self, *, full=False, on_import=None, on_scan=None):
        with self.database.connect(write=True) as connection:
            connection.execute(
                "UPDATE import_runs SET status='interrupted', finished_at=? WHERE status='running'",
                (now(),),
            )
            connection.execute(
                "INSERT INTO import_runs VALUES (?,?,?,?,?,?)",
                (self.run_id, "running", now(), None, json.dumps(self.counts), "[]"),
            )
        if on_import is not None:
            on_import(self.run_id)
        try:
            with os.scandir(self.settings.music_dir) as entries:
                next(entries, None)

            def walk_error(error):
                self.error(Path("."), "source_directory_unreadable")

            for directory, folders, files in os.walk(
                self.settings.music_dir, followlinks=False, onerror=walk_error
            ):
                folders[:] = sorted(
                    name for name in folders if not (Path(directory) / name).is_symlink()
                )
                for name in sorted(files):
                    path = Path(directory) / name
                    if path.suffix.lower() not in SUPPORTED_SUFFIXES or path.is_symlink():
                        self.counts["skipped"] += 1
                        continue
                    relative = path.relative_to(self.settings.music_dir)
                    try:
                        self.import_track(relative)
                    except SourceChangedError:
                        self.error(relative, "source_changed_during_import")
                    except (
                        OSError,
                        MutagenError,
                        ValueError,
                        TypeError,
                        IndexError,
                        OverflowError,
                    ):
                        self.error(relative, "import_file_unavailable")
                    self.progress()
            self.migrate_legacy()
            scan = scan_library(self.settings, full=full, _lock_owned=True, on_start=on_scan)
            status = (
                "completed_with_errors"
                if self.counts["errors"]
                or self.counts["conflicts"]
                or scan["status"] != "completed"
                else "completed"
            )
        except OSError:
            self.error(Path("."), "source_unavailable")
            status, scan = "failed", None
        except BaseException:
            self.progress("interrupted")
            raise
        self.progress(status)
        return {
            "id": self.run_id,
            "status": status,
            "counts": self.counts,
            "errors": self.errors,
            "scan": scan,
        }


def import_music(settings: Settings, *, full=False, on_import=None, on_scan=None):
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    settings.library_dir.mkdir(parents=True, exist_ok=True)
    try:
        with FileLock(settings.data_dir / "library-scan.lock", timeout=0):
            database = Database(settings.data_dir)
            database.initialize()
            return MusicImporter(settings, database).run(
                full=full, on_import=on_import, on_scan=on_scan
            )
    except Timeout as error:
        raise ScanBusyError from error
