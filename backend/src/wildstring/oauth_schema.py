"""Schema migration 63: OAuth 2.1 clients, codes, grants and refresh tokens for MCP."""

from __future__ import annotations

import sqlite3

SCHEMA = """
CREATE TABLE IF NOT EXISTS oauth_clients (
    client_id TEXT PRIMARY KEY,
    client_secret_hash TEXT,
    name TEXT NOT NULL,
    redirect_uris TEXT NOT NULL,
    token_endpoint_auth_method TEXT NOT NULL
        CHECK(token_endpoint_auth_method IN ('none', 'client_secret_post', 'client_secret_basic')),
    registration_source TEXT NOT NULL
        CHECK(registration_source IN ('dynamic', 'manual')),
    owner_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS oauth_clients_owner ON oauth_clients(owner_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS oauth_clients_dynamic_created
    ON oauth_clients(registration_source, created_at);

CREATE TABLE IF NOT EXISTS oauth_grants (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    scopes TEXT NOT NULL,
    resource TEXT,
    credential_id TEXT REFERENCES agent_credentials(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    last_used_at TEXT,
    revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS oauth_grants_user ON oauth_grants(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS oauth_grants_client ON oauth_grants(client_id);

CREATE TABLE IF NOT EXISTS oauth_codes (
    code_hash TEXT PRIMARY KEY,
    client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    redirect_uri TEXT NOT NULL,
    scopes TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    code_challenge_method TEXT NOT NULL CHECK(code_challenge_method = 'S256'),
    resource TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT,
    grant_id TEXT REFERENCES oauth_grants(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS oauth_codes_expires ON oauth_codes(expires_at);

CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
    token_hash TEXT PRIMARY KEY,
    grant_id TEXT NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    rotated_at TEXT,
    revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS oauth_refresh_grant ON oauth_refresh_tokens(grant_id);
CREATE INDEX IF NOT EXISTS oauth_refresh_expires ON oauth_refresh_tokens(expires_at);
"""


def migrate(connection: sqlite3.Connection) -> None:
    connection.execute("BEGIN IMMEDIATE")
    if connection.execute("PRAGMA user_version").fetchone()[0] < 63:
        for statement in SCHEMA.strip().split(";"):
            stmt = statement.strip()
            if stmt:
                connection.execute(stmt)
        columns = {row[1] for row in connection.execute("PRAGMA table_info(agent_credentials)")}
        if "oauth_grant_id" not in columns:
            connection.execute(
                "ALTER TABLE agent_credentials "
                "ADD COLUMN oauth_grant_id TEXT REFERENCES oauth_grants(id) ON DELETE CASCADE"
            )
        connection.execute(
            "CREATE INDEX IF NOT EXISTS agent_credentials_oauth_grant "
            "ON agent_credentials(oauth_grant_id)"
        )
        connection.execute("PRAGMA user_version = 63")
    connection.commit()
