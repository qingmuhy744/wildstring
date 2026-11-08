"""Schema 50: podcast episode favorites."""


def migrate(connection):
    connection.execute("BEGIN IMMEDIATE")
    connection.execute(
        """CREATE TABLE IF NOT EXISTS podcast_episode_favorites (
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            episode_id TEXT NOT NULL REFERENCES podcast_episodes(id) ON DELETE CASCADE,
            created_at TEXT NOT NULL,
            PRIMARY KEY(user_id, episode_id)
        )"""
    )
    connection.execute(
        """CREATE INDEX IF NOT EXISTS podcast_episode_favorites_user
           ON podcast_episode_favorites(user_id, created_at DESC)"""
    )
    connection.execute(
        """CREATE INDEX IF NOT EXISTS podcast_episode_favorites_episode
           ON podcast_episode_favorites(episode_id)"""
    )
    connection.execute("PRAGMA user_version=50")
    connection.commit()
