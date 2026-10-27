"""Schema 40: personal podcast access, download policies and reference origins."""


def migrate(connection):
    connection.execute("BEGIN IMMEDIATE")
    columns = {row[1] for row in connection.execute("PRAGMA table_info(podcast_resource_refs)")}
    for name, default in (("manual", 1), ("automatic", 0)):
        if name not in columns:
            connection.execute(
                f"ALTER TABLE podcast_resource_refs ADD COLUMN {name} INTEGER NOT NULL DEFAULT {default} CHECK({name} IN (0,1))"
            )
    connection.execute("""CREATE TABLE IF NOT EXISTS podcast_user_catalog (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        podcast_id TEXT NOT NULL REFERENCES podcasts(id) ON DELETE CASCADE,
        PRIMARY KEY(user_id,podcast_id))""")
    connection.execute("""INSERT OR IGNORE INTO podcast_user_catalog
        SELECT user_id,podcast_id FROM podcast_follows UNION
        SELECT r.user_id,e.podcast_id FROM podcast_resource_refs r JOIN podcast_episodes e ON e.id=r.episode_id UNION
        SELECT pr.user_id,e.podcast_id FROM podcast_progress pr JOIN podcast_episodes e ON e.id=pr.episode_id JOIN users u ON u.id=pr.user_id""")
    existed = connection.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='podcast_user_settings'"
    ).fetchone()
    connection.execute("""CREATE TABLE IF NOT EXISTS podcast_user_settings (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        podcast_id TEXT NOT NULL REFERENCES podcasts(id) ON DELETE CASCADE,
        download_policy TEXT NOT NULL DEFAULT 'none',retention_policy TEXT NOT NULL DEFAULT 'keep',
        version INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(user_id,podcast_id))""")
    if not existed:
        connection.execute("""INSERT INTO podcast_user_settings(user_id,podcast_id,download_policy,retention_policy)
            SELECT f.user_id,f.podcast_id,COALESCE(p.download_policy,'none'),COALESCE(p.retention_policy,'keep')
            FROM podcast_follows f JOIN podcasts p ON p.id=f.podcast_id""")
    connection.execute(
        "CREATE INDEX IF NOT EXISTS podcast_catalog_programme ON podcast_user_catalog(podcast_id,user_id)"
    )
    connection.execute("PRAGMA user_version=40")
    connection.commit()
