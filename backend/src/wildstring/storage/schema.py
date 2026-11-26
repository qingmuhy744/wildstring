SCHEMA = """
        CREATE TABLE IF NOT EXISTS remote_storage_accounts (
            id TEXT PRIMARY KEY,
            provider TEXT NOT NULL DEFAULT 'gdrive' CHECK(provider='gdrive'),
            name TEXT NOT NULL,
            scope_mode TEXT NOT NULL CHECK(scope_mode IN ('drive_file','drive_readonly')),
            client_id TEXT NOT NULL,
            secret_ref TEXT NOT NULL,
            token_ref TEXT NOT NULL,
            account_email TEXT,
            account_subject TEXT,
            status TEXT NOT NULL DEFAULT 'auth_required',
            last_error TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            version INTEGER NOT NULL DEFAULT 1
        );
        CREATE TABLE IF NOT EXISTS library_remote_storage (
            collection TEXT NOT NULL CHECK(collection IN ('music','books')),
            library_id TEXT NOT NULL,
            account_id TEXT NOT NULL REFERENCES remote_storage_accounts(id),
            root_folder_id TEXT NOT NULL,
            root_folder_name TEXT NOT NULL,
            changes_page_token TEXT,
            last_synced_at TEXT,
            cache_max_mb INTEGER NOT NULL DEFAULT 2048 CHECK(cache_max_mb>=0),
            version INTEGER NOT NULL DEFAULT 1,
            PRIMARY KEY(collection, library_id),
            UNIQUE(account_id, collection, root_folder_id)
        );
        CREATE TABLE IF NOT EXISTS remote_media_objects (
            entity_kind TEXT NOT NULL CHECK(entity_kind IN ('track','book_ebook','book_audiobook_file')),
            entity_id TEXT NOT NULL,
            collection TEXT NOT NULL,
            library_id TEXT NOT NULL,
            provider TEXT NOT NULL DEFAULT 'gdrive' CHECK(provider='gdrive'),
            account_id TEXT NOT NULL REFERENCES remote_storage_accounts(id),
            remote_file_id TEXT NOT NULL,
            remote_md5 TEXT,
            remote_modified_at TEXT,
            remote_version TEXT NOT NULL,
            size_bytes INTEGER NOT NULL,
            media_info TEXT NOT NULL DEFAULT '{}',
            available INTEGER NOT NULL DEFAULT 1,
            PRIMARY KEY(entity_kind, entity_id),
            FOREIGN KEY(collection, library_id) REFERENCES library_remote_storage(collection, library_id)
                ON DELETE CASCADE
        );
        CREATE UNIQUE INDEX IF NOT EXISTS remote_objects_by_file
            ON remote_media_objects(account_id, entity_kind, remote_file_id);
        CREATE INDEX IF NOT EXISTS remote_objects_by_library ON remote_media_objects(collection, library_id);
        CREATE TABLE IF NOT EXISTS remote_media_cache (
            cache_key TEXT PRIMARY KEY,
            collection TEXT NOT NULL,
            library_id TEXT NOT NULL,
            remote_version TEXT NOT NULL,
            remote_md5 TEXT,
            filename TEXT NOT NULL,
            size_bytes INTEGER NOT NULL,
            accessed_at REAL NOT NULL,
            FOREIGN KEY(collection, library_id) REFERENCES library_remote_storage(collection, library_id)
                ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS remote_cache_by_access
            ON remote_media_cache(collection, library_id, accessed_at);
        CREATE TABLE IF NOT EXISTS remote_drive_tree (
            collection TEXT NOT NULL,
            library_id TEXT NOT NULL,
            file_id TEXT NOT NULL,
            metadata TEXT NOT NULL,
            PRIMARY KEY(collection, library_id, file_id),
            FOREIGN KEY(collection, library_id) REFERENCES library_remote_storage(collection, library_id)
                ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS remote_oauth_states (
            state_hash TEXT PRIMARY KEY,
            session_hash TEXT NOT NULL,
            account_id TEXT NOT NULL REFERENCES remote_storage_accounts(id),
            redirect_uri TEXT NOT NULL,
            expires_at REAL NOT NULL
        );
"""


def migrate(db):
    db.execute("BEGIN IMMEDIATE")
    if db.execute("PRAGMA user_version").fetchone()[0] < 64:
        for table, statement in (
            (
                "libraries",
                "ALTER TABLE libraries ADD COLUMN storage_backend TEXT NOT NULL DEFAULT 'local' CHECK(storage_backend IN ('local','gdrive'))",
            ),
            (
                "book_libraries",
                "ALTER TABLE book_libraries ADD COLUMN storage_backend TEXT NOT NULL DEFAULT 'local' CHECK(storage_backend IN ('local','gdrive'))",
            ),
            ("track_lyrics", "ALTER TABLE track_lyrics ADD COLUMN remote_text TEXT"),
        ):
            column = "remote_text" if table == "track_lyrics" else "storage_backend"
            if column not in {row[1] for row in db.execute(f"PRAGMA table_info({table})")}:
                db.execute(statement)
        for statement in SCHEMA.strip().split(";"):
            if statement.strip():
                db.execute(statement)
        db.execute("PRAGMA user_version = 64")
    db.commit()
