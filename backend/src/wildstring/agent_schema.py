"""Transactional additions for controlled tools, proposals and user-owned automation."""

SCHEMA = """
BEGIN IMMEDIATE;
CREATE TABLE IF NOT EXISTS agent_credentials (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL,
 token_hash TEXT NOT NULL UNIQUE, scopes TEXT NOT NULL, created_at TEXT NOT NULL,
 expires_at TEXT NOT NULL, revoked_at TEXT, version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS agent_drafts (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), library_id TEXT NOT NULL,
 kind TEXT NOT NULL, title TEXT NOT NULL, payload TEXT NOT NULL, evidence TEXT NOT NULL,
 before_values TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', version INTEGER NOT NULL DEFAULT 1,
 approved_version INTEGER, approved_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 result TEXT, idempotency_key TEXT, trace_id TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS agent_application_key ON agent_drafts(user_id,idempotency_key)
 WHERE idempotency_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS agent_audit (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL, draft_id TEXT NOT NULL, action TEXT NOT NULL,
 object_id TEXT NOT NULL, trace_id TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_events (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), kind TEXT NOT NULL,
 dedupe_key TEXT NOT NULL UNIQUE, title TEXT NOT NULL, summary TEXT NOT NULL,
    severity TEXT NOT NULL, task_id TEXT, draft_id TEXT, trace_id TEXT NOT NULL,
    counts TEXT NOT NULL, actions TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL,
    schema_version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS agent_notifications (
 id TEXT PRIMARY KEY, event_id TEXT NOT NULL UNIQUE REFERENCES agent_events(id),
 user_id TEXT NOT NULL REFERENCES users(id), read_at TEXT, version INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL, changed_seq INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS agent_notification_changes (
 seq INTEGER PRIMARY KEY AUTOINCREMENT, notification_id TEXT NOT NULL, user_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_notification_owner ON agent_notification_changes(user_id,seq);
CREATE TABLE IF NOT EXISTS agent_inbox_state (
 user_id TEXT PRIMARY KEY REFERENCES users(id), expired_through INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS agent_preferences (
 user_id TEXT PRIMARY KEY REFERENCES users(id), value TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS agent_telegram_targets (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL,
 chat_id TEXT NOT NULL, topic_id INTEGER, secret_ref TEXT NOT NULL, proxy_mode TEXT NOT NULL,
 enabled INTEGER NOT NULL DEFAULT 0, verified INTEGER NOT NULL DEFAULT 0,
 challenge_hash TEXT, challenge_expires_at TEXT, challenge_attempts INTEGER NOT NULL DEFAULT 0,
 version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, deleted_at TEXT
);
CREATE TABLE IF NOT EXISTS agent_deliveries (
 id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES agent_events(id),
 target_id TEXT NOT NULL REFERENCES agent_telegram_targets(id), target_version INTEGER NOT NULL,
 status TEXT NOT NULL DEFAULT 'queued', attempt INTEGER NOT NULL DEFAULT 0,
 next_attempt_at TEXT NOT NULL, lease_until TEXT, error_code TEXT, message_id TEXT,
 trace_id TEXT NOT NULL, UNIQUE(event_id,target_id)
);
CREATE TABLE IF NOT EXISTS agent_tasks (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), auth_version INTEGER NOT NULL,
 credential_id TEXT, status TEXT NOT NULL DEFAULT 'queued', stage TEXT NOT NULL DEFAULT 'queued',
 parameters TEXT NOT NULL, checkpoint INTEGER NOT NULL DEFAULT 0, counts TEXT NOT NULL DEFAULT '{}',
 results TEXT NOT NULL DEFAULT '[]', attempts INTEGER NOT NULL DEFAULT 0, cancel_requested INTEGER NOT NULL DEFAULT 0,
 lease_until TEXT, lease_token TEXT, heartbeat_at TEXT, error_code TEXT, version INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, trace_id TEXT NOT NULL,
 schedule_key TEXT UNIQUE, connection_version INTEGER
);
CREATE TABLE IF NOT EXISTS agent_schedules (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL,
 enabled INTEGER NOT NULL DEFAULT 0, interval_hours INTEGER NOT NULL,
 timezone TEXT NOT NULL, parameters TEXT NOT NULL, next_run_at TEXT NOT NULL,
 version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_connections (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL,
 scope TEXT NOT NULL, base_url TEXT NOT NULL, model TEXT NOT NULL, timeout INTEGER NOT NULL,
 secret_ref TEXT, shared INTEGER NOT NULL DEFAULT 0, background_allowed INTEGER NOT NULL DEFAULT 0,
 daily_call_budget INTEGER NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
 version INTEGER NOT NULL DEFAULT 1, capabilities TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_usage (
 connection_id TEXT NOT NULL, user_id TEXT NOT NULL, day TEXT NOT NULL, calls INTEGER NOT NULL DEFAULT 0,
 tokens INTEGER NOT NULL DEFAULT 0, unknown_calls INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(connection_id,user_id,day)
);
CREATE TABLE IF NOT EXISTS agent_policy (
 id INTEGER PRIMARY KEY CHECK(id=1), allowed_hosts TEXT NOT NULL DEFAULT '[]',
 allow_private INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO agent_policy(id) VALUES(1);
CREATE TABLE IF NOT EXISTS agent_conversations (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), title TEXT NOT NULL,
 connection_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_messages (
 id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES agent_conversations(id) ON DELETE CASCADE,
 role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL, run_id TEXT
);
CREATE TABLE IF NOT EXISTS agent_runs (
 id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES agent_conversations(id) ON DELETE CASCADE,
 status TEXT NOT NULL, connection_id TEXT, connection_version INTEGER, error_code TEXT,
 tool_calls INTEGER NOT NULL DEFAULT 0, draft_ids TEXT NOT NULL DEFAULT '[]', trace_id TEXT NOT NULL,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, lease_until TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS agent_conversation_busy ON agent_runs(conversation_id)
 WHERE status='running';
PRAGMA user_version = 17;
COMMIT;
"""
