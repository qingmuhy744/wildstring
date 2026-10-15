"""SQLite storage shared by the API and one-shot scanner."""

import json
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from wildstring.library.albums import album_key

SCHEMA_VERSION = 4
IMPORT_SCHEMA = """
BEGIN IMMEDIATE;
CREATE TABLE IF NOT EXISTS import_runs (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    counts TEXT NOT NULL,
    errors TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS imported_files (
    source_root TEXT NOT NULL,
    source_path TEXT NOT NULL,
    target_root TEXT NOT NULL,
    target_path TEXT NOT NULL,
    source_size INTEGER NOT NULL,
    source_mtime INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    PRIMARY KEY(source_root, source_path, target_root)
);
CREATE INDEX IF NOT EXISTS imports_by_hash ON imported_files(target_root, sha256);
PRAGMA user_version = 4;
COMMIT;
"""
AUTH_SCHEMA = """
BEGIN IMMEDIATE;
CREATE TABLE IF NOT EXISTS admin (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    password_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS login_guard (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    failures INTEGER NOT NULL,
    blocked_until INTEGER NOT NULL
);
INSERT OR IGNORE INTO login_guard VALUES (1, 0, 0);
PRAGMA user_version = 2;
COMMIT;
"""
SCHEMA = """
BEGIN IMMEDIATE;
CREATE TABLE IF NOT EXISTS libraries (
    id TEXT PRIMARY KEY,
    root TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS scan_runs (
    id TEXT PRIMARY KEY,
    library_id TEXT NOT NULL REFERENCES libraries(id),
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    counts TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tracks (
    id TEXT PRIMARY KEY,
    library_id TEXT NOT NULL REFERENCES libraries(id),
    path TEXT NOT NULL,
    title TEXT NOT NULL,
    title_source TEXT NOT NULL,
    artists TEXT NOT NULL,
    album TEXT,
    album_artists TEXT NOT NULL,
    track_number INTEGER,
    disc_number INTEGER,
    duration_ms INTEGER NOT NULL,
    format TEXT NOT NULL,
    sample_rate INTEGER,
    channels INTEGER,
    has_cover INTEGER NOT NULL,
    size_bytes INTEGER NOT NULL,
    mtime_ns INTEGER NOT NULL,
    status TEXT NOT NULL,
    seen_run TEXT NOT NULL REFERENCES scan_runs(id),
    search_text TEXT NOT NULL,
    UNIQUE(library_id, path)
);
CREATE INDEX IF NOT EXISTS tracks_library_status ON tracks(library_id, status);
CREATE TABLE IF NOT EXISTS scan_errors (
    id INTEGER PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES scan_runs(id),
    path TEXT NOT NULL,
    code TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS errors_by_run ON scan_errors(run_id, id);
PRAGMA user_version = 1;
COMMIT;
"""


class Database:
    def __init__(self, data_dir: Path):
        self.path = data_dir / "wildstring.sqlite3"

    @contextmanager
    def connect(self, *, write: bool = False) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(
            str(self.path) if write else f"{self.path.as_uri()}?mode=ro",
            uri=not write,
            timeout=10,
        )
        connection.row_factory = sqlite3.Row
        try:
            connection.execute("PRAGMA foreign_keys = ON")
            if not write:
                connection.execute("BEGIN")
            yield connection
            if write:
                connection.commit()
        except BaseException:
            connection.rollback()
            raise
        finally:
            connection.close()

    def initialize(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect(write=True) as connection:
            current = connection.execute("PRAGMA user_version").fetchone()[0]
            if current > SCHEMA_VERSION:
                raise RuntimeError("Database schema is newer than this application")
            if current == 0:
                connection.executescript(SCHEMA)
            if current < 2:
                connection.executescript(AUTH_SCHEMA)
            if current < 3:
                connection.execute("BEGIN IMMEDIATE")
                if connection.execute("PRAGMA user_version").fetchone()[0] < 3:
                    connection.execute(
                        "ALTER TABLE tracks ADD COLUMN album_id TEXT NOT NULL DEFAULT ''"
                    )
                    rows = connection.execute(
                        "SELECT id, library_id, path, album, album_artists FROM tracks"
                    ).fetchall()
                    connection.executemany(
                        "UPDATE tracks SET album_id = ? WHERE id = ?",
                        [
                            (
                                album_key(
                                    row["library_id"],
                                    row["path"],
                                    row["album"],
                                    json.loads(row["album_artists"]),
                                ),
                                row["id"],
                            )
                            for row in rows
                        ],
                    )
                    connection.execute(
                        "CREATE INDEX tracks_album ON tracks(library_id, album_id, status)"
                    )
                    connection.execute("PRAGMA user_version = 3")
                connection.commit()
            if current < 4:
                connection.executescript(IMPORT_SCHEMA)
            connection.execute("PRAGMA journal_mode = WAL")

    def check_ready(self) -> bool:
        with self.connect() as connection:
            if connection.execute("PRAGMA user_version").fetchone()[0] != SCHEMA_VERSION:
                return False
            connection.execute("SELECT id FROM tracks LIMIT 0")
        return True
