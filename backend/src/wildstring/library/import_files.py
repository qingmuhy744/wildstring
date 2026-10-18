"""Safe managed-file naming, hashing and exclusive publication for import and intake."""

import hashlib
import os
import re
import unicodedata
from contextlib import ExitStack, contextmanager, suppress
from pathlib import Path
from uuid import uuid4

from wildstring.library.metadata import Metadata
from wildstring.library.scanner import SourceChangedError, fingerprint, open_directory, open_source

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
            directory = stack.enter_context(open_directory(root))
            for part in relative.parts[:-1]:
                # Existing parents are validated by the no-follow open below.
                with suppress(FileExistsError):
                    os.mkdir(part, mode=0o700, dir_fd=directory)
                directory = stack.enter_context(open_directory(part, dir_fd=directory))
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
