"""A read-only, incremental scanner isolated from the HTTP process."""

import os
import stat
from contextlib import ExitStack, contextmanager
from pathlib import Path

from filelock import FileLock, Timeout
from mutagen import MutagenError

from wildstring.config import Settings
from wildstring.database import Database
from wildstring.library.metadata import SUPPORTED_SUFFIXES, read_metadata
from wildstring.library.repository import COUNTERS, LibraryRepository


class ScanBusyError(Exception):
    """Another scanner owns this data directory."""


class SourceChangedError(Exception):
    """The source changed while metadata was being read."""


@contextmanager
def open_source(root: Path, relative: Path):
    """Open only regular files, without following symlinks on POSIX hosts."""
    if (
        relative.is_absolute()
        or not relative.parts
        or any(part in {".", ".."} for part in relative.parts)
    ):
        raise OSError("Invalid library path")
    if os.open in os.supports_dir_fd:
        with ExitStack() as stack:
            directory_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
            directory = os.open(root, directory_flags)
            stack.callback(os.close, directory)
            for part in relative.parts[:-1]:
                directory = os.open(part, directory_flags, dir_fd=directory)
                stack.callback(os.close, directory)
            descriptor = os.open(
                relative.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory
            )
            with os.fdopen(descriptor, "rb") as source:
                if not stat.S_ISREG(os.fstat(source.fileno()).st_mode):
                    raise OSError("Source is not a regular file")
                yield source
    else:
        path = root / relative
        if path.is_symlink() or not path.resolve().is_relative_to(root):
            raise OSError("Source is outside the library")
        with path.open("rb") as source:
            if not stat.S_ISREG(os.fstat(source.fileno()).st_mode):
                raise OSError("Source is not a regular file")
            yield source


def fingerprint(value: os.stat_result) -> tuple[int, int, int, int]:
    return value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns


def scan_library(
    settings: Settings, *, full: bool = False, _lock_owned: bool = False, on_start=None
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
        repository = LibraryRepository(database, settings.library_dir)
        run_id = repository.begin_scan()
        if on_start is not None:
            on_start(run_id)
        counts = dict.fromkeys(COUNTERS, 0)
        complete = True

        def record_error(path: str, code: str) -> None:
            counts["errors"] += 1
            repository.error(run_id, path, code)
            repository.progress(run_id, counts)

        def directory_error(error: OSError) -> None:
            nonlocal complete
            complete = False
            try:
                path = str(Path(error.filename).relative_to(settings.library_dir))
            except (TypeError, ValueError):
                path = "."
            record_error(path, "directory_unreadable")

        try:
            root_stat = settings.library_dir.stat()
            if not stat.S_ISDIR(root_stat.st_mode):
                raise OSError("Music root is not a directory")
            # Checking scandir explicitly distinguishes an unavailable root from an empty library.
            with os.scandir(settings.library_dir) as entries:
                next(entries, None)
            for directory, folders, files in os.walk(
                settings.library_dir, followlinks=False, onerror=directory_error
            ):
                normal_folders = [
                    name for name in folders if not (Path(directory) / name).is_symlink()
                ]
                counts["skipped"] += len(folders) - len(normal_folders)
                folders[:] = sorted(normal_folders)
                for name in sorted(files):
                    path = Path(directory) / name
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
                            repository.touch(existing["id"], run_id)
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
                            repository.save(
                                key, metadata, before.st_size, before.st_mtime_ns, run_id
                            )
                            counts["updated" if existing else "added"] += 1
                    except SourceChangedError:
                        record_error(key, "file_changed")
                    except OSError:
                        record_error(key, "file_unreadable")
                    except (MutagenError, ValueError, TypeError, IndexError, OverflowError):
                        record_error(key, "metadata_invalid")
                    repository.progress(run_id, counts)
            final_root = settings.library_dir.stat()
            if (root_stat.st_dev, root_stat.st_ino) != (final_root.st_dev, final_root.st_ino):
                raise OSError("Music root changed during scanning")
            if complete:
                counts["missing"] = repository.mark_missing(run_id)
            status = "completed" if counts["errors"] == 0 else "completed_with_errors"
        except OSError:
            record_error(".", "root_unavailable")
            status = "failed"
        except BaseException:
            repository.progress(run_id, counts, "interrupted")
            raise
        repository.progress(run_id, counts, status)
        return repository.scan(run_id)
    finally:
        if not _lock_owned:
            lock.release()
