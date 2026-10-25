"""Schema 36 migration for library grants, sources and personal podcast follows."""


def migrate(connection):
    connection.execute("BEGIN IMMEDIATE")
    columns = {r[1] for r in connection.execute("PRAGMA table_info(libraries)")}
    for name, definition in (
        ("name", "TEXT NOT NULL DEFAULT '音乐库'"),
        ("enabled", "INTEGER NOT NULL DEFAULT 1"),
        ("is_default", "INTEGER NOT NULL DEFAULT 0"),
        ("version", "INTEGER NOT NULL DEFAULT 1"),
    ):
        if name not in columns:
            connection.execute(f"ALTER TABLE libraries ADD COLUMN {name} {definition}")
    connection.execute("""CREATE TABLE IF NOT EXISTS library_sources (
        library_id TEXT NOT NULL REFERENCES libraries(id), id TEXT NOT NULL,
        root TEXT NOT NULL, PRIMARY KEY(library_id,id), UNIQUE(library_id,root))""")
    connection.execute("""CREATE TABLE IF NOT EXISTS user_library_access (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        library_id TEXT NOT NULL REFERENCES libraries(id), PRIMARY KEY(user_id,library_id))""")
    connection.execute("""CREATE TABLE IF NOT EXISTS library_access_versions (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        version INTEGER NOT NULL DEFAULT 1)""")
    connection.execute("""INSERT OR IGNORE INTO user_library_access
        SELECT u.id,l.id FROM users u CROSS JOIN libraries l""")
    connection.execute("""UPDATE libraries SET name=COALESCE(
        (SELECT name FROM library_preferences p WHERE p.library_id=libraries.id),name)""")
    connection.execute("""CREATE TABLE IF NOT EXISTS podcast_follows (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        podcast_id TEXT NOT NULL REFERENCES podcasts(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(user_id,podcast_id))""")
    connection.execute("""CREATE TABLE IF NOT EXISTS library_job_owners (
        kind TEXT NOT NULL, id TEXT NOT NULL, user_id TEXT NOT NULL,
        library_id TEXT NOT NULL REFERENCES libraries(id), PRIMARY KEY(kind,id))""")
    # All interpolated schema identifiers below come from fixed internal tuples.
    for table in ("agent_tasks", "agent_schedules"):
        columns = {r[1] for r in connection.execute(f"PRAGMA table_info({table})")}
        if "library_id" not in columns:
            connection.execute(
                f"ALTER TABLE {table} ADD COLUMN library_id TEXT REFERENCES libraries(id)"
            )
        connection.execute(
            f"UPDATE {table} SET library_id=(SELECT library_id FROM tracks WHERE id=json_extract({table}.parameters,'$.track_ids[0]')) WHERE library_id IS NULL"  # nosec B608
        )
        connection.execute(
            f"UPDATE {table} SET library_id=(SELECT id FROM libraries ORDER BY is_default DESC,id LIMIT 1) WHERE library_id IS NULL"  # nosec B608
        )
        connection.execute(f"""CREATE TRIGGER IF NOT EXISTS {table}_library_scope AFTER INSERT ON {table}
            WHEN NEW.library_id IS NULL BEGIN UPDATE {table} SET library_id=active_library() WHERE id=NEW.id; END""")  # nosec B608
    for table, identity in (
        ("provider_jobs", "id"),
        ("lyric_lookup_jobs", "id"),
        ("loudness_analysis", "track_id"),
    ):
        connection.execute(
            f"""INSERT OR IGNORE INTO library_job_owners
            SELECT ?,j.{identity},'admin',t.library_id FROM {table} j JOIN tracks t ON t.id=j.track_id""",  # nosec B608
            (table,),
        )
        connection.execute(f"""CREATE TRIGGER IF NOT EXISTS {table}_library_owner AFTER INSERT ON {table}
            BEGIN INSERT OR REPLACE INTO library_job_owners(kind,id,user_id,library_id)
            SELECT '{table}',NEW.{identity},active_user(),t.library_id FROM tracks t WHERE t.id=NEW.track_id; END""")  # nosec B608
    connection.execute("""INSERT OR IGNORE INTO library_job_owners
        SELECT 'lyric_scan_batches',id,'admin',library_id FROM lyric_scan_batches""")
    connection.execute("""CREATE TRIGGER IF NOT EXISTS lyric_scan_batches_library_owner
        AFTER INSERT ON lyric_scan_batches BEGIN
        INSERT OR REPLACE INTO library_job_owners(kind,id,user_id,library_id)
        VALUES ('lyric_scan_batches',NEW.id,active_user(),NEW.library_id); END""")
    columns = {r[1] for r in connection.execute("PRAGMA table_info(admin_jobs)")}
    if "created_by" not in columns:
        connection.execute(
            "ALTER TABLE admin_jobs ADD COLUMN created_by TEXT NOT NULL DEFAULT 'admin'"
        )
    if "source_id" not in columns:
        connection.execute(
            "ALTER TABLE admin_jobs ADD COLUMN source_id TEXT NOT NULL DEFAULT 'import'"
        )
    view = connection.execute(
        "SELECT sql FROM sqlite_master WHERE type='view' AND name='personal_tracks'"
    ).fetchone()[0]
    if "library_visible(t.library_id)" not in view:
        connection.execute("DROP VIEW personal_tracks")
        connection.execute(view.rstrip("; ") + " WHERE library_visible(t.library_id)")
    connection.execute("PRAGMA user_version=36")
    connection.commit()
