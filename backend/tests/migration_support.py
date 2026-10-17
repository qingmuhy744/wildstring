"""Reconstruct actual old layouts for migration tests, preserving their old rows."""


def pre18(connection):
    connection.execute("DROP INDEX IF EXISTS listening_recommendation_window")
    for table in (
        "recommendation_external_feedback",
        "recommendation_external",
        "recommendation_source_cache",
    ):
        connection.execute("DROP TABLE IF EXISTS " + table)
    columns = {
        "recommendation_preferences": (
            "connection_id",
            "sources",
            "lastfm_tags",
            "external_enabled",
            "external_refresh_days",
            "external_sources",
            "external_use_ai",
            "external_call_limit",
        ),
        "recommendation_daily": ("details",),
    }
    for table, added in columns.items():
        actual = {row[1] for row in connection.execute("PRAGMA table_info(" + table + ")")}
        for column in added:
            if column in actual:
                connection.execute("ALTER TABLE " + table + " DROP COLUMN " + column)
