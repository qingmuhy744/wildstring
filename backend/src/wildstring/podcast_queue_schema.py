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


def migrate_v52(connection):
    """Fold the listen-later pool into the ordered queue and drop it.

    ``podcast_inbox_baseline`` stays. It records episodes that already existed
    when the user followed a show, which is how new episodes are recognized.
    """
    import json

    connection.execute("BEGIN IMMEDIATE")
    columns = {row[1] for row in connection.execute("PRAGMA table_info(podcast_queue_state)")}
    if "notice" not in columns:
        connection.execute(
            "ALTER TABLE podcast_queue_state ADD COLUMN notice TEXT NOT NULL DEFAULT ''"
        )
    podcast_columns = {row[1] for row in connection.execute("PRAGMA table_info(podcasts)")}
    if "show_type" not in podcast_columns:
        connection.execute("ALTER TABLE podcasts ADD COLUMN show_type TEXT NOT NULL DEFAULT ''")
    tables = {
        row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")
    }
    if "podcast_inbox" in tables:
        user_ids = [
            row[0] for row in connection.execute("SELECT DISTINCT user_id FROM podcast_inbox")
        ]
        for user_id in user_ids:
            state = connection.execute(
                "SELECT items_json, version, device_id FROM podcast_queue_state WHERE user_id=?",
                (user_id,),
            ).fetchone()
            try:
                items = json.loads(state["items_json"]) if state is not None else []
            except (TypeError, ValueError):
                items = []
            if not isinstance(items, list):
                items = []
            present = {item.get("episode_id") for item in items if isinstance(item, dict)}
            rows = connection.execute(
                """SELECT episode_id, source, added_at FROM podcast_inbox
                   WHERE user_id=? ORDER BY added_at ASC, episode_id ASC""",
                (user_id,),
            ).fetchall()
            for row in rows:
                if row["episode_id"] in present:
                    continue
                origin = row["source"] if row["source"] in {"manual", "rule"} else "manual"
                items.append(
                    {
                        "episode_id": row["episode_id"],
                        "origin": origin,
                        "added_at": row["added_at"],
                    }
                )
                present.add(row["episode_id"])
            version = state["version"] if state is not None else 0
            device_id = state["device_id"] if state is not None else ""
            connection.execute(
                """INSERT INTO podcast_queue_state
                   (user_id, items_json, version, device_id, updated_at, notice)
                   VALUES (?,?,?,?,?,?)
                   ON CONFLICT(user_id) DO UPDATE SET
                     items_json=excluded.items_json,
                     version=excluded.version,
                     updated_at=excluded.updated_at""",
                (
                    user_id,
                    json.dumps(items, separators=(",", ":")),
                    version + 1 if rows else version,
                    device_id,
                    datetime.now(UTC).isoformat(),
                    "",
                ),
            )
        connection.execute("DROP TABLE podcast_inbox")
    connection.execute("UPDATE podcast_queue_prefs SET action='queue_last' WHERE action='inbox'")
    connection.execute("PRAGMA user_version=52")
    connection.commit()
