"""Artist identities and read-only credits derived from existing metadata."""

import hashlib
import json
import sqlite3

from wildstring.library.metadata import normalize

ARTIST_CREDITS = """WITH artist_credits AS (
    SELECT DISTINCT t.id AS track_id, p.id AS artist_id, p.name
    FROM track_credits c JOIN tracks t ON t.id=c.track_id JOIN people p ON p.id=c.person_id
    WHERE t.library_id = :library_id AND t.status = 'available'
    AND (credit_role() IS NULL OR c.role=credit_role())
)
"""
ARTIST_SUMMARY = """SELECT c.artist_id AS id, min(c.name) AS name,
    count(DISTINCT t.id) AS track_count, count(DISTINCT t.album_id) AS album_count,
    sum(t.duration_ms) AS duration_ms,
    COALESCE(min(CASE WHEN t.has_cover THEN t.id END), min(t.id)) AS cover_track_id
    FROM (SELECT artist_id, track_id, min(name) AS name FROM artist_credits
          GROUP BY artist_id, track_id) c JOIN tracks t ON t.id = c.track_id
"""


def artist_key(library_id: str, name: str) -> str:
    value = json.dumps([library_id, normalize(name)], ensure_ascii=False)
    return hashlib.sha256(value.encode()).hexdigest()


def configure_artist_queries(connection: sqlite3.Connection, role: str | None = None) -> None:
    connection.create_function("artist_key", 2, artist_key, deterministic=True)
    connection.create_function("normalized", 1, normalize, deterministic=True)
    connection.create_function("credit_role", 0, lambda: role)
