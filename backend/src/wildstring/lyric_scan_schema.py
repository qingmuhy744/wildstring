"""Version 21: durable lyric upgrades, independent coverage and request pacing."""

SCHEMA = """
BEGIN IMMEDIATE;
CREATE TABLE lyric_scan_batches (
 id TEXT PRIMARY KEY, library_id TEXT NOT NULL REFERENCES libraries(id),
 options TEXT NOT NULL, status TEXT NOT NULL, total INTEGER NOT NULL,
 created_at REAL NOT NULL, updated_at REAL NOT NULL
);
CREATE TABLE lyric_scan_items (
 id TEXT PRIMARY KEY, batch_id TEXT NOT NULL REFERENCES lyric_scan_batches(id) ON DELETE CASCADE,
 track_id TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
 baseline TEXT, fingerprint TEXT, provider_index INTEGER NOT NULL DEFAULT 0,
 attempts INTEGER NOT NULL DEFAULT 0, next_at REAL NOT NULL DEFAULT 0,
 candidate_id TEXT, quality TEXT, error TEXT, previous TEXT, applied_version INTEGER,
 job_id TEXT, results TEXT NOT NULL DEFAULT '{}',
 updated_at REAL NOT NULL, UNIQUE(batch_id,track_id)
);
CREATE INDEX lyric_scan_due ON lyric_scan_items(status,next_at);
CREATE TABLE lyric_scan_coverage (
 track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
 plugin_id TEXT NOT NULL, fingerprint TEXT NOT NULL, target TEXT NOT NULL,
 outcome TEXT NOT NULL, candidate_id TEXT, updated_at REAL NOT NULL,
 PRIMARY KEY(track_id,plugin_id,fingerprint,target)
);
CREATE TABLE lyric_locks (
 track_id TEXT PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
 locked INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE plugin_request_gates (
 plugin_id TEXT PRIMARY KEY, next_at REAL NOT NULL DEFAULT 0, last_at REAL NOT NULL DEFAULT 0,
 cooldown_until REAL NOT NULL DEFAULT 0, reason TEXT
);
CREATE TABLE lyric_scan_settings (
 id INTEGER PRIMARY KEY CHECK(id=1), default_profile TEXT NOT NULL DEFAULT 'low',
 low_seconds INTEGER NOT NULL DEFAULT 10, medium_seconds INTEGER NOT NULL DEFAULT 5,
 high_seconds INTEGER NOT NULL DEFAULT 2, version INTEGER NOT NULL DEFAULT 1
);
INSERT INTO lyric_scan_settings(id) VALUES (1);
PRAGMA user_version = 21;
COMMIT;
"""
