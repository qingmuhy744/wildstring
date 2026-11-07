"""Schema 49: personal podcast inbox, play queue and new-episode delivery."""

from datetime import UTC, datetime


def migrate(connection):
    connection.execute("BEGIN IMMEDIATE")
    connection.execute(
        """CREATE TABLE IF NOT EXISTS podcast_inbox (
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            episode_id TEXT NOT NULL REFERENCES podcast_episodes(id) ON DELETE CASCADE,
            podcast_id TEXT NOT NULL,
            source TEXT NOT NULL DEFAULT 'manual',
            added_at TEXT NOT NULL,
            PRIMARY KEY(user_id, episode_id)
        )"""
    )
    connection.execute(
        """CREATE INDEX IF NOT EXISTS podcast_inbox_by_user
           ON podcast_inbox(user_id, added_at DESC)"""
    )
    connection.execute(
        """CREATE TABLE IF NOT EXISTS podcast_queue_state (
            user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
            items_json TEXT NOT NULL DEFAULT '[]',
            version INTEGER NOT NULL DEFAULT 0,
            device_id TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL
        )"""
    )
    connection.execute(
        """CREATE TABLE IF NOT EXISTS podcast_queue_prefs (
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            podcast_id TEXT NOT NULL DEFAULT '',
            action TEXT NOT NULL DEFAULT 'inbox',
            auto_limit INTEGER NOT NULL DEFAULT 3,
            episode_order TEXT NOT NULL DEFAULT 'follow',
            skip_completed INTEGER NOT NULL DEFAULT 1,
            auto_continue INTEGER NOT NULL DEFAULT 1,
            PRIMARY KEY(user_id, podcast_id)
        )"""
    )
    connection.execute(
        """CREATE TABLE IF NOT EXISTS podcast_inbox_baseline (
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            podcast_id TEXT NOT NULL REFERENCES podcasts(id) ON DELETE CASCADE,
            completed_at TEXT NOT NULL,
            PRIMARY KEY(user_id, podcast_id)
        )"""
    )
    # Existing follows must not receive their whole back catalogue on the next refresh.
    connection.execute(
        """INSERT OR IGNORE INTO podcast_inbox_baseline(user_id, podcast_id, completed_at)
           SELECT user_id, podcast_id, ? FROM podcast_follows""",
        (datetime.now(UTC).isoformat(),),
    )
    connection.execute("PRAGMA user_version=49")
    connection.commit()
