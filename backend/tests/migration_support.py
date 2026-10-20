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
    pre20(connection)
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


def pre20(connection):
    pre21(connection)
    for table in (
        "source_plugin_packages",
        "source_plugin_settings",
        "lyric_candidates",
        "lyric_lookup_jobs",
        "playback_gain_settings",
        "playback_gain_adjustments",
        "loudness_analysis",
    ):
        connection.execute("DROP TABLE IF EXISTS " + table)
    columns = {row[1] for row in connection.execute("PRAGMA table_info(track_lyrics)")}
    if "selected_candidate" in columns:
        connection.execute("ALTER TABLE track_lyrics DROP COLUMN selected_candidate")


def pre21(connection):
    pre22(connection)
    for table in (
        "lyric_scan_items",
        "lyric_scan_batches",
        "lyric_scan_coverage",
        "lyric_locks",
        "plugin_request_gates",
        "lyric_scan_settings",
    ):
        connection.execute("DROP TABLE IF EXISTS " + table)


def pre22(connection):
    pre23(connection)
    connection.execute("DROP TABLE IF EXISTS intake_download_state")
    columns = {row[1] for row in connection.execute("PRAGMA table_info(intake_settings)")}
    if "download_policy" in columns:
        connection.execute("ALTER TABLE intake_settings DROP COLUMN download_policy")


def pre23(connection):
    columns = {row[1] for row in connection.execute("PRAGMA table_info(playback_states)")}
    for column in ("playback_state", "paused_at"):
        if column in columns:
            connection.execute("ALTER TABLE playback_states DROP COLUMN " + column)
