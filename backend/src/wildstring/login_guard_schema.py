"""Schema 42: scope authentication throttling to an account and client source."""

import time


def migrate(connection):
    connection.execute("BEGIN IMMEDIATE")
    connection.execute(
        """CREATE TABLE IF NOT EXISTS login_attempts (
            guard_key TEXT PRIMARY KEY,
            failures INTEGER NOT NULL DEFAULT 0,
            blocked_until INTEGER NOT NULL DEFAULT 0,
            last_attempt INTEGER NOT NULL
        )"""
    )
    connection.execute("PRAGMA user_version=42")
    connection.commit()


def migrate_timestamps(connection):
    """Schema 47: repair development databases that lack attempt timestamps."""
    connection.execute("BEGIN IMMEDIATE")
    columns = {row[1] for row in connection.execute("PRAGMA table_info(login_attempts)")}
    if "last_attempt" not in columns:
        connection.execute(
            "ALTER TABLE login_attempts ADD COLUMN last_attempt INTEGER NOT NULL DEFAULT 0"
        )
        # Retain existing blocks for their remaining lifetime instead of making
        # the next login's expiry cleanup immediately discard every old record.
        connection.execute("UPDATE login_attempts SET last_attempt=?", (int(time.time()),))
    connection.execute("PRAGMA user_version=47")
    connection.commit()
