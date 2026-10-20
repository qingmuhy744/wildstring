"""Pending refresh intents for a lookup that outlives a metadata edit."""

SCHEMA = """
BEGIN IMMEDIATE;
CREATE TABLE IF NOT EXISTS provider_refresh_intents (
    track_id TEXT PRIMARY KEY,
    metadata_version INTEGER NOT NULL CHECK(metadata_version>=1),
    refresh_mode TEXT NOT NULL CHECK(refresh_mode IN ('missing','all')),
    force INTEGER NOT NULL DEFAULT 0 CHECK(force IN (0,1)),
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS provider_refresh_intents_updated
    ON provider_refresh_intents(updated_at);
PRAGMA user_version = 26;
COMMIT;
"""
