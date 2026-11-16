"""Schema 53: persist pinyin browse keys so catalog pages do not call Python per row."""

import json

from wildstring.library.browsing import name_order, track_browse_keys


def migrate(connection):
    connection.execute("BEGIN IMMEDIATE")
    columns = {row[1] for row in connection.execute("PRAGMA table_info(tracks)")}
    for name, definition in (
        ("title_sort", "TEXT NOT NULL DEFAULT ''"),
        ("title_group", "TEXT NOT NULL DEFAULT '#'"),
        ("album_sort", "TEXT NOT NULL DEFAULT ''"),
        ("album_group", "TEXT NOT NULL DEFAULT '#'"),
        ("album_artist_sort", "TEXT"),
        ("track_artist_sort", "TEXT NOT NULL DEFAULT ''"),
    ):
        if name not in columns:
            connection.execute(f"ALTER TABLE tracks ADD COLUMN {name} {definition}")
    people = {row[1] for row in connection.execute("PRAGMA table_info(people)")}
    for name, definition in (
        ("name_sort", "TEXT NOT NULL DEFAULT ''"),
        ("name_group", "TEXT NOT NULL DEFAULT '#'"),
    ):
        if name not in people:
            connection.execute(f"ALTER TABLE people ADD COLUMN {name} {definition}")
    _backfill_tracks(connection)
    _backfill_people(connection)
    _extend_personal_tracks(connection)
    connection.execute("PRAGMA user_version=53")
    connection.commit()


def _backfill_tracks(connection):
    rows = connection.execute(
        "SELECT id, title, album, artists, album_artists FROM tracks"
    ).fetchall()
    payload = []
    for row in rows:
        keys = track_browse_keys(
            row["title"],
            row["album"],
            json.loads(row["artists"]),
            json.loads(row["album_artists"]),
        )
        payload.append(
            (
                keys["title_sort"],
                keys["title_group"],
                keys["album_sort"],
                keys["album_group"],
                keys["album_artist_sort"],
                keys["track_artist_sort"],
                row["id"],
            )
        )
    connection.executemany(
        """UPDATE tracks SET title_sort=?, title_group=?, album_sort=?, album_group=?,
        album_artist_sort=?, track_artist_sort=? WHERE id=?""",
        payload,
    )


def _backfill_people(connection):
    rows = connection.execute("SELECT id, name FROM people").fetchall()
    payload = []
    for row in rows:
        group, sort_key = name_order(row["name"])
        payload.append((sort_key, group, row["id"]))
    connection.executemany("UPDATE people SET name_sort=?, name_group=? WHERE id=?", payload)


def _extend_personal_tracks(connection):
    row = connection.execute(
        "SELECT sql FROM sqlite_master WHERE type='view' AND name='personal_tracks'"
    ).fetchone()
    if row is None:
        raise RuntimeError("personal_tracks view is missing")
    view = row[0]
    if "t.title_sort" in view:
        return
    needle = "t.title,"
    if needle not in view:
        raise RuntimeError("personal_tracks view has no title column")
    connection.execute("DROP VIEW personal_tracks")
    connection.execute(view.replace(needle, "t.title, t.title_sort, t.title_group,", 1))
