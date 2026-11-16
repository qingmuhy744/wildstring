"""Stored pinyin keys match the old per-row functions and survive a schema 52 upgrade."""

import shutil
import sqlite3
from pathlib import Path

from mutagen.flac import FLAC

from wildstring.database import SCHEMA_VERSION, Database
from wildstring.library.browsing import name_order
from wildstring.library.edits import MetadataEditor, MetadataUpdate, Overrides
from wildstring.library.repository import ALBUM_SELECTION, LibraryRepository
from wildstring.library.scanner import scan_library
from wildstring.library.sorting import album_order, track_order

FIXTURE = Path(__file__).resolve().parents[2] / "tests/fixtures/audio/silence.flac"


def test_catalog_order_uses_stored_keys():
    assert "browse_sort" not in track_order("title", None, album=False)
    assert "browse_sort" not in track_order("play_count", "desc", album=False)
    assert "browse_sort" not in album_order("artist", None)
    assert "browse_sort" not in ALBUM_SELECTION
    assert "browse_group" not in ALBUM_SELECTION


def test_scan_edit_and_upgrade_keep_the_same_order(settings):
    path = settings.library_dir / "001.flac"
    shutil.copyfile(FIXTURE, path)
    tags = FLAC(path)
    tags["title"] = "重庆森林"
    tags["artist"] = "许嵩"
    tags["albumartist"] = "许嵩"
    tags["album"] = "九月"
    tags.save()
    assert scan_library(settings)["counts"]["added"] == 1

    database = Database(settings.data_dir)
    repository = LibraryRepository(database, settings.library_dir)
    with database.connect() as connection:
        track = connection.execute(
            """SELECT id, title_sort, title_group, album_sort, album_group,
            album_artist_sort, track_artist_sort FROM tracks"""
        ).fetchone()
        person = connection.execute("SELECT name_sort, name_group FROM people").fetchone()
    title_group, title_sort = name_order("重庆森林")
    album_group, album_sort = name_order("九月")
    artist_group, artist_sort = name_order("许嵩")
    assert (track["title_group"], track["title_sort"]) == (title_group, title_sort)
    assert (track["album_group"], track["album_sort"]) == (album_group, album_sort)
    assert track["album_artist_sort"] == artist_sort
    assert track["track_artist_sort"] == artist_sort
    assert (person["name_group"], person["name_sort"]) == (artist_group, artist_sort)

    MetadataEditor(repository).save(
        track["id"], MetadataUpdate(version=1, overrides=Overrides(title="周杰伦"))
    )
    with database.connect() as connection:
        updated = connection.execute("SELECT title_sort, title_group FROM tracks").fetchone()
    renamed_group, renamed_sort = name_order("周杰伦")
    assert (updated["title_group"], updated["title_sort"]) == (renamed_group, renamed_sort)

    with sqlite3.connect(database.path) as connection:
        view = connection.execute(
            "SELECT sql FROM sqlite_master WHERE type='view' AND name='personal_tracks'"
        ).fetchone()[0]
        assert "t.title_sort" in view
        connection.execute("DROP VIEW personal_tracks")
        connection.execute(view.replace(" t.title_sort, t.title_group,", ""))
        for column in (
            "title_sort",
            "title_group",
            "album_sort",
            "album_group",
            "album_artist_sort",
            "track_artist_sort",
        ):
            connection.execute(f"ALTER TABLE tracks DROP COLUMN {column}")
        connection.execute("ALTER TABLE people DROP COLUMN name_sort")
        connection.execute("ALTER TABLE people DROP COLUMN name_group")
        connection.execute("PRAGMA user_version=52")

    database.initialize()
    assert SCHEMA_VERSION == 53
    with database.connect() as connection:
        assert connection.execute("PRAGMA user_version").fetchone()[0] == 53
        restored = connection.execute(
            "SELECT title, title_sort, title_group FROM tracks"
        ).fetchone()
        restored_person = connection.execute(
            "SELECT name_sort, name_group FROM people WHERE name='许嵩'"
        ).fetchone()
        listed = connection.execute("SELECT title_sort FROM personal_tracks").fetchone()
    assert restored["title"] == "周杰伦"
    assert (restored["title_group"], restored["title_sort"]) == (renamed_group, renamed_sort)
    assert listed["title_sort"] == renamed_sort
    assert (restored_person["name_group"], restored_person["name_sort"]) == (
        artist_group,
        artist_sort,
    )
