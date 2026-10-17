"""Additive assistant research migration; existing connections keep their protocol."""

SCHEMA = """
BEGIN IMMEDIATE;
ALTER TABLE agent_connections ADD COLUMN options TEXT NOT NULL DEFAULT '{}';
CREATE TABLE agent_search_settings (
 user_id TEXT PRIMARY KEY REFERENCES users(id), provider TEXT NOT NULL,
 secret_ref TEXT, enabled INTEGER NOT NULL DEFAULT 0, daily_budget INTEGER NOT NULL DEFAULT 100,
 version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE agent_search_usage (
 user_id TEXT NOT NULL REFERENCES users(id), day TEXT NOT NULL, requests INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(user_id,day)
);
CREATE TABLE agent_search_cache (
 cache_key TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
 payload TEXT NOT NULL, expires_at REAL NOT NULL
);
CREATE TABLE agent_web_sources (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), run_id TEXT REFERENCES agent_runs(id) ON DELETE CASCADE,
 title TEXT NOT NULL, url TEXT NOT NULL, summary TEXT NOT NULL,
 published_at TEXT, retrieved_at TEXT NOT NULL
);
CREATE INDEX agent_web_sources_owner ON agent_web_sources(user_id,run_id);
CREATE TABLE agent_message_sources (
 message_id TEXT PRIMARY KEY REFERENCES agent_messages(id) ON DELETE CASCADE,
 sources TEXT NOT NULL
);
CREATE TABLE agent_contexts (
 conversation_id TEXT PRIMARY KEY REFERENCES agent_conversations(id) ON DELETE CASCADE,
 through_id TEXT NOT NULL, summary TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE agent_memories (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), content TEXT NOT NULL,
 version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX agent_memories_owner ON agent_memories(user_id,updated_at);
PRAGMA user_version=19;
COMMIT;
"""
