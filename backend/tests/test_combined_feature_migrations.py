"""Upgrade the released schema and both feature branches without discarding records."""

import sqlite3

import pytest

from wildstring.database import SCHEMA_VERSION, Database


@pytest.mark.parametrize(
    ("version", "language", "identities", "settings_table", "backfill"),
    [
        (42, False, False, False, False),
        (43, True, False, False, False),
        (43, False, True, False, False),
        (44, False, True, True, False),
        (45, False, True, True, True),
    ],
)
def test_upgrade_keeps_language_records_and_directory_settings(
    settings, version, language, identities, settings_table, backfill
):
    database = Database(settings.data_dir)
    database.initialize()
    with sqlite3.connect(database.path) as connection:
        connection.execute(
            "UPDATE users SET display_name='Preserved', language='en' WHERE id='admin'"
        )
        connection.execute(
            "INSERT INTO podcasts(id,title,author,feed_url,created_at,itunes_id) "
            "VALUES ('show','Kept show','Author','HTTPS://ETW.fm/rss/','2026-01-01','123')"
        )
        connection.execute(
            "INSERT INTO podcast_episodes(id,podcast_id,guid,title,audio_url,created_at) "
            "VALUES ('episode','show','guid','Kept episode','https://example.com/episode.mp3','2026-01-01')"
        )
        connection.execute(
            "UPDATE podcast_search_settings SET regions='[\"us\"]',filter_explicit=1,version=2"
        )
        if not language:
            connection.execute("ALTER TABLE users DROP COLUMN language")
        if not backfill:
            connection.execute("ALTER TABLE podcasts DROP COLUMN itunes_checked_at")
            connection.execute("ALTER TABLE podcasts DROP COLUMN itunes_check_status")
        if not settings_table:
            connection.execute("DROP TABLE podcast_search_settings")
        if not identities:
            for index in (
                "podcasts_by_itunes_id",
                "podcasts_by_normalized_feed",
                "podcasts_by_resolved_feed",
            ):
                connection.execute(f"DROP INDEX {index}")
            for column in ("itunes_id", "feed_url_normalized", "resolved_feed_url_normalized"):
                connection.execute(f"ALTER TABLE podcasts DROP COLUMN {column}")
        connection.execute(f"PRAGMA user_version={version}")

    database.initialize()
    database.initialize()
    with database.connect() as connection:
        assert connection.execute("PRAGMA user_version").fetchone()[0] == SCHEMA_VERSION == 46
        user = connection.execute(
            "SELECT display_name,language FROM users WHERE id='admin'"
        ).fetchone()
        assert tuple(user) == ("Preserved", "en" if language else "auto")
        show = connection.execute(
            "SELECT id,itunes_id,feed_url_normalized FROM podcasts WHERE id='show'"
        ).fetchone()
        assert tuple(show) == ("show", "123" if identities else None, "etw.fm/rss")
        assert (
            connection.execute("SELECT title FROM podcast_episodes WHERE id='episode'").fetchone()[
                0
            ]
            == "Kept episode"
        )
        saved = connection.execute(
            "SELECT regions,filter_explicit,version FROM podcast_search_settings"
        ).fetchone()
        assert tuple(saved) == ('["us"]', 1, 2) if settings_table else tuple(saved) == (None, 0, 1)
