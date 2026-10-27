"""SQLite storage shared by the API and one-shot scanner."""

import json
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from wildstring.library.albums import album_key
from wildstring.provider_schema import SCHEMA as PROVIDER_SCHEMA

SCHEMA_VERSION = 41
PODCAST_SCHEMA = """
BEGIN IMMEDIATE;
CREATE TABLE IF NOT EXISTS podcasts (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    author TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    feed_url TEXT NOT NULL UNIQUE,
    cover_url TEXT NOT NULL DEFAULT '',
    auto_update INTEGER NOT NULL DEFAULT 1,
    update_interval_minutes INTEGER NOT NULL DEFAULT 60,
    download_policy TEXT NOT NULL DEFAULT 'latest_3',
    retention_policy TEXT NOT NULL DEFAULT 'keep',
    slow_download INTEGER NOT NULL DEFAULT 0,
    max_retries INTEGER NOT NULL DEFAULT 3,
    retry_backoff_base INTEGER NOT NULL DEFAULT 5,
    last_updated_at TEXT,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS podcast_episodes (
    id TEXT PRIMARY KEY,
    podcast_id TEXT NOT NULL REFERENCES podcasts(id) ON DELETE CASCADE,
    guid TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    audio_url TEXT NOT NULL,
    duration_seconds INTEGER NOT NULL DEFAULT 0,
    pub_date TEXT NOT NULL DEFAULT '',
    episode_number INTEGER,
    season_number INTEGER,
    created_at TEXT NOT NULL,
    local_path TEXT,
    download_status TEXT NOT NULL DEFAULT 'none',
    UNIQUE(podcast_id, guid)
);
CREATE INDEX IF NOT EXISTS episodes_by_podcast ON podcast_episodes(podcast_id, pub_date DESC);
CREATE TABLE IF NOT EXISTS podcast_progress (
    user_id TEXT NOT NULL,
    episode_id TEXT NOT NULL REFERENCES podcast_episodes(id) ON DELETE CASCADE,
    position_seconds INTEGER NOT NULL DEFAULT 0,
    duration_seconds INTEGER NOT NULL DEFAULT 0,
    completed INTEGER NOT NULL DEFAULT 0,
    last_listened_at TEXT NOT NULL,
    PRIMARY KEY(user_id, episode_id)
);
PRAGMA user_version = 32;
COMMIT;
"""
TRANSCODING_SCHEMA = """
BEGIN IMMEDIATE;
CREATE TABLE transcoding_settings (
    id INTEGER PRIMARY KEY CHECK(id=1),
    retention_days INTEGER NOT NULL DEFAULT 7,
    max_size_mb INTEGER NOT NULL DEFAULT 10240,
    max_concurrent INTEGER NOT NULL DEFAULT 2,
    version INTEGER NOT NULL DEFAULT 1,
    generation INTEGER NOT NULL DEFAULT 0
);
INSERT INTO transcoding_settings(id) VALUES (1);
CREATE TABLE transcoding_cache (
    key TEXT PRIMARY KEY,
    filename TEXT NOT NULL,
    track_id TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    accessed_at REAL NOT NULL
);
PRAGMA user_version = 11;
COMMIT;
"""
ACCESS_SCHEMA = """
BEGIN IMMEDIATE;
CREATE TABLE site_access (
    id INTEGER PRIMARY KEY CHECK(id=1),
    enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
    hosts TEXT NOT NULL DEFAULT '[]',
    version INTEGER NOT NULL DEFAULT 1
);
INSERT INTO site_access(id) VALUES (1);
PRAGMA user_version = 10;
COMMIT;
"""
LYRICS_SCHEMA = """
BEGIN IMMEDIATE;
CREATE TABLE IF NOT EXISTS track_lyrics (
    track_id TEXT PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
    text TEXT,
    version INTEGER NOT NULL DEFAULT 1
);
PRAGMA user_version = 8;
COMMIT;
"""
USERS_SCHEMA = """
BEGIN IMMEDIATE;
CREATE TABLE users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL COLLATE NOCASE UNIQUE,
    password_hash TEXT,
    role TEXT NOT NULL CHECK(role IN ('admin', 'user')),
    enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
    version INTEGER NOT NULL DEFAULT 1
);
INSERT INTO users(id, username, password_hash, role)
VALUES ('admin', 'admin', (SELECT password_hash FROM admin WHERE id=1), 'admin');
DROP TABLE admin;
ALTER TABLE sessions ADD COLUMN user_id TEXT NOT NULL DEFAULT 'admin';
CREATE INDEX sessions_user_id ON sessions(user_id);
ALTER TABLE playlists ADD COLUMN user_id TEXT NOT NULL DEFAULT 'admin';
DROP INDEX one_favorites_playlist;
CREATE UNIQUE INDEX one_favorites_playlist ON playlists(library_id, user_id) WHERE kind='favorites';
CREATE INDEX playlists_owner ON playlists(user_id, library_id);
ALTER TABLE listening_sessions ADD COLUMN user_id TEXT NOT NULL DEFAULT 'admin';
CREATE TABLE user_track_state (
    user_id TEXT NOT NULL REFERENCES users(id),
    track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    loved INTEGER NOT NULL DEFAULT 0 CHECK(loved IN (0, 1)),
    loved_at TEXT,
    play_count INTEGER NOT NULL DEFAULT 0,
    listened_ms INTEGER NOT NULL DEFAULT 0,
    last_played_at TEXT,
    PRIMARY KEY(user_id, track_id)
);
INSERT INTO user_track_state
SELECT 'admin', id, loved, loved_at, play_count, listened_ms, last_played_at FROM tracks
WHERE loved OR play_count OR listened_ms OR last_played_at IS NOT NULL;
CREATE VIEW personal_tracks AS
SELECT t.id, t.library_id, t.path, t.title, t.title_source, t.artists, t.album, t.album_artists,
    t.track_number, t.disc_number, t.duration_ms, t.format, t.sample_rate, t.channels,
    t.has_cover, t.size_bytes, t.mtime_ns, t.status, t.seen_run, t.search_text, t.album_id,
    t.added_at, COALESCE(s.loved,0) AS loved, s.loved_at,
    COALESCE(s.play_count,0) AS play_count, COALESCE(s.listened_ms,0) AS listened_ms,
    s.last_played_at
FROM tracks t LEFT JOIN user_track_state s ON s.track_id=t.id AND s.user_id=active_user();
PRAGMA user_version = 9;
COMMIT;
"""
INTAKE_SCHEMA = """
BEGIN IMMEDIATE;
ALTER TABLE admin_jobs ADD COLUMN automatic INTEGER NOT NULL DEFAULT 0;
CREATE TABLE intake_settings (
    library_id TEXT PRIMARY KEY REFERENCES libraries(id),
    enabled INTEGER NOT NULL DEFAULT 0,
    interval_seconds INTEGER NOT NULL DEFAULT 60,
    stable_seconds INTEGER NOT NULL DEFAULT 120,
    version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE intake_items (
    id TEXT PRIMARY KEY,
    library_id TEXT NOT NULL REFERENCES libraries(id),
    source_root TEXT NOT NULL,
    source_path TEXT NOT NULL,
    signature TEXT NOT NULL,
    state TEXT NOT NULL,
    metadata TEXT NOT NULL DEFAULT '{}',
    issues TEXT NOT NULL DEFAULT '[]',
    staged TEXT,
    staged_sha256 TEXT,
    overrides TEXT NOT NULL DEFAULT '{}',
    outputs TEXT NOT NULL DEFAULT '[]',
    version INTEGER NOT NULL DEFAULT 1,
    changed_at REAL NOT NULL,
    updated_at REAL NOT NULL,
    UNIQUE(library_id, source_root, source_path)
);
CREATE INDEX intake_library_state ON intake_items(library_id, state, updated_at);
PRAGMA user_version = 7;
COMMIT;
"""
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
    def __init__(self, data_dir: Path, user_id: str = "admin"):
        self.path = data_dir / "wildstring.sqlite3"
        self.user_id = user_id

    @contextmanager
    def connect(self, *, write: bool = False, create: bool = False) -> Iterator[sqlite3.Connection]:
        mode = "rwc" if create else "rw" if write else "ro"
        connection = sqlite3.connect(
            f"{self.path.as_uri()}?mode={mode}",
            uri=True,
            timeout=10,
        )
        connection.row_factory = sqlite3.Row
        connection.create_function("active_user", 0, lambda: self.user_id)
        connection.create_function("active_library", 0, lambda: None)
        connection.create_function("library_visible", 1, lambda identity: 1)
        connection.create_function(
            "library_selected", 2, lambda identity, fallback: int(identity == fallback)
        )
        try:
            connection.execute("PRAGMA foreign_keys = ON")
            from wildstring.library.scope import configure_scope

            if connection.execute("PRAGMA user_version").fetchone()[0] >= 36:
                configure_scope(connection, self.user_id)
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
        with self.connect(write=True, create=True) as connection:
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
            if current < 7:
                connection.executescript(INTAKE_SCHEMA)
            if current < 8:
                connection.executescript(LYRICS_SCHEMA)
            if current < 9:
                connection.executescript(USERS_SCHEMA)
            if current < 10:
                connection.executescript(ACCESS_SCHEMA)
            if current < 11:
                connection.executescript(TRANSCODING_SCHEMA)
            if current < 12:
                connection.executescript(PROVIDER_SCHEMA)
                from wildstring.library.edits import apply_effective

                for row in connection.execute("SELECT id FROM tracks").fetchall():
                    apply_effective(connection, row["id"])
                connection.execute("PRAGMA user_version = 12")
                connection.commit()
            if current < 13:
                connection.executescript("""
                    BEGIN IMMEDIATE;
                    ALTER TABLE provider_settings ADD COLUMN acoustid INTEGER NOT NULL DEFAULT 0;
                    ALTER TABLE provider_settings ADD COLUMN priority TEXT NOT NULL DEFAULT '["musicbrainz","lastfm"]';
                    ALTER TABLE metadata_suggestions ADD COLUMN match TEXT NOT NULL DEFAULT '{}';
                    ALTER TABLE provider_jobs ADD COLUMN refresh_mode TEXT NOT NULL DEFAULT 'all';
                    ALTER TABLE provider_jobs ADD COLUMN force INTEGER NOT NULL DEFAULT 0;
                    PRAGMA user_version = 13;
                    COMMIT;
                """)
            if current < 14:
                from wildstring.experience_schema import SCHEMA as EXPERIENCE_SCHEMA

                connection.executescript(EXPERIENCE_SCHEMA)
            if current < 15:
                from wildstring.provider_batches import SCHEMA as REFRESH_BATCH_SCHEMA

                connection.executescript(REFRESH_BATCH_SCHEMA)
            if current < 16:
                from wildstring.provider_tasks import SCHEMA as PROVIDER_TASK_SCHEMA

                connection.executescript(PROVIDER_TASK_SCHEMA)
            if current < 17:
                from wildstring.agent_schema import SCHEMA as AGENT_SCHEMA

                connection.executescript(AGENT_SCHEMA)
            if current < 18:
                from wildstring.recommendation_schema import SCHEMA as RECOMMENDATION_SCHEMA

                connection.executescript(RECOMMENDATION_SCHEMA)
            if current < 19:
                from wildstring.research_schema import SCHEMA as RESEARCH_SCHEMA

                connection.executescript(RESEARCH_SCHEMA)
            if current < 20:
                from wildstring.music_plugin_schema import SCHEMA as MUSIC_PLUGIN_SCHEMA

                connection.executescript(MUSIC_PLUGIN_SCHEMA)
            if current < 21:
                from wildstring.lyric_scan_schema import SCHEMA as LYRIC_SCAN_SCHEMA

                connection.executescript(LYRIC_SCAN_SCHEMA)
            if current < 22:
                from wildstring.library.download_policy import SCHEMA as DOWNLOAD_SCHEMA

                connection.executescript(DOWNLOAD_SCHEMA)
            if current < 23:
                from wildstring.playback_handoff_schema import SCHEMA as PLAYBACK_HANDOFF_SCHEMA

                connection.executescript(PLAYBACK_HANDOFF_SCHEMA)
            if current < 24:
                from wildstring.album_release_locks import SCHEMA as ALBUM_RELEASE_LOCK_SCHEMA

                connection.executescript(ALBUM_RELEASE_LOCK_SCHEMA)
            if current < 25:
                columns = {row[1] for row in connection.execute("PRAGMA table_info(agent_events)")}
                if "actions" not in columns:
                    connection.execute(
                        "ALTER TABLE agent_events ADD COLUMN actions TEXT NOT NULL DEFAULT '[]'"
                    )
                connection.execute("PRAGMA user_version = 25")
            if current < 26:
                from wildstring.provider_refresh_schema import SCHEMA as PROVIDER_REFRESH_SCHEMA

                connection.executescript(PROVIDER_REFRESH_SCHEMA)
            if current < 27:
                if "profile" not in {
                    row[1] for row in connection.execute("PRAGMA table_info(users)")
                }:
                    connection.execute("BEGIN IMMEDIATE")
                    connection.execute(
                        "ALTER TABLE users ADD COLUMN profile TEXT NOT NULL DEFAULT 'listener' "
                        "CHECK(profile IN ('owner', 'librarian', 'editor', 'listener'))"
                    )
                    connection.execute("UPDATE users SET profile='owner' WHERE role='admin'")
                    connection.execute("PRAGMA user_version = 27")
                    connection.commit()
                else:
                    connection.execute("PRAGMA user_version = 27")
            if current < 28:
                connection.executescript(
                    """
                    BEGIN IMMEDIATE;
                    CREATE TABLE IF NOT EXISTS library_trash (
                        id TEXT PRIMARY KEY,
                        library_id TEXT NOT NULL REFERENCES libraries(id),
                        album_id TEXT NOT NULL,
                        entries TEXT NOT NULL,
                        created_at TEXT NOT NULL,
                        created_by TEXT NOT NULL,
                        status TEXT NOT NULL DEFAULT 'trashed'
                            CHECK(status IN ('trashed', 'restored', 'purged'))
                    );
                    CREATE INDEX IF NOT EXISTS library_trash_album ON library_trash(library_id, album_id, created_at);
                    PRAGMA user_version = 28;
                    COMMIT;
                    """
                )
            if current < 29:
                columns = {row[1] for row in connection.execute("PRAGMA table_info(admin_jobs)")}
                if "scope_path" not in columns:
                    connection.execute("BEGIN IMMEDIATE")
                    connection.execute(
                        "ALTER TABLE admin_jobs ADD COLUMN scope_path TEXT NOT NULL DEFAULT '.'"
                    )
                    connection.execute("PRAGMA user_version = 29")
                    connection.commit()
                else:
                    connection.execute("PRAGMA user_version = 29")
            if current < 30:
                columns = {row[1] for row in connection.execute("PRAGMA table_info(users)")}
                if "role" in columns:
                    connection.execute("BEGIN IMMEDIATE")
                    connection.execute("ALTER TABLE users DROP COLUMN role")
                    connection.execute("PRAGMA user_version = 30")
                    connection.commit()
                else:
                    connection.execute("PRAGMA user_version = 30")
            if current < 31:
                columns = {row[1] for row in connection.execute("PRAGMA table_info(users)")}
                connection.execute("BEGIN IMMEDIATE")
                if "display_name" not in columns:
                    connection.execute(
                        "ALTER TABLE users ADD COLUMN display_name TEXT NOT NULL DEFAULT ''"
                    )
                if "email" not in columns:
                    connection.execute(
                        "ALTER TABLE users ADD COLUMN email TEXT NOT NULL DEFAULT ''"
                    )
                columns = {
                    row[1]
                    for row in connection.execute("PRAGMA table_info(recommendation_preferences)")
                }
                if "daily_enabled" not in columns:
                    connection.execute(
                        "ALTER TABLE recommendation_preferences ADD COLUMN daily_enabled INTEGER NOT NULL DEFAULT 0"
                    )
                if "daily_time" not in columns:
                    connection.execute(
                        "ALTER TABLE recommendation_preferences ADD COLUMN daily_time TEXT NOT NULL DEFAULT '00:00'"
                    )
                connection.execute("PRAGMA user_version = 31")
                connection.commit()
            if current < 32:
                connection.executescript(PODCAST_SCHEMA)
            if current < 33:
                from wildstring.podcast_playback_schema import SCHEMA as PODCAST_PLAYBACK_SCHEMA

                connection.executescript(PODCAST_PLAYBACK_SCHEMA)
            if current < 34:
                from wildstring.podcast_progress import SCHEMA as PODCAST_PROGRESS_SCHEMA

                connection.executescript(PODCAST_PROGRESS_SCHEMA)
            if current < 35:
                from wildstring.podcast_publishers import migrate as migrate_publishers

                migrate_publishers(connection)
            if current < 36:
                from wildstring.library.catalog_schema import migrate as migrate_libraries

                migrate_libraries(connection)
            if current < 37:
                from wildstring.storage_schema import migrate as migrate_storage

                migrate_storage(connection)
            if current < 38:
                from wildstring.catalog_policy_schema import migrate as migrate_catalog_policy

                migrate_catalog_policy(connection)
            if current < 39:
                from wildstring.standard_audio_cleanup_schema import (
                    migrate as migrate_audio_cleanup,
                )

                migrate_audio_cleanup(connection)
            if current < 40:
                from wildstring.podcast_user_schema import migrate as migrate_podcast_users

                migrate_podcast_users(connection)
            if current < 41:
                from wildstring.podcast_playback_schema import CACHE_SCHEMA

                connection.executescript(CACHE_SCHEMA)
            connection.execute("PRAGMA journal_mode = WAL")

    def check_ready(self) -> bool:
        with self.connect() as connection:
            if connection.execute("PRAGMA user_version").fetchone()[0] != SCHEMA_VERSION:
                return False
            connection.execute("SELECT id FROM tracks LIMIT 0")
        return True
