"""No-follow directory descriptor and regular-file opening primitives."""

import os
import stat
from contextlib import contextmanager, suppress
from pathlib import Path


class SourceChangedError(Exception):
    """The source changed while metadata was being read."""


@contextmanager
def open_directory(path, *, dir_fd=None):
    """Own each directory descriptor explicitly, including failed nested opens."""
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=dir_fd)
    try:
        yield descriptor
    finally:
        os.close(descriptor)


@contextmanager
def _walk_directories(parts: tuple[str, ...], directory: int, *, create: bool = False):
    if not parts:
        yield directory
        return
    part = parts[0]
    if create:
        # Existing parents are validated by the no-follow open below.
        with suppress(FileExistsError):
            os.mkdir(part, mode=0o700, dir_fd=directory)
    with open_directory(part, dir_fd=directory) as child:
        with _walk_directories(parts[1:], child, create=create) as parent:
            yield parent


@contextmanager
def open_parent_directory(root: Path, relative: Path, *, create: bool = False):
    """Open relative's parent directory without following symlinks on POSIX."""
    if (
        relative.is_absolute()
        or not relative.parts
        or any(part in {".", ".."} for part in relative.parts)
    ):
        raise OSError("Invalid library path")
    if os.open in os.supports_dir_fd:
        if create:
            root.mkdir(parents=True, exist_ok=True)
        with open_directory(root) as directory:
            with _walk_directories(relative.parts[:-1], directory, create=create) as parent:
                yield parent
        return
    if create:
        root.mkdir(parents=True, exist_ok=True)
        base = os.path.realpath(root)
        parent = root
        for part in relative.parts[:-1]:
            parent = parent / part
            resolved = os.path.realpath(parent)
            if parent.is_symlink() or os.path.commonpath([base, resolved]) != base:
                raise OSError("Managed directory is not safe")
            parent.mkdir(exist_ok=True)
    yield None


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
        base = os.path.join(os.path.abspath(root), "")
        path = os.path.abspath(root / relative)
        if not path.startswith(base):
            raise OSError("Source is outside the library")
        with open_parent_directory(root, relative) as directory:
            descriptor = os.open(
                os.path.basename(path),
                os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                dir_fd=directory,
            )
            with os.fdopen(descriptor, "rb") as source:
                if not stat.S_ISREG(os.fstat(source.fileno()).st_mode):
                    raise OSError("Source is not a regular file")
                yield source
        return
    base = os.path.realpath(root)
    path = root / relative
    resolved = os.path.realpath(path)
    if path.is_symlink() or os.path.commonpath([base, resolved]) != base:
        raise OSError("Source is outside the library")
    with open(resolved, "rb") as source:
        if not stat.S_ISREG(os.fstat(source.fileno()).st_mode):
            raise OSError("Source is not a regular file")
        yield source


def fingerprint(value: os.stat_result) -> tuple[int, int, int, int]:
    return value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns
