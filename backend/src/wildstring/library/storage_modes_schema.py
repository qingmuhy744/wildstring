"""Schema 57: bookshelf, storage modes and per-file provenance."""

from wildstring.books.schema import TABLES

COLUMNS = {
    "libraries": {
        "storage_mode": "TEXT NOT NULL DEFAULT 'copy' CHECK(storage_mode IN ('copy', 'hardlink'))",
    },
    "imported_files": {
        "link_mode": "TEXT NOT NULL DEFAULT 'copy' "
        "CHECK(link_mode IN ('copy', 'hardlink', 'generated', 'managed_only'))",
    },
    "library_migrations": {
        "target_storage_mode": "TEXT CHECK(target_storage_mode IN ('copy', 'hardlink'))",
        "relinked_files": "INTEGER NOT NULL DEFAULT 0",
        "reclaimed_bytes": "INTEGER NOT NULL DEFAULT 0",
        "kept_standalone_files": "INTEGER NOT NULL DEFAULT 0",
        "sidecars_written": "INTEGER NOT NULL DEFAULT 0",
    },
}


def migrate(connection):
    with connection:
        connection.execute("BEGIN IMMEDIATE")
        # Some historical upgrade fixtures retain columns from newer schemas.
        for table, additions in COLUMNS.items():
            existing = {row[1] for row in connection.execute(f"PRAGMA table_info({table})")}
            for name, definition in additions.items():
                if name not in existing:
                    connection.execute(
                        f"ALTER TABLE {table} ADD COLUMN {name} {definition}"  # nosec B608
                    )
        for statement in TABLES:
            connection.execute(statement)
        connection.execute("PRAGMA user_version = 57")
