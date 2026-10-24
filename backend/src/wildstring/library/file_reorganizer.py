import json
import shutil
from pathlib import Path

from fastapi import HTTPException

from wildstring.library.import_files import organized_path
from wildstring.library.metadata import Metadata


def get_track_file_info(repository, track_id: str):
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
            "SELECT source_path FROM imported_files WHERE target_path=? LIMIT 1",
            (row["path"],),
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
        "source_path": source_path,
        "source_filename": source_filename,
        "library_root": str(root),
        "full_path": str(full_path),
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


def reorganize_track_file(repository, track_id: str):
    info = get_track_file_info(repository, track_id)
    current_path = info["path"]
    suggested_path = info["suggested_path"]

    if current_path == suggested_path:
        return {"status": "already_organized", "path": current_path, "changed": False}

    root = Path(repository.root)
    old_abs = root / current_path
    new_abs = root / suggested_path

    if not old_abs.is_file():
        raise HTTPException(404, "source_file_missing")

    if new_abs.exists() and new_abs.resolve() != old_abs.resolve():
        raise HTTPException(409, "destination_file_exists")

    new_abs.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(old_abs), str(new_abs))

    moved_sidecars: list[tuple[str, str]] = []
    old_parent = old_abs.parent
    old_stem = old_abs.stem
    new_stem = new_abs.stem
    if old_parent.is_dir():
        for item in old_parent.iterdir():
            if item.is_file() and item != new_abs and item.stem.lower() == old_stem.lower():
                target_sidecar = new_abs.parent / f"{new_stem}{item.suffix}"
                if not target_sidecar.exists():
                    shutil.move(str(item), str(target_sidecar))
                    moved_sidecars.append(
                        (str(item.relative_to(root)), str(target_sidecar.relative_to(root)))
                    )

    cleanup_empty_parents(root, old_abs)

    with repository.database.connect(write=True) as connection:
        connection.execute("BEGIN IMMEDIATE")
        connection.execute(
            "UPDATE tracks SET path=? WHERE id=? AND library_id=?",
            (suggested_path, track_id, repository.library_id()),
        )
        connection.execute(
            "UPDATE imported_files SET target_path=? WHERE target_root=? AND target_path=?",
            (suggested_path, str(root), current_path),
        )
        for old_sc, new_sc in moved_sidecars:
            connection.execute(
                "UPDATE imported_files SET target_path=? WHERE target_root=? AND target_path=?",
                (new_sc, str(root), old_sc),
            )

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
            if not any(parent.iterdir()):
                parent.rmdir()
            else:
                break
        except OSError:
            break
        parent = parent.parent
