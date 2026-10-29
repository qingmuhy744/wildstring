"""Copy a read-only source into an organized, application-managed library."""

import json
import os
from pathlib import Path
from uuid import uuid4

from filelock import FileLock, Timeout
from mutagen import MutagenError

from wildstring.config import Settings
from wildstring.database import Database
from wildstring.library.albums import album_key
from wildstring.library.assets import IMAGE_SUFFIXES, MAX_COVER_BYTES, TrackAssets
from wildstring.library.import_files import copy_exclusive, digest, organized_path, target_digest
from wildstring.library.intake import INPUT_SUFFIXES, Intake
from wildstring.library.lyrics import MAX_TEXT_BYTES
from wildstring.library.metadata import read_metadata
from wildstring.library.repository import LibraryRepository, now
from wildstring.library.scanner import (
    ScanBusyError,
    SourceChangedError,
    fingerprint,
    open_source,
    scan_library,
)

COUNTERS = (
    "copied",
    "duplicates",
    "unchanged",
    "assets_copied",
    "conflicts",
    "errors",
    "skipped",
    "review",
    "waiting",
    "converted",
)


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

    def import_track(self, relative: Path, *, metadata=None):
        from wildstring.library.scope import require_current_library

        require_current_library(self.database, "library:import")
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
                    return None
                else:
                    self.save(relative, target, before, previous["sha256"])
                    self.counts["unchanged"] += 1
            else:
                observed = read_metadata(source, relative)
                allow_global_duplicate = metadata is None or organized_path(
                    metadata
                ) == organized_path(observed)
                metadata = metadata or observed
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
                if duplicate is not None and allow_global_duplicate:
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
                        return None
                self.save(relative, target, before, sha256)
        self.import_sidecars(relative, target)
        return target

    def import_sidecars(self, relative: Path, target: Path):
        # Reuse the same exact-name rules as playback. No fuzzy lyric matching.
        source_assets = TrackAssets(
            LibraryRepository(self.database, self.settings.music_dir, fixed=True)
        )
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
                "SELECT id,enabled FROM libraries WHERE root=?", (str(self.settings.music_dir),)
            ).fetchone()
            if old is None:
                return
            connection.execute(
                "INSERT OR IGNORE INTO libraries(id,root) VALUES (?,?)",
                (uuid4().hex, str(self.root)),
            )
            new = connection.execute(
                "SELECT id FROM libraries WHERE root=?", (str(self.root),)
            ).fetchone()[0]
            if old[0] != new and old["enabled"]:
                connection.execute(
                    "INSERT OR IGNORE INTO user_library_access SELECT user_id,? FROM user_library_access WHERE library_id=?",
                    (new, old[0]),
                )
                connection.execute("DELETE FROM user_library_access WHERE library_id=?", (old[0],))
                connection.execute("UPDATE libraries SET enabled=0 WHERE id=?", (old[0],))
                connection.execute(
                    "UPDATE libraries SET is_default=1 WHERE id=? AND EXISTS(SELECT 1 FROM libraries WHERE id=? AND is_default=1)",
                    (new, old[0]),
                )
                connection.execute("UPDATE libraries SET is_default=0 WHERE id=?", (old[0],))
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

    def run(
        self,
        *,
        full=False,
        on_import=None,
        on_scan=None,
        automatic=False,
        relative_root=None,
    ):
        repository = LibraryRepository(self.database, self.root)
        repository.library_id(create=True)
        intake = Intake(self.settings, repository)
        source_root = (
            self.settings.music_dir
            if relative_root in {None, "."}
            else self.settings.music_dir / relative_root
        ).resolve()
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
            if (
                not source_root.is_relative_to(self.settings.music_dir.resolve())
                or not source_root.is_dir()
            ):
                raise OSError("Source folder is unavailable")
            with os.scandir(source_root) as entries:
                next(entries, None)

            def walk_error(error):
                self.error(Path("."), "source_directory_unreadable")

            for directory, folders, files in os.walk(
                source_root, followlinks=False, onerror=walk_error
            ):
                folders[:] = sorted(
                    name
                    for name in folders
                    if not (Path(directory) / name).is_symlink() and not name.startswith(".")
                )
                for name in sorted(files):
                    path = Path(directory) / name
                    if (
                        path.suffix.lower() not in INPUT_SUFFIXES
                        or path.is_symlink()
                        or name.startswith(".")
                    ):
                        self.counts["skipped"] += 1
                        continue
                    relative = path.relative_to(self.settings.music_dir)
                    try:
                        intake.process(self, relative, automatic)
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
            intake.apply_overrides()
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


def import_music(
    settings: Settings,
    *,
    full=False,
    on_import=None,
    on_scan=None,
    automatic=False,
    relative_root=None,
):
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    try:
        with FileLock(settings.data_dir / "library-scan.lock", timeout=0):
            database = Database(settings.data_dir)
            database.initialize()
            from wildstring.library.scope import scoped_settings

            settings = scoped_settings(settings, database)
            settings.library_dir.mkdir(parents=True, exist_ok=True)
            return MusicImporter(settings, database).run(
                full=full,
                on_import=on_import,
                on_scan=on_scan,
                automatic=automatic,
                relative_root=relative_root,
            )
    except Timeout as error:
        raise ScanBusyError from error
