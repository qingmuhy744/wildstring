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
            "daily_enabled",
            "daily_time",
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
    pre34(connection)
    columns = {row[1] for row in connection.execute("PRAGMA table_info(playback_states)")}
    for column in ("playback_state", "paused_at"):
        if column in columns:
            connection.execute("ALTER TABLE playback_states DROP COLUMN " + column)


def pre34(connection):
    pre36(connection)
    for table in (
        "podcast_follows",
        "library_access_versions",
        "user_library_access",
        "library_sources",
    ):
        connection.execute("DROP TABLE IF EXISTS " + table)
    columns = {row[1] for row in connection.execute("PRAGMA table_info(podcast_progress)")}
    for column in ("version", "session_id", "device_id", "sequence"):
        if column in columns:
            connection.execute("ALTER TABLE podcast_progress DROP COLUMN " + column)


def pre36(connection):
    """Remove only schema 36 additions so real schema 35 rows survive the upgrade."""
    pre37(connection)
    for table in ("provider_jobs", "lyric_lookup_jobs", "loudness_analysis", "lyric_scan_batches"):
        connection.execute(f"DROP TRIGGER IF EXISTS {table}_library_owner")
    for table in ("agent_tasks", "agent_schedules"):
        connection.execute(f"DROP TRIGGER IF EXISTS {table}_library_scope")
        columns = {r[1] for r in connection.execute(f"PRAGMA table_info({table})")}
        if "library_id" in columns:
            connection.execute(f"ALTER TABLE {table} DROP COLUMN library_id")
    for table in (
        "podcast_follows",
        "library_job_owners",
        "library_access_versions",
        "user_library_access",
        "library_sources",
    ):
        connection.execute(f"DROP TABLE IF EXISTS {table}")
    for table, names in (
        ("libraries", ("name", "enabled", "is_default", "version")),
        ("admin_jobs", ("created_by", "source_id")),
    ):
        columns = {r[1] for r in connection.execute(f"PRAGMA table_info({table})")}
        for name in names:
            if name in columns:
                connection.execute(f"ALTER TABLE {table} DROP COLUMN {name}")
    row = connection.execute(
        "SELECT sql FROM sqlite_master WHERE type='view' AND name='personal_tracks'"
    ).fetchone()
    if row:
        connection.execute("DROP VIEW personal_tracks")
        connection.execute(row[0].replace(" WHERE library_visible(t.library_id)", ""))


def pre37(connection):
    pre38(connection)
    connection.execute("DROP INDEX IF EXISTS one_active_library_job")
    if connection.execute(
        "SELECT 1 FROM sqlite_master WHERE name='admin_jobs' AND type='table'"
    ).fetchone():
        connection.execute(
            "CREATE UNIQUE INDEX one_active_library_job ON admin_jobs(library_id) WHERE status IN ('queued','running')"
        )
    for table in (
        "podcast_resource_leases",
        "podcast_resource_refs",
        "podcast_resource_state",
        "podcast_resource_settings",
        "library_migrations",
    ):
        connection.execute(f"DROP TABLE IF EXISTS {table}")
    columns = {r[1] for r in connection.execute("PRAGMA table_info(library_sources)")}
    if "watch_enabled" in columns:
        connection.execute("ALTER TABLE library_sources DROP COLUMN watch_enabled")


def pre38(connection):
    pre40(connection)
    connection.execute("DROP TABLE IF EXISTS podcast_catalog_settings")
    columns = {row[1] for row in connection.execute("PRAGMA table_info(libraries)")}
    if "default_access" in columns:
        connection.execute("ALTER TABLE libraries DROP COLUMN default_access")


def pre40(connection):
    connection.execute("DROP TABLE IF EXISTS podcast_playback_cache")
    for table in ("podcast_user_catalog", "podcast_user_settings"):
        connection.execute(f"DROP TABLE IF EXISTS {table}")
    columns = {row[1] for row in connection.execute("PRAGMA table_info(podcast_resource_refs)")}
    for name in ("manual", "automatic"):
        if name in columns:
            connection.execute(f"ALTER TABLE podcast_resource_refs DROP COLUMN {name}")
