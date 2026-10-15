"""SQLite storage shared by the API and one-shot scanner."""

import json
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from wildstring.library.albums import album_key

SCHEMA_VERSION = 6
MANAGEMENT_SCHEMA = """
BEGIN IMMEDIATE;
CREATE TABLE track_metadata (
    track_id TEXT PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
    observed TEXT NOT NULL,
    overrides TEXT NOT NULL DEFAULT '{}',
    version INTEGER NOT NULL DEFAULT 1
);
INSERT INTO track_metadata(track_id, observed)
SELECT id, json_object('title', title, 'title_source', title_source,
    'artists', json(artists), 'album', album, 'album_artists', json(album_artists),
    'track_number', track_number, 'disc_number', disc_number) FROM tracks;
CREATE TABLE admin_jobs (
    id TEXT PRIMARY KEY,
    library_id TEXT NOT NULL REFERENCES libraries(id),
    kind TEXT NOT NULL CHECK(kind IN ('import', 'scan')),
    full INTEGER NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    import_id TEXT,
    scan_id TEXT,
    result TEXT,
    error TEXT
);
CREATE UNIQUE INDEX one_active_library_job ON admin_jobs(library_id)
    WHERE status IN ('queued', 'running');
CREATE TABLE library_preferences (
    library_id TEXT PRIMARY KEY REFERENCES libraries(id),
    name TEXT NOT NULL DEFAULT '我的曲库',
    version INTEGER NOT NULL DEFAULT 1
);
PRAGMA user_version = 6;
COMMIT;
"""
PERSONAL_SCHEMA = """
BEGIN IMMEDIATE;
ALTER TABLE tracks ADD COLUMN loved INTEGER NOT NULL DEFAULT 0 CHECK(loved IN (0, 1));
ALTER TABLE tracks ADD COLUMN loved_at TEXT;
ALTER TABLE tracks ADD COLUMN play_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tracks ADD COLUMN listened_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tracks ADD COLUMN last_played_at TEXT;
ALTER TABLE tracks ADD COLUMN added_at TEXT NOT NULL DEFAULT '';
UPDATE tracks SET added_at = COALESCE(
    (SELECT started_at FROM scan_runs WHERE id = tracks.seen_run), strftime('%Y-%m-%dT%H:%M:%f+00:00', 'now')
);
CREATE TABLE playlists (
    id TEXT PRIMARY KEY,
    library_id TEXT NOT NULL REFERENCES libraries(id),
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('manual', 'smart', 'favorites')),
    definition TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX playlists_library ON playlists(library_id);
CREATE UNIQUE INDEX one_favorites_playlist ON playlists(library_id) WHERE kind = 'favorites';
CREATE TABLE playlist_tracks (
    playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    position INTEGER NOT NULL CHECK(position >= 0),
    PRIMARY KEY(playlist_id, track_id),
    UNIQUE(playlist_id, position)
);
CREATE TABLE listening_sessions (
    id TEXT PRIMARY KEY,
    track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    started_at REAL NOT NULL,
    reported_ms INTEGER NOT NULL DEFAULT 0,
    counted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX listening_track ON listening_sessions(track_id);
PRAGMA user_version = 5;
COMMIT;
"""
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
            if current < 5:
                connection.executescript(PERSONAL_SCHEMA)
            if current < 6:
                connection.executescript(MANAGEMENT_SCHEMA)
            connection.execute("PRAGMA journal_mode = WAL")

    def check_ready(self) -> bool:
        with self.connect() as connection:
            if connection.execute("PRAGMA user_version").fetchone()[0] != SCHEMA_VERSION:
                return False
            connection.execute("SELECT id FROM tracks LIMIT 0")
        return True
