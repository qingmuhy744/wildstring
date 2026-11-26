"""Schema 58: content hash cache, portable rich lyric bundles, and sidecar scan state."""

COLUMNS = {
    "tracks": {
        "sha256": "TEXT",
    },
    "track_lyrics": {
        "portable_bundle": "TEXT",
    },
}

TABLES = (
    """CREATE TABLE IF NOT EXISTS music_sidecar_states (
        library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
        folder TEXT NOT NULL,
        manifest_mtime_ns INTEGER NOT NULL,
        manifest_sha256 TEXT NOT NULL,
        PRIMARY KEY(library_id, folder)
    )""",
)


def migrate(connection):
    with connection:
        connection.execute("BEGIN IMMEDIATE")
        for table, additions in COLUMNS.items():
            existing = {row[1] for row in connection.execute(f"PRAGMA table_info({table})")}
            for name, definition in additions.items():
                if name not in existing:
                    connection.execute(
                        f"ALTER TABLE {table} ADD COLUMN {name} {definition}"  # nosec B608
                    )
        for statement in TABLES:
            connection.execute(statement)
        connection.execute(
            """UPDATE tracks SET sha256 = (
                SELECT i.sha256 FROM imported_files i
                JOIN libraries l ON l.id = tracks.library_id
                WHERE i.target_root = l.root
                  AND i.target_path = tracks.path
                  AND i.source_size = tracks.size_bytes
                  AND i.link_mode != 'generated'
                LIMIT 1
            ) WHERE sha256 IS NULL"""
        )
        connection.execute("PRAGMA user_version = 58")
