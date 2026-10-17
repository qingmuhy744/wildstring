"""Version 20: optional source plugins, retained lyric evidence and playback gain."""

SCHEMA = """
BEGIN IMMEDIATE;
CREATE TABLE source_plugin_packages (
    plugin_id TEXT PRIMARY KEY, sha256 TEXT NOT NULL, manifest TEXT NOT NULL,
    imported_at REAL NOT NULL
);
CREATE TABLE source_plugin_settings (
    plugin_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0,
    metadata_enabled INTEGER NOT NULL DEFAULT 1, lyrics_enabled INTEGER NOT NULL DEFAULT 1,
    priority INTEGER NOT NULL DEFAULT 50, config TEXT NOT NULL DEFAULT '{}',
    version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE lyric_lookup_jobs (
    id TEXT PRIMARY KEY, track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    status TEXT NOT NULL, error TEXT, warnings TEXT NOT NULL DEFAULT '[]',
    created_at REAL NOT NULL, updated_at REAL NOT NULL
);
CREATE UNIQUE INDEX lyric_lookup_active ON lyric_lookup_jobs(track_id) WHERE status IN ('queued','running');
CREATE TABLE lyric_candidates (
    id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES lyric_lookup_jobs(id) ON DELETE CASCADE,
    track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    plugin_id TEXT NOT NULL, source_id TEXT NOT NULL, source_url TEXT NOT NULL,
    match TEXT NOT NULL, raw TEXT NOT NULL, normalized TEXT NOT NULL,
    lyrics_version INTEGER NOT NULL, file_version TEXT NOT NULL,
    created_at REAL NOT NULL
);
ALTER TABLE track_lyrics ADD COLUMN selected_candidate TEXT;
CREATE TABLE playback_gain_settings (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    mode TEXT NOT NULL DEFAULT 'off', preamp_db REAL NOT NULL DEFAULT 0,
    prevent_clipping INTEGER NOT NULL DEFAULT 1, version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE playback_gain_adjustments (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    scope TEXT NOT NULL, target_id TEXT NOT NULL, gain_db REAL NOT NULL DEFAULT 0,
    version INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(user_id,scope,target_id)
);
CREATE TABLE loudness_analysis (
    track_id TEXT PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
    file_version TEXT NOT NULL, track_gain REAL, track_peak REAL,
    status TEXT NOT NULL, error TEXT, updated_at REAL NOT NULL
);
PRAGMA user_version = 20;
COMMIT;
"""
