"""Version 14: user-scoped playback handoff and recommendation decisions."""

SCHEMA = """
BEGIN IMMEDIATE;
CREATE TABLE IF NOT EXISTS playback_states (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    library_id TEXT NOT NULL REFERENCES libraries(id),
    version INTEGER NOT NULL, device_id TEXT NOT NULL,
    track_ids TEXT NOT NULL, position_index INTEGER NOT NULL,
    position_ms INTEGER NOT NULL, mode TEXT NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY(user_id, library_id)
);
CREATE TABLE IF NOT EXISTS recommendation_preferences (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    library_id TEXT NOT NULL REFERENCES libraries(id),
    version INTEGER NOT NULL DEFAULT 1,
    use_ai INTEGER NOT NULL DEFAULT 0, use_lastfm INTEGER NOT NULL DEFAULT 0,
    count INTEGER NOT NULL DEFAULT 20,
    PRIMARY KEY(user_id, library_id)
);
CREATE TABLE IF NOT EXISTS recommendation_daily (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    library_id TEXT NOT NULL REFERENCES libraries(id),
    id TEXT NOT NULL, day TEXT NOT NULL, generation INTEGER NOT NULL,
    items TEXT NOT NULL, engine TEXT NOT NULL,
    PRIMARY KEY(user_id, library_id)
);
CREATE TABLE IF NOT EXISTS recommendation_feedback (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    event_id TEXT NOT NULL,
    library_id TEXT NOT NULL REFERENCES libraries(id),
    track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    action TEXT NOT NULL, artists TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY(user_id, event_id)
);
CREATE INDEX IF NOT EXISTS recommendation_feedback_tracks
    ON recommendation_feedback(user_id, library_id, track_id, action);
PRAGMA user_version = 14;
COMMIT;
"""
