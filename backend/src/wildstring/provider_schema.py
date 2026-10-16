"""Version 12: normalized details, retained identities and external-service jobs."""

SCHEMA = """
BEGIN IMMEDIATE;
ALTER TABLE tracks ADD COLUMN extra TEXT NOT NULL DEFAULT '{}';
CREATE TABLE people (
    id TEXT PRIMARY KEY, library_id TEXT NOT NULL REFERENCES libraries(id),
    name TEXT NOT NULL, normalized TEXT NOT NULL,
    UNIQUE(library_id, normalized)
);
CREATE TABLE track_credits (
    track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    person_id TEXT NOT NULL REFERENCES people(id), role TEXT NOT NULL,
    position INTEGER NOT NULL, credited_name TEXT NOT NULL,
    PRIMARY KEY(track_id, person_id, role)
);
CREATE INDEX credits_person ON track_credits(person_id, role);
CREATE TABLE metadata_history (
    id TEXT PRIMARY KEY, track_id TEXT NOT NULL REFERENCES tracks(id),
    user_id TEXT NOT NULL REFERENCES users(id), before_values TEXT NOT NULL,
    after_version INTEGER NOT NULL, created_at TEXT NOT NULL,
    undone INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE metadata_origins (track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE, field TEXT NOT NULL, source TEXT NOT NULL, PRIMARY KEY(track_id, field));
CREATE TABLE artwork_choices (
    track_id TEXT PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
    filename TEXT, source_url TEXT, mode TEXT NOT NULL DEFAULT 'auto',
    version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE provider_settings (
    id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL DEFAULT 0,
    auto_new INTEGER NOT NULL DEFAULT 1, musicbrainz INTEGER NOT NULL DEFAULT 1,
    lastfm INTEGER NOT NULL DEFAULT 1, caa INTEGER NOT NULL DEFAULT 1,
    public_url TEXT NOT NULL DEFAULT '', proxy_mode TEXT NOT NULL DEFAULT 'environment', version INTEGER NOT NULL DEFAULT 1
);
INSERT INTO provider_settings(id) VALUES(1);
CREATE TABLE provider_seen (track_id TEXT PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE);
CREATE TABLE provider_jobs (
    id TEXT PRIMARY KEY, track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    metadata_version INTEGER NOT NULL, status TEXT NOT NULL,
    created_at REAL NOT NULL, updated_at REAL NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0, next_attempt REAL NOT NULL DEFAULT 0,
    error TEXT, warnings TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX provider_work ON provider_jobs(status, next_attempt, created_at);
CREATE UNIQUE INDEX provider_active_track ON provider_jobs(track_id) WHERE status IN ('queued','running');
CREATE TABLE metadata_suggestions (
    id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES provider_jobs(id) ON DELETE CASCADE,
    track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    metadata_version INTEGER NOT NULL, provider TEXT NOT NULL,
    source_url TEXT NOT NULL, fields TEXT NOT NULL, cover_url TEXT,
    status TEXT NOT NULL DEFAULT 'pending', created_at REAL NOT NULL
);
CREATE INDEX suggestions_track ON metadata_suggestions(track_id, status);
CREATE TABLE provider_cache (
    provider TEXT NOT NULL, cache_key TEXT NOT NULL, payload TEXT NOT NULL,
    expires_at REAL NOT NULL, PRIMARY KEY(provider, cache_key)
);
CREATE TABLE provider_limits (provider TEXT PRIMARY KEY, called_at REAL NOT NULL);
CREATE TABLE lastfm_users (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    username TEXT NOT NULL, credential_ref TEXT NOT NULL,
    scrobble INTEGER NOT NULL DEFAULT 0, now_playing INTEGER NOT NULL DEFAULT 0,
    version INTEGER NOT NULL DEFAULT 1, needs_auth INTEGER NOT NULL DEFAULT 0,
    enabled_since REAL NOT NULL DEFAULT 0
);
CREATE TABLE lastfm_auth (
    state_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at REAL NOT NULL, created_at REAL NOT NULL
);
CREATE TABLE lastfm_outbox (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    credential_ref TEXT NOT NULL, session_id TEXT NOT NULL,
    kind TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
    attempts INTEGER NOT NULL DEFAULT 0, next_attempt REAL NOT NULL DEFAULT 0,
    error TEXT, created_at REAL NOT NULL, updated_at REAL NOT NULL,
    UNIQUE(user_id, credential_ref, session_id, kind)
);
CREATE INDEX lastfm_work ON lastfm_outbox(status, next_attempt, created_at);
ALTER TABLE listening_sessions ADD COLUMN client_started_at REAL;
ALTER TABLE listening_sessions ADD COLUMN playback_state TEXT NOT NULL DEFAULT 'playing';
DROP VIEW personal_tracks;
CREATE VIEW personal_tracks AS
SELECT t.id, t.library_id, t.path, t.title, t.title_source, t.artists, t.album, t.album_artists,
    t.track_number, t.disc_number, t.duration_ms, t.format, t.sample_rate, t.channels,
    CASE WHEN t.has_cover OR EXISTS(SELECT 1 FROM artwork_choices a WHERE a.track_id=t.id AND a.filename IS NOT NULL)
    OR EXISTS(SELECT 1 FROM tracks sibling WHERE sibling.album_id=t.album_id AND sibling.id<>t.id AND sibling.status='available'
        AND (sibling.has_cover OR EXISTS(SELECT 1 FROM artwork_choices a WHERE a.track_id=sibling.id AND a.filename IS NOT NULL)))
    THEN 1 ELSE 0 END AS has_cover, t.size_bytes, t.mtime_ns, t.status, t.seen_run, t.search_text, t.album_id,
    t.extra, t.added_at, COALESCE(s.loved,0) AS loved, s.loved_at,
    COALESCE(s.play_count,0) AS play_count, COALESCE(s.listened_ms,0) AS listened_ms,
    s.last_played_at
FROM tracks t LEFT JOIN user_track_state s ON s.track_id=t.id AND s.user_id=active_user();
"""
