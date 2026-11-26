"""A read-only, incremental scanner isolated from the HTTP process."""

import os
import stat
import time
from pathlib import Path

from filelock import FileLock, Timeout
from mutagen import MutagenError

from wildstring.config import Settings
from wildstring.database import Database
from wildstring.library.fs import SourceChangedError, fingerprint, open_directory, open_source
from wildstring.library.metadata import SUPPORTED_SUFFIXES, read_metadata
from wildstring.library.repository import COUNTERS, LibraryRepository

__all__ = [
    "ScanBusyError",
    "SourceChangedError",
    "fingerprint",
    "open_directory",
    "open_source",
    "scan_library",
]


class ScanBusyError(Exception):
    """Another scanner owns this data directory."""


def scan_library(
    settings: Settings,
    *,
    full: bool = False,
    paths: set[str] | None = None,
    _lock_owned: bool = False,
    on_start=None,
) -> dict:
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    lock = FileLock(settings.data_dir / "library-scan.lock", timeout=0)
    if not _lock_owned:
        try:
            lock.acquire()
        except Timeout as error:
            raise ScanBusyError from error
    try:
        database = Database(settings.data_dir)
        database.initialize()
        from wildstring.library.scope import scoped_settings

        settings = scoped_settings(settings, database)
        repository = LibraryRepository(database, settings.library_dir)
        with database.connect() as db:
            backend = db.execute(
                "SELECT storage_backend FROM libraries WHERE id=?", (repository.library_id(),)
            ).fetchone()
        if backend is not None and backend[0] == "gdrive":
            from fastapi import HTTPException

            raise HTTPException(409, "remote_storage_local_operation")
        run_id = repository.begin_scan()
        if on_start is not None:
            on_start(run_id)
        counts = dict.fromkeys(COUNTERS, 0)
        complete = True
        unchanged = []
        last_progress = time.monotonic()

        def report(status="running"):
            nonlocal last_progress
            if unchanged:
                repository.touch_many(unchanged, run_id)
                unchanged.clear()
            repository.progress(run_id, counts, status)
            last_progress = time.monotonic()

        def record_error(path: str, code: str) -> None:
            counts["errors"] += 1
            repository.error(run_id, path, code)

        def directory_error(error: OSError) -> None:
            nonlocal complete
            complete = False
            try:
                path = str(Path(error.filename).relative_to(settings.library_dir))
            except (TypeError, ValueError):
                path = "."
            record_error(path, "directory_unreadable")

        from wildstring.library.sidecar import (
            album_folder,
            clear_removed_sidecar,
            inspect_folder_sidecar,
            load_sidecar_states,
            restore_music_track,
            save_sidecar_state,
        )

        library_id = repository.library_id()
        known_sidecars = load_sidecar_states(database, library_id)
        folder_checks: dict[Path, tuple[str, int | None, str | None]] = {}

        def candidates():
            if paths is not None:
                for key in sorted(paths):
                    yield settings.library_dir / key
                return
            for directory, folders, files in os.walk(
                settings.library_dir, followlinks=False, onerror=directory_error
            ):
                folders[:] = [name for name in folders if name != ".wildstring"]
                normal_folders = [
                    name for name in folders if not (Path(directory) / name).is_symlink()
                ]
                counts["skipped"] += len(folders) - len(normal_folders)
                folders[:] = sorted(normal_folders)
                for name in sorted(files):
                    yield Path(directory) / name

        try:
            root_stat = settings.library_dir.stat()
            if not stat.S_ISDIR(root_stat.st_mode):
                raise OSError("Music root is not a directory")
            # Checking scandir explicitly distinguishes an unavailable root from an empty library.
            with os.scandir(settings.library_dir) as entries:
                next(entries, None)
            for path in candidates():
                from wildstring.library.scope import require_current_library

                require_current_library(database, "library:manage")
                if path.suffix.lower() not in SUPPORTED_SUFFIXES or path.is_symlink():
                    counts["skipped"] += 1
                    continue
                relative = path.relative_to(settings.library_dir)
                key = relative.as_posix()
                counts["visited"] += 1
                try:
                    before = path.stat(follow_symlinks=False)
                    if not stat.S_ISREG(before.st_mode):
                        raise OSError("Source is not a regular file")
                    existing = repository.existing(key)
                    if (
                        not full
                        and existing is not None
                        and existing["status"] == "available"
                        and existing["size_bytes"] == before.st_size
                        and existing["mtime_ns"] == before.st_mtime_ns
                    ):
                        unchanged.append(existing["id"])
                        counts["unchanged"] += 1
                    else:
                        with open_source(settings.library_dir, relative) as source:
                            if fingerprint(os.fstat(source.fileno())) != fingerprint(before):
                                raise SourceChangedError
                            metadata = read_metadata(source, path)
                            if fingerprint(os.fstat(source.fileno())) != fingerprint(before):
                                raise SourceChangedError
                        if fingerprint(path.stat(follow_symlinks=False)) != fingerprint(before):
                            raise SourceChangedError
                        repository.save(key, metadata, before.st_size, before.st_mtime_ns, run_id)
                        counts["updated" if existing else "added"] += 1
                    folder = album_folder(relative)
                    if folder not in folder_checks:
                        folder_checks[folder] = inspect_folder_sidecar(
                            settings.library_dir,
                            folder,
                            known_sidecars.get(folder.as_posix()),
                        )
                    sidecar_state, _, _ = folder_checks[folder]
                    if (
                        existing is None or full or sidecar_state == "changed"
                    ) and restore_music_track(
                        database,
                        settings.library_dir,
                        library_id,
                        relative,
                        settings.library_dir,
                        folder,
                        sync_unlocked=(sidecar_state == "changed" and existing is not None),
                    ):
                        pass
                except SourceChangedError:
                    record_error(key, "file_changed")
                except OSError:
                    record_error(key, "file_unreadable")
                except (MutagenError, ValueError, TypeError, IndexError, OverflowError):
                    record_error(key, "metadata_invalid")
                if len(unchanged) >= 250 or time.monotonic() - last_progress >= 0.5:
                    report()
            final_root = settings.library_dir.stat()
            if (root_stat.st_dev, root_stat.st_ino) != (final_root.st_dev, final_root.st_ino):
                raise OSError("Music root changed during scanning")
            if unchanged:
                repository.touch_many(unchanged, run_id)
                unchanged.clear()
            if complete and paths is None:
                counts["missing"] = repository.mark_missing(run_id)
            for folder, (sidecar_state, mtime_ns, manifest_sha) in folder_checks.items():
                if (
                    sidecar_state in {"changed", "touched"}
                    and mtime_ns is not None
                    and manifest_sha
                ):
                    save_sidecar_state(database, library_id, folder, mtime_ns, manifest_sha)
                elif sidecar_state == "removed":
                    clear_removed_sidecar(database, settings.library_dir, library_id, folder)
            status = "completed" if counts["errors"] == 0 else "completed_with_errors"
        except OSError:
            record_error(".", "root_unavailable")
            status = "failed"
        except BaseException:
            report("interrupted")
            raise
        report(status)
        return repository.scan(run_id)
    finally:
        if not _lock_owned:
            lock.release()
