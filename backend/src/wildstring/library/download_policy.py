"""Read-only download completion observations, independent of audio versions."""

import os
import re
from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field, field_validator

SCHEMA = """
BEGIN IMMEDIATE;
ALTER TABLE intake_settings ADD COLUMN download_policy TEXT NOT NULL DEFAULT '{}';
CREATE TABLE intake_download_state (
 library_id TEXT NOT NULL REFERENCES libraries(id), source_root TEXT NOT NULL,
 directory TEXT NOT NULL, signature TEXT NOT NULL, changed_at REAL NOT NULL,
 PRIMARY KEY(library_id,source_root,directory)
);
PRAGMA user_version = 22;
COMMIT;
"""


class DownloadPolicy(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    partial_suffixes: list[str] = Field(
        default_factory=lambda: [".part", ".partial", ".!qb", ".aria2", ".tmp"],
        min_length=1,
        max_length=16,
    )
    wait_for_album: bool = True

    @field_validator("partial_suffixes")
    @classmethod
    def suffixes(cls, values):
        if any(not re.fullmatch(r"\.[a-zA-Z0-9_!~-]{1,15}", v) for v in values):
            raise ValueError("invalid_partial_suffix")
        return list(dict.fromkeys(v.lower() for v in values))


def partial(name, policy):
    return name.lower().endswith(tuple(policy["partial_suffixes"]))


def album_directory(root: Path, relative: Path):
    parent = relative.parent
    if re.fullmatch(r"(?:cd|disc|disk|碟)[ _-]*\d+", parent.name, re.IGNORECASE):
        parent = parent.parent
    return root / parent


def pending(root: Path, relative: Path, policy):
    """Observe bounded marker metadata, never decode or modify incomplete files."""
    directory = album_directory(root, relative)
    if not policy["wait_for_album"]:
        return directory, []
    markers = []
    for base, folders, names in os.walk(directory, followlinks=False):
        at_root = Path(base) == root
        disc_folders = [
            n
            for n in folders
            if re.match(r"(?:cd|disc|disk|碟)[ _-]*\d+(?:\.|$)", n, re.IGNORECASE)
        ]
        for name in sorted((disc_folders if at_root else folders) + names):
            path = Path(base) / name
            if not path.is_symlink() and partial(name, policy):
                try:
                    st = path.stat()
                except FileNotFoundError:
                    continue
                markers.append([str(path.relative_to(directory)), st.st_size, st.st_mtime_ns])
                if len(markers) >= 200:
                    return directory, markers
        folders[:] = sorted(
            n
            for n in folders
            if not n.startswith(".")
            and not (Path(base) / n).is_symlink()
            and (not at_root or n in disc_folders)
        )
    return directory, markers
