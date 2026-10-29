"""Schema 42: scope authentication throttling to an account and client source."""


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
