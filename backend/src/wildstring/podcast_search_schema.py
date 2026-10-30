"""Schema 43: directory identities used to recognise a programme from search results."""


def migrate(connection):
    connection.execute("BEGIN IMMEDIATE")
    columns = {row[1] for row in connection.execute("PRAGMA table_info(podcasts)")}
    for name in ("itunes_id", "feed_url_normalized", "resolved_feed_url_normalized"):
        if name not in columns:
            connection.execute(f"ALTER TABLE podcasts ADD COLUMN {name} TEXT")  # nosec B608
    connection.execute(
        "CREATE INDEX IF NOT EXISTS podcasts_by_itunes_id ON podcasts(itunes_id) "
        "WHERE itunes_id IS NOT NULL"
    )
    connection.execute(
        "CREATE INDEX IF NOT EXISTS podcasts_by_normalized_feed ON podcasts(feed_url_normalized)"
    )
    connection.execute(
        "CREATE INDEX IF NOT EXISTS podcasts_by_resolved_feed "
        "ON podcasts(resolved_feed_url_normalized)"
    )
    connection.execute("PRAGMA user_version=43")
    connection.commit()
