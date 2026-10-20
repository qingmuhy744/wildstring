"""Allowlisted sort clauses; ordering is applied before server-side pagination."""

from typing import Literal

TrackSort = Literal[
    "title",
    "name",
    "track_number",
    "added_at",
    "duration_ms",
    "play_count",
    "listened_ms",
    "last_played_at",
]
AlbumSort = Literal["title", "artist", "added_at", "release_date"]
SortOrder = Literal["asc", "desc"]


def track_order(sort: str, order: str | None, *, album: bool) -> str:
    # Legacy clients call album track order "title". New clients use explicit
    # track_number / name, leaving the existing wire contract unchanged.
    key = "track_number" if sort == "title" and album else sort
    columns = {
        "title": "browse_sort(title)",
        "name": "browse_sort(title)",
        "track_number": "COALESCE(disc_number, 1)",
        "added_at": "added_at",
        "duration_ms": "duration_ms",
        "play_count": "play_count",
        "listened_ms": "listened_ms",
        "last_played_at": "last_played_at",
    }
    direction = {"asc": "ASC", "desc": "DESC"}[
        order or ("asc" if key in ("title", "name", "track_number") else "desc")
    ]
    primary = columns[key] + " " + direction + " NULLS LAST, "
    if key == "track_number":
        primary += "track_number " + direction + " NULLS LAST, "
    return primary + "browse_sort(title), id"


def album_order(sort: str, order: str | None) -> str:
    column = {
        "title": "browse_sort(title)",
        "artist": "sort_artist",
        "added_at": "added_at",
        "release_date": "release_date",
    }[sort]
    direction = {"asc": "ASC", "desc": "DESC"}[
        order or ("desc" if sort in ("added_at", "release_date") else "asc")
    ]
    return column + " " + direction + " NULLS LAST, browse_sort(title), id"
