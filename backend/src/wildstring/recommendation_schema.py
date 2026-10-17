"""Version 18: explicit model choice and explainable recommendation sources."""

SCHEMA = """
BEGIN IMMEDIATE;
ALTER TABLE recommendation_preferences ADD COLUMN connection_id TEXT NOT NULL DEFAULT 'local';
ALTER TABLE recommendation_preferences ADD COLUMN sources TEXT NOT NULL DEFAULT '["personal","community","discovery","revisit"]';
ALTER TABLE recommendation_preferences ADD COLUMN lastfm_tags TEXT NOT NULL DEFAULT '[]';
UPDATE recommendation_preferences SET connection_id='legacy' WHERE use_ai=1;
UPDATE recommendation_preferences SET sources='["personal","community","discovery","revisit","lastfm_similar"]' WHERE use_lastfm=1;
ALTER TABLE recommendation_preferences ADD COLUMN external_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE recommendation_preferences ADD COLUMN external_refresh_days INTEGER NOT NULL DEFAULT 7;
ALTER TABLE recommendation_preferences ADD COLUMN external_sources TEXT NOT NULL DEFAULT '["lastfm_charts","lastfm_tags","lastfm_artists"]';
ALTER TABLE recommendation_preferences ADD COLUMN external_use_ai INTEGER NOT NULL DEFAULT 0;
ALTER TABLE recommendation_preferences ADD COLUMN external_call_limit INTEGER NOT NULL DEFAULT 6;
ALTER TABLE recommendation_daily ADD COLUMN details TEXT NOT NULL DEFAULT '{}';
CREATE TABLE recommendation_source_cache (
 source TEXT NOT NULL, cache_key TEXT NOT NULL, payload TEXT NOT NULL,
 created_at REAL NOT NULL, expires_at REAL NOT NULL,
 PRIMARY KEY(source,cache_key)
);
CREATE TABLE recommendation_external (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 library_id TEXT NOT NULL REFERENCES libraries(id), id TEXT NOT NULL,
 generated_at TEXT NOT NULL, next_refresh_at REAL NOT NULL,
 last_attempt_at REAL NOT NULL, items TEXT NOT NULL, details TEXT NOT NULL,
 PRIMARY KEY(user_id,library_id)
);
CREATE TABLE recommendation_external_feedback (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 library_id TEXT NOT NULL REFERENCES libraries(id), external_id TEXT NOT NULL,
 action TEXT NOT NULL, updated_at TEXT NOT NULL, item TEXT NOT NULL,
 PRIMARY KEY(user_id,library_id,external_id)
);
CREATE INDEX listening_recommendation_window ON listening_sessions(started_at,track_id,user_id);
PRAGMA user_version=18;
COMMIT;
"""
