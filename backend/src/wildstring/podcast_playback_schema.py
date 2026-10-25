"""Per-user playback-time podcast cache preferences."""

SCHEMA = """
BEGIN IMMEDIATE;
CREATE TABLE IF NOT EXISTS podcast_playback_settings (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    auto_cache_current INTEGER NOT NULL DEFAULT 1 CHECK(auto_cache_current IN (0, 1)),
    prefetch_next INTEGER NOT NULL DEFAULT 0 CHECK(prefetch_next IN (0, 1)),
    network_policy TEXT NOT NULL DEFAULT 'wifi'
        CHECK(network_policy IN ('off', 'wifi', 'any')),
    version INTEGER NOT NULL DEFAULT 1
);
PRAGMA user_version = 33;
COMMIT;
"""
