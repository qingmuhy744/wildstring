"""Parameterized library persistence and query operations."""

import json
from dataclasses import asdict
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

from wildstring.database import Database
from wildstring.library.albums import album_key
from wildstring.library.artists import ARTIST_CREDITS, ARTIST_SUMMARY, configure_artist_queries
from wildstring.library.metadata import Metadata, normalize

COUNTERS = ("visited", "added", "updated", "unchanged", "errors", "missing", "skipped")


def now() -> str:
    return datetime.now(UTC).isoformat()


class LibraryRepository:
    def __init__(self, database: Database, root: Path):
        self.database = database
        self.root = root
        self._library_id: str | None = None

    def library_id(self, *, create: bool = False) -> str | None:
        if self._library_id is not None:
            return self._library_id
        with self.database.connect(write=create) as connection:
            if create:
                connection.execute(
                    "INSERT OR IGNORE INTO libraries(id, root) VALUES (?, ?)",
                    (uuid4().hex, str(self.root)),
                )
            row = connection.execute(
                "SELECT id FROM libraries WHERE root = ?", (str(self.root),)
            ).fetchone()
            self._library_id = row[0] if row else None
            return self._library_id

    def begin_scan(self) -> str:
        library_id = self.library_id(create=True)
        run_id = uuid4().hex
        with self.database.connect(write=True) as connection:
            # Caller owns the process lock, so leftover running rows cannot have a live scanner.
            connection.execute(
                "UPDATE scan_runs SET status = 'interrupted', finished_at = ? WHERE status = 'running'",
                (now(),),
            )
            connection.execute(
                "INSERT INTO scan_runs VALUES (?, ?, 'running', ?, NULL, ?)",
                (run_id, library_id, now(), json.dumps(dict.fromkeys(COUNTERS, 0))),
            )
        return run_id

    def progress(self, run_id: str, counts: dict[str, int], status: str = "running") -> None:
        with self.database.connect(write=True) as connection:
            connection.execute(
                "UPDATE scan_runs SET counts = ?, status = ?, finished_at = ? WHERE id = ?",
                (json.dumps(counts), status, None if status == "running" else now(), run_id),
            )

    def error(self, run_id: str, path: str, code: str) -> None:
        with self.database.connect(write=True) as connection:
            connection.execute(
                "INSERT INTO scan_errors(run_id, path, code) VALUES (?, ?, ?)", (run_id, path, code)
            )
            connection.execute(
                "UPDATE tracks SET seen_run = ?, status = 'unreadable' WHERE library_id = ? AND path = ?",
                (run_id, self.library_id(), path),
            )

    def existing(self, path: str) -> dict | None:
        with self.database.connect() as connection:
            row = connection.execute(
                "SELECT * FROM tracks WHERE library_id = ? AND path = ?", (self.library_id(), path)
            ).fetchone()
            return dict(row) if row else None

    def touch(self, track_id: str, run_id: str) -> None:
        with self.database.connect(write=True) as connection:
            connection.execute(
                "UPDATE tracks SET seen_run = ?, status = 'available' WHERE id = ?",
                (run_id, track_id),
            )

    def save(self, path: str, metadata: Metadata, size: int, mtime: int, run_id: str) -> None:
        fields = asdict(metadata)
        fields.update(
            id=uuid4().hex,
            library_id=self.library_id(),
            path=path,
            size_bytes=size,
            mtime_ns=mtime,
            added_at=now(),
            seen_run=run_id,
            search_text=normalize(
                " ".join(
                    [
                        metadata.title,
                        *metadata.artists,
                        metadata.album or "",
                        *metadata.album_artists,
                    ]
                )
            ),
        )
        fields["artists"] = json.dumps(metadata.artists, ensure_ascii=False)
        fields["album_artists"] = json.dumps(metadata.album_artists, ensure_ascii=False)
        fields["album_id"] = album_key(
            self.library_id(), path, metadata.album, metadata.album_artists
        )
        with self.database.connect(write=True) as connection:
            connection.execute(
                """INSERT INTO tracks (
                    id, library_id, path, title, title_source, artists, album, album_artists,
                    track_number, disc_number, duration_ms, format, sample_rate, channels,
                    has_cover, size_bytes, mtime_ns, status, seen_run, search_text, album_id, added_at
                ) VALUES (
                    :id, :library_id, :path, :title, :title_source, :artists, :album, :album_artists,
                    :track_number, :disc_number, :duration_ms, :format, :sample_rate, :channels,
                    :has_cover, :size_bytes, :mtime_ns, 'available', :seen_run, :search_text, :album_id, :added_at
                ) ON CONFLICT(library_id, path) DO UPDATE SET
                    title=excluded.title, title_source=excluded.title_source, artists=excluded.artists,
                    album=excluded.album, album_artists=excluded.album_artists,
                    track_number=excluded.track_number, disc_number=excluded.disc_number,
                    duration_ms=excluded.duration_ms, format=excluded.format,
                    sample_rate=excluded.sample_rate, channels=excluded.channels,
                    has_cover=excluded.has_cover, size_bytes=excluded.size_bytes,
                    mtime_ns=excluded.mtime_ns, status='available', seen_run=excluded.seen_run,
                    search_text=excluded.search_text, album_id=excluded.album_id""",
                fields,
            )

    def mark_missing(self, run_id: str) -> int:
        with self.database.connect(write=True) as connection:
            return connection.execute(
                "UPDATE tracks SET status = 'missing' WHERE library_id = ? AND seen_run != ? AND status != 'missing'",
                (self.library_id(), run_id),
            ).rowcount

    @staticmethod
    def public_track(row: dict) -> dict:
        result = dict(row)
        for key in ("library_id", "seen_run", "search_text", "mtime_ns"):
            result.pop(key)
        for key in ("artists", "album_artists"):
            result[key] = json.loads(result[key])
        result["has_cover"] = bool(result["has_cover"])
        result["loved"] = bool(result["loved"])
        result.pop("loved_at", None)
        return result

    def tracks(
        self,
        q: str = "",
        limit: int = 50,
        offset: int = 0,
        *,
        album_id: str | None = None,
        artist_id: str | None = None,
        played_only: bool = False,
        sort: str = "title",
    ) -> dict:
        query = normalize(q).replace("\\", "\\\\").replace("%", r"\%").replace("_", r"\_")
        parameters = {
            "library_id": self.library_id(),
            "query": query,
            "pattern": f"%{query}%",
            "album_id": album_id,
            "artist_id": artist_id,
            "limit": limit,
            "offset": offset,
            "played_only": played_only,
            "sort": sort,
        }
        with self.database.connect() as connection:
            configure_artist_queries(connection)
            total = connection.execute(
                "".join(
                    (
                        ARTIST_CREDITS,
                        """SELECT count(*) FROM tracks
                WHERE library_id = :library_id AND status = 'available'
                AND (:query = '' OR search_text LIKE :pattern ESCAPE '\\')
                AND (:album_id IS NULL OR album_id = :album_id)
                AND (:played_only = 0 OR last_played_at IS NOT NULL)
                AND (:artist_id IS NULL OR id IN
                    (SELECT track_id FROM artist_credits WHERE artist_id = :artist_id))""",
                    )
                ),
                parameters,
            ).fetchone()[0]
            rows = connection.execute(
                "".join(
                    (
                        ARTIST_CREDITS,
                        """SELECT * FROM tracks
                WHERE library_id = :library_id AND status = 'available'
                AND (:query = '' OR search_text LIKE :pattern ESCAPE '\\')
                AND (:album_id IS NULL OR album_id = :album_id)
                AND (:played_only = 0 OR last_played_at IS NOT NULL)
                AND (:artist_id IS NULL OR id IN
                    (SELECT track_id FROM artist_credits WHERE artist_id = :artist_id))
                ORDER BY CASE WHEN :sort = 'play_count' THEN play_count END DESC,
                CASE WHEN :sort = 'listened_ms' THEN listened_ms END DESC,
                CASE WHEN :sort = 'last_played_at' THEN last_played_at END DESC,
                CASE WHEN :album_id IS NOT NULL THEN COALESCE(disc_number, 1) END,
                CASE WHEN :album_id IS NOT NULL THEN COALESCE(track_number, 2147483647) END,
                title, id LIMIT :limit OFFSET :offset""",
                    )
                ),
                parameters,
            ).fetchall()
        return {
            "items": [self.public_track(dict(row)) for row in rows],
            "total": total,
            "limit": limit,
            "offset": offset,
        }

    def track(self, track_id: str) -> dict | None:
        with self.database.connect() as connection:
            row = connection.execute(
                "SELECT * FROM tracks WHERE library_id = ? AND id = ?",
                (self.library_id(), track_id),
            ).fetchone()
        return self.public_track(dict(row)) if row else None

    def source(self, track_id: str) -> dict | None:
        with self.database.connect() as connection:
            row = connection.execute(
                "SELECT path, format, size_bytes, mtime_ns, status FROM tracks WHERE library_id = ? AND id = ?",
                (self.library_id(), track_id),
            ).fetchone()
        return dict(row) if row else None

    def _album(self, connection, row) -> dict:
        result = dict(row)
        members = connection.execute(
            """SELECT id, artists, album_artists FROM tracks
            WHERE library_id = ? AND album_id = ? AND status = 'available'
            ORDER BY has_cover DESC, COALESCE(disc_number, 1), COALESCE(track_number, 2147483647), title, id""",
            (self.library_id(), result["id"]),
        ).fetchall()
        explicit = next(
            (
                json.loads(member["album_artists"])
                for member in members
                if json.loads(member["album_artists"])
            ),
            [],
        )
        result["artists"] = explicit or list(
            dict.fromkeys(artist for member in members for artist in json.loads(member["artists"]))
        )
        result["cover_track_id"] = members[0]["id"]
        return result

    def albums(
        self,
        q: str = "",
        limit: int = 50,
        offset: int = 0,
        *,
        artist_id: str | None = None,
    ) -> dict:
        query = normalize(q).replace("\\", "\\\\").replace("%", r"\%").replace("_", r"\_")
        parameters = {
            "library_id": self.library_id(),
            "query": query,
            "pattern": f"%{query}%",
            "artist_id": artist_id,
            "limit": limit,
            "offset": offset,
        }
        with self.database.connect() as connection:
            configure_artist_queries(connection)
            total = connection.execute(
                "".join(
                    (
                        ARTIST_CREDITS,
                        """SELECT count(*) FROM (SELECT album_id FROM tracks
                WHERE library_id = :library_id AND status = 'available'
                AND (:artist_id IS NULL OR id IN
                    (SELECT track_id FROM artist_credits WHERE artist_id = :artist_id))
                GROUP BY album_id
                HAVING :query = '' OR max(search_text LIKE :pattern ESCAPE '\\'))""",
                    )
                ),
                parameters,
            ).fetchone()[0]
            rows = connection.execute(
                "".join(
                    (
                        ARTIST_CREDITS,
                        """SELECT album_id AS id,
                min(COALESCE(NULLIF(album, ''), '未命名专辑')) AS title,
                count(*) AS track_count, sum(duration_ms) AS duration_ms FROM tracks
                WHERE library_id = :library_id AND status = 'available'
                AND (:artist_id IS NULL OR id IN
                    (SELECT track_id FROM artist_credits WHERE artist_id = :artist_id))
                GROUP BY album_id
                HAVING :query = '' OR max(search_text LIKE :pattern ESCAPE '\\')
                ORDER BY title, album_id LIMIT :limit OFFSET :offset""",
                    )
                ),
                parameters,
            ).fetchall()
            items = [self._album(connection, row) for row in rows]
        return {"items": items, "total": total, "limit": limit, "offset": offset}

    def artists(self, q: str = "", limit: int = 50, offset: int = 0) -> dict:
        query = normalize(q).replace("\\", "\\\\").replace("%", r"\%").replace("_", r"\_")
        parameters = {
            "library_id": self.library_id(),
            "query": query,
            "pattern": f"%{query}%",
            "limit": limit,
            "offset": offset,
        }
        with self.database.connect() as connection:
            configure_artist_queries(connection)
            total = connection.execute(
                "".join(
                    (
                        ARTIST_CREDITS,
                        """SELECT count(*) FROM (SELECT artist_id FROM artist_credits
                GROUP BY artist_id HAVING :query = '' OR max(normalized(name) LIKE :pattern ESCAPE '\\'))""",
                    )
                ),
                parameters,
            ).fetchone()[0]
            rows = connection.execute(
                "".join(
                    (
                        ARTIST_CREDITS,
                        ARTIST_SUMMARY,
                        """GROUP BY c.artist_id
                HAVING :query = '' OR max(normalized(c.name) LIKE :pattern ESCAPE '\\')
                ORDER BY normalized(name), id LIMIT :limit OFFSET :offset""",
                    )
                ),
                parameters,
            ).fetchall()
        return {
            "items": [dict(row) for row in rows],
            "total": total,
            "limit": limit,
            "offset": offset,
        }

    def artist(self, artist_id: str) -> dict | None:
        with self.database.connect() as connection:
            configure_artist_queries(connection)
            row = connection.execute(
                "".join(
                    (
                        ARTIST_CREDITS,
                        ARTIST_SUMMARY,
                        """WHERE c.artist_id = :artist_id GROUP BY c.artist_id""",
                    )
                ),
                {"library_id": self.library_id(), "artist_id": artist_id},
            ).fetchone()
        return dict(row) if row else None

    def album(self, album_id: str) -> dict | None:
        with self.database.connect() as connection:
            row = connection.execute(
                """SELECT album_id AS id, min(COALESCE(NULLIF(album, ''), '未命名专辑')) AS title,
                count(*) AS track_count, sum(duration_ms) AS duration_ms FROM tracks
                WHERE library_id = ? AND album_id = ? AND status = 'available' GROUP BY album_id""",
                (self.library_id(), album_id),
            ).fetchone()
            return self._album(connection, row) if row else None

    def scan(self, run_id: str) -> dict | None:
        with self.database.connect() as connection:
            row = connection.execute(
                "SELECT id, status, started_at, finished_at, counts FROM scan_runs WHERE id = ? AND library_id = ?",
                (run_id, self.library_id()),
            ).fetchone()
            if row is None:
                return None
            errors = connection.execute(
                "SELECT path, code FROM scan_errors WHERE run_id = ? ORDER BY id LIMIT 100",
                (run_id,),
            ).fetchall()
        result = dict(row)
        result["counts"] = json.loads(result["counts"])
        result["errors"] = [dict(error) for error in errors]
        return result

    def scans(self, limit: int = 20) -> list[dict]:
        with self.database.connect() as connection:
            ids = connection.execute(
                "SELECT id FROM scan_runs WHERE library_id = ? ORDER BY started_at DESC LIMIT ?",
                (self.library_id(), limit),
            ).fetchall()
        return [self.scan(row[0]) for row in ids]

    def imports(self, limit: int = 20) -> list[dict]:
        with self.database.connect() as connection:
            rows = connection.execute(
                "SELECT * FROM import_runs ORDER BY started_at DESC LIMIT ?", (limit,)
            ).fetchall()
        result = []
        for row in rows:
            item = dict(row)
            item["counts"] = json.loads(item["counts"])
            item["errors"] = json.loads(item["errors"])
            result.append(item)
        return result
