"""Version 23: explicit remote playback state and a stable pause event."""

SCHEMA = """
BEGIN IMMEDIATE;
ALTER TABLE playback_states ADD COLUMN playback_state TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE playback_states ADD COLUMN paused_at TEXT;
PRAGMA user_version = 23;
COMMIT;
"""
