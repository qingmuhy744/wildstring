"""Schema 37: explicit storage jobs and personal references to shared audio."""


def migrate(connection):
    connection.execute("BEGIN IMMEDIATE")
    columns = {r[1] for r in connection.execute("PRAGMA table_info(library_sources)")}
    if "watch_enabled" not in columns:
        connection.execute(
            "ALTER TABLE library_sources ADD COLUMN watch_enabled INTEGER NOT NULL DEFAULT 1"
        )
    statements = (
        # Explicit approvals may queue their own source behind an existing task.
        # Execution remains serial, including across processes holding the worker lock.
        "DROP INDEX IF EXISTS one_active_library_job",
        "CREATE UNIQUE INDEX one_active_library_job ON admin_jobs(library_id) WHERE status='running'",
        """CREATE TABLE IF NOT EXISTS library_migrations (
            id TEXT PRIMARY KEY,library_id TEXT NOT NULL REFERENCES libraries(id),
            source_root TEXT NOT NULL,target_root TEXT NOT NULL,library_version INTEGER NOT NULL,
            created_by TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'queued',
            copied_files INTEGER NOT NULL DEFAULT 0,total_files INTEGER NOT NULL DEFAULT 0,
            copied_bytes INTEGER NOT NULL DEFAULT 0,total_bytes INTEGER NOT NULL DEFAULT 0,
            error TEXT,created_at REAL NOT NULL,updated_at REAL NOT NULL)""",
        "CREATE UNIQUE INDEX IF NOT EXISTS library_migration_active ON library_migrations(library_id) WHERE status IN ('queued','running')",
        """CREATE TABLE IF NOT EXISTS podcast_resource_refs (
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            episode_id TEXT NOT NULL REFERENCES podcast_episodes(id) ON DELETE CASCADE,
            created_at REAL NOT NULL,PRIMARY KEY(user_id,episode_id))""",
        """CREATE TABLE IF NOT EXISTS podcast_resource_state (
            episode_id TEXT PRIMARY KEY REFERENCES podcast_episodes(id) ON DELETE CASCADE,
            protected INTEGER NOT NULL DEFAULT 0,zero_since REAL,version INTEGER NOT NULL DEFAULT 1)""",
        """CREATE TABLE IF NOT EXISTS podcast_resource_leases (
            id TEXT PRIMARY KEY,episode_id TEXT NOT NULL REFERENCES podcast_episodes(id) ON DELETE CASCADE,
            expires_at REAL NOT NULL)""",
        """CREATE TABLE IF NOT EXISTS podcast_resource_settings (
            id INTEGER PRIMARY KEY CHECK(id=1),enabled INTEGER NOT NULL DEFAULT 0,
            retention_days INTEGER NOT NULL DEFAULT 7,version INTEGER NOT NULL DEFAULT 1)""",
        "CREATE INDEX IF NOT EXISTS podcast_refs_episode ON podcast_resource_refs(episode_id)",
        "CREATE INDEX IF NOT EXISTS podcast_leases_episode ON podcast_resource_leases(episode_id,expires_at)",
        "CREATE UNIQUE INDEX IF NOT EXISTS library_migration_target ON library_migrations(target_root) WHERE status IN ('queued','running')",
        "INSERT OR IGNORE INTO podcast_resource_settings(id) VALUES (1)",
    )
    for statement in statements:
        connection.execute(statement)
    connection.execute("""INSERT OR IGNORE INTO podcast_resource_state(episode_id,protected,zero_since)
        SELECT id,0,strftime('%s','now') FROM podcast_episodes WHERE local_path IS NOT NULL AND local_path<>''""")
    connection.execute("PRAGMA user_version=37")
    connection.commit()
