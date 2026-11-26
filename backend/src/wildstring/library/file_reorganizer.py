"""Safe managed-file reorganization within the same mount without touching bytes."""

import errno
import json
import os
from contextlib import suppress
from pathlib import Path

from fastapi import HTTPException
from filelock import FileLock, Timeout

from wildstring.library.edits import apply_effective
from wildstring.library.fs import open_parent_directory, open_source
from wildstring.library.import_files import organized_path, target_directory
from wildstring.library.metadata import Metadata

SIDECAR_SUFFIXES = {
    ".lrc",
    ".lryc",
    ".txt",
    ".cue",
    ".jpg",
    ".jpeg",
    ".png",
    ".webp",
    ".log",
}


def get_track_file_info(repository, track_id: str, *, include_host_paths: bool = False):
    with repository.database.connect() as connection:
        row = connection.execute(
            """SELECT t.id, t.path, t.title, t.artists, t.album, t.album_artists,
                      t.track_number, t.disc_number, t.duration_ms, t.format,
                      t.sample_rate, t.channels, t.has_cover, t.size_bytes, t.mtime_ns,
                      m.observed, m.overrides
               FROM tracks t
               LEFT JOIN track_metadata m ON m.track_id=t.id
               WHERE t.id=? AND t.library_id=?""",
            (track_id, repository.library_id()),
        ).fetchone()
        if row is None:
            raise HTTPException(404, "track_not_found")
        source_row = connection.execute(
            "SELECT source_path FROM imported_files WHERE target_root=? AND target_path=? LIMIT 1",
            (str(Path(repository.root)), row["path"]),
        ).fetchone()

    current_path = row["path"]
    root = Path(repository.root)
    full_path = root / current_path
    file_exists = full_path.is_file()

    observed = json.loads(row["observed"]) if row["observed"] else {}
    overrides = json.loads(row["overrides"]) if row["overrides"] else {}
    effective = observed | overrides

    meta = Metadata(
        title=effective.get("title") or row["title"] or "未命名歌曲",
        title_source="user",
        artists=effective.get("artists") or json.loads(row["artists"] or "[]"),
        album=effective.get("album") or row["album"],
        album_artists=effective.get("album_artists") or json.loads(row["album_artists"] or "[]"),
        track_number=effective.get("track_number") or row["track_number"],
        disc_number=effective.get("disc_number") or row["disc_number"],
        duration_ms=row["duration_ms"],
        format=row["format"],
        sample_rate=row["sample_rate"],
        channels=row["channels"],
        has_cover=bool(row["has_cover"]),
    )
    suggested = str(organized_path(meta))

    source_path = source_row["source_path"] if source_row else None
    source_filename = Path(source_path).name if source_path else Path(current_path).name

    return {
        "track_id": track_id,
        "title": row["title"],
        "path": current_path,
        "source_path": source_path if include_host_paths else None,
        "source_filename": source_filename,
        "library_root": str(root) if include_host_paths else None,
        "full_path": str(full_path) if include_host_paths else None,
        "absolute_path": str(full_path) if include_host_paths else None,
        "file_exists": file_exists,
        "size_bytes": row["size_bytes"],
        "format": row["format"],
        "sample_rate": row["sample_rate"],
        "channels": row["channels"],
        "duration_ms": row["duration_ms"],
        "mtime_ns": row["mtime_ns"],
        "suggested_path": suggested,
        "in_sync": (current_path == suggested),
    }


def _replace_entry(root: Path, old_rel: Path, new_rel: Path) -> int:
    with open_parent_directory(root, old_rel) as src_fd, target_directory(root, new_rel) as dst_fd:
        try:
            old_stat = os.stat(old_rel.name, dir_fd=src_fd, follow_symlinks=False)
        except FileNotFoundError as error:
            raise HTTPException(404, "source_file_missing") from error
        with suppress(FileNotFoundError):
            dst_stat = os.stat(new_rel.name, dir_fd=dst_fd, follow_symlinks=False)
            if not os.path.samestat(old_stat, dst_stat):
                raise HTTPException(409, "destination_file_exists")
        try:
            os.replace(old_rel.name, new_rel.name, src_dir_fd=src_fd, dst_dir_fd=dst_fd)
        except OSError as error:
            if error.errno == errno.EXDEV:
                raise HTTPException(422, "hardlink_cross_device") from error
            raise
        return int(os.stat(new_rel.name, dir_fd=dst_fd, follow_symlinks=False).st_mtime_ns)


def reorganize_track_file(repository, track_id: str):
    from wildstring.library.sidecar import album_folder, export_music

    lock_path = repository.database.path.parent / "library-scan.lock"
    try:
        with FileLock(str(lock_path), timeout=2):
            info = get_track_file_info(repository, track_id)
            current_path = info["path"]
            suggested_path = info["suggested_path"]

            if current_path == suggested_path:
                return {"status": "already_organized", "path": current_path, "changed": False}

            root = Path(repository.root)
            old_rel = Path(current_path)
            new_rel = Path(suggested_path)

            try:
                with open_source(root, old_rel):
                    pass
            except OSError as error:
                raise HTTPException(404, "source_file_missing") from error

            new_mtime_ns = _replace_entry(root, old_rel, new_rel)

            moved_sidecars: list[tuple[str, str]] = []
            old_parent = root / old_rel.parent
            old_stem = old_rel.stem
            new_stem = new_rel.stem
            if old_parent.is_dir() and not old_parent.is_symlink():
                for item in sorted(old_parent.iterdir()):
                    if (
                        not item.is_symlink()
                        and item.is_file()
                        and item.suffix.lower() in SIDECAR_SUFFIXES
                        and item.stem.lower() == old_stem.lower()
                    ):
                        sidecar_old = old_rel.parent / item.name
                        sidecar_new = new_rel.parent / f"{new_stem}{item.suffix}"
                        with suppress(HTTPException, OSError):
                            _replace_entry(root, sidecar_old, sidecar_new)
                            moved_sidecars.append((sidecar_old.as_posix(), sidecar_new.as_posix()))

            with repository.database.connect(write=True) as connection:
                connection.execute("BEGIN IMMEDIATE")
                connection.execute(
                    "UPDATE tracks SET path=?, mtime_ns=? WHERE id=? AND library_id=?",
                    (suggested_path, new_mtime_ns, track_id, repository.library_id()),
                )
                apply_effective(connection, track_id)
                connection.execute(
                    "UPDATE imported_files SET target_path=? WHERE target_root=? AND target_path=?",
                    (suggested_path, str(root), current_path),
                )
                for old_sc, new_sc in moved_sidecars:
                    connection.execute(
                        "UPDATE imported_files SET target_path=? WHERE target_root=? AND target_path=?",
                        (new_sc, str(root), old_sc),
                    )

            with suppress(OSError, ValueError):
                export_music(
                    repository.database,
                    root,
                    repository.library_id(),
                    {album_folder(old_rel), album_folder(new_rel)},
                )
            cleanup_empty_parents(root, root / old_rel)
    except Timeout:
        raise HTTPException(409, "scan_busy") from None

    return {
        "status": "reorganized",
        "changed": True,
        "old_path": current_path,
        "new_path": suggested_path,
        "moved_sidecars": len(moved_sidecars),
    }


def cleanup_empty_parents(root: Path, path: Path):
    parent = path.parent
    while parent != root and parent.is_relative_to(root):
        try:
            if not parent.is_symlink() and not any(parent.iterdir()):
                parent.rmdir()
            else:
                break
        except OSError:
            break
        parent = parent.parent
