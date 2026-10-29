"""Schema 38: newcomer library defaults and opt-in public RSS additions."""


def migrate(connection):
    connection.execute("BEGIN IMMEDIATE")
    columns = {row[1] for row in connection.execute("PRAGMA table_info(libraries)")}
    if "default_access" not in columns:
        connection.execute(
            "ALTER TABLE libraries ADD COLUMN default_access INTEGER NOT NULL DEFAULT 0"
        )
        # Preserve the previous account-creation default, without changing any grants.
        connection.execute("UPDATE libraries SET default_access=1 WHERE is_default=1")
    connection.execute("""CREATE TABLE IF NOT EXISTS podcast_catalog_settings (
        id INTEGER PRIMARY KEY CHECK(id=1),
        allow_user_subscriptions INTEGER NOT NULL DEFAULT 0,
        version INTEGER NOT NULL DEFAULT 1)""")
    connection.execute("INSERT OR IGNORE INTO podcast_catalog_settings(id) VALUES (1)")
    connection.execute("PRAGMA user_version=38")
    connection.commit()
