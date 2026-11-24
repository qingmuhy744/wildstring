"""Safe managed-file naming, hashing and exclusive publication for import and intake."""

import errno
import hashlib
import os
import re
import stat
import unicodedata
from contextlib import contextmanager, suppress
from pathlib import Path
from uuid import uuid4

from wildstring.library.fs import (
    SourceChangedError,
    fingerprint,
    open_parent_directory,
    open_source,
)
from wildstring.library.metadata import Metadata

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
    with open_parent_directory(root, relative, create=True) as directory:
        yield directory


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


class HardlinkError(OSError):
    def __init__(self, error):
        self.code = "hardlink_cross_device" if error == errno.EXDEV else "hardlink_not_supported"
        super().__init__(error, self.code)


def _link_descriptor(source, directory, name, *, src_dir_fd=None, src_name=None):
    """Publish the opened inode directly without following symlinks."""
    if directory is None:
        raise HardlinkError(errno.ENOTSUP)
    if Path("/proc/self/fd").is_dir():
        try:
            os.link(f"/proc/self/fd/{source.fileno()}", name, dst_dir_fd=directory)
            return
        except FileExistsError:
            raise
        except OSError as error:
            raise HardlinkError(error.errno) from error
    if src_dir_fd is None or src_name is None:
        raise HardlinkError(errno.ENOTSUP)
    try:
        os.link(src_name, name, src_dir_fd=src_dir_fd, dst_dir_fd=directory, follow_symlinks=False)
    except FileExistsError:
        raise
    except OSError as error:
        raise HardlinkError(error.errno) from error
    linked_stat = os.stat(name, dir_fd=directory, follow_symlinks=False)
    if not os.path.samestat(linked_stat, os.fstat(source.fileno())):
        with suppress(OSError):
            os.unlink(name, dir_fd=directory)
        raise SourceChangedError


@contextmanager
def _source_parent(root: Path | None, relative: Path | None):
    if root is None or relative is None or Path("/proc/self/fd").is_dir():
        yield None, None
        return
    with open_parent_directory(root, relative) as directory:
        yield directory, relative.name


def link_exclusive(
    source,
    root: Path,
    relative: Path,
    expected: str | None = None,
    *,
    source_root: Path | None = None,
    source_relative: Path | None = None,
) -> str:
    """Publish a verified regular source inode without overwriting a target."""
    before = fingerprint(os.fstat(source.fileno()))
    value = digest(source)
    if fingerprint(os.fstat(source.fileno())) != before or (
        expected is not None and expected != value
    ):
        raise SourceChangedError
    with (
        target_directory(root, relative) as directory,
        _source_parent(source_root, source_relative) as (src_dir_fd, src_name),
    ):
        _link_descriptor(
            source,
            directory,
            relative.name,
            src_dir_fd=src_dir_fd,
            src_name=src_name,
        )
        if fingerprint(os.fstat(source.fileno())) != before:
            os.unlink(relative.name, dir_fd=directory)
            raise SourceChangedError
    return value


def validate_hardlink_capability(source_roots, managed_root: Path, suffixes):
    parent = managed_root
    while not parent.exists():
        parent = parent.parent
    for root in source_roots:
        if root.stat().st_dev != parent.stat().st_dev:
            raise HardlinkError(errno.EXDEV)
        for directory, folders, files in os.walk(root, followlinks=False):
            folders[:] = sorted(name for name in folders if not name.startswith("."))
            sample = next(
                (
                    path
                    for name in sorted(files)
                    if not name.startswith(".")
                    and (path := Path(directory) / name).suffix.lower() in suffixes
                    and stat.S_ISREG(path.lstat().st_mode)
                ),
                None,
            )
            if sample is not None:
                name = f".wildstring-probe-{uuid4().hex}"
                rel = sample.relative_to(root)
                with (
                    open_source(root, rel) as source,
                    target_directory(parent, Path(name)) as descriptor,
                    _source_parent(root, rel) as (src_dir_fd, src_name),
                ):
                    _link_descriptor(
                        source,
                        descriptor,
                        name,
                        src_dir_fd=src_dir_fd,
                        src_name=src_name,
                    )
                    os.unlink(name, dir_fd=descriptor)
                break


def replace_managed_file(
    publish,
    source,
    root: Path,
    relative: Path,
    expected: str,
    **kwargs,
) -> None:
    """Replace one directory entry without writing to its old inode."""
    temporary = relative.with_name(f".wildstring-replace-{uuid4().hex}")
    publish(source, root, temporary, expected, **kwargs)
    with target_directory(root, relative) as directory:
        old = temporary.name if directory is not None else root / temporary
        new = relative.name if directory is not None else root / relative
        try:
            os.replace(old, new, src_dir_fd=directory, dst_dir_fd=directory)
        finally:
            with suppress(FileNotFoundError):
                os.unlink(old, dir_fd=directory)
