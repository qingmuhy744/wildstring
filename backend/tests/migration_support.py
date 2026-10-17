"""Reconstruct actual old layouts for migration tests, preserving their old rows."""


def pre18(connection):
    pre19(connection)
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


def pre19(connection):
    for table in (
        "agent_search_settings",
        "agent_search_usage",
        "agent_search_cache",
        "agent_web_sources",
        "agent_message_sources",
        "agent_contexts",
        "agent_memories",
    ):
        connection.execute("DROP TABLE IF EXISTS " + table)
    columns = {row[1] for row in connection.execute("PRAGMA table_info(agent_connections)")}
    if "options" in columns:
        connection.execute("ALTER TABLE agent_connections DROP COLUMN options")
