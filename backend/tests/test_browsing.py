"""Global pinyin letter offsets are consistent with real scanned, filtered API pages."""

import shutil
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from mutagen.flac import FLAC
from test_users import login, new_user

from wildstring.database import Database
from wildstring.library.browsing import BROWSE_KEYS, name_order
from wildstring.library.repository import LibraryRepository
from wildstring.library.scanner import scan_library
from wildstring.main import create_app

FIXTURE = Path(__file__).resolve().parents[2] / "tests/fixtures/audio/silence.flac"


def song(settings, number, title, *, artist=None, album=None, composer=None, disc=1, track=1):
    path = settings.library_dir / f"{number:03}.flac"
    shutil.copyfile(FIXTURE, path)
    tags = FLAC(path)
    tags["title"] = title
    tags["artist"] = artist or title
    tags["albumartist"] = artist or title
    tags["album"] = album or title
    tags["discnumber"] = str(disc)
    tags["tracknumber"] = str(track)
    if composer:
        tags["composer"] = composer
    tags.save()
    return path


@pytest.mark.parametrize(
    ("name", "group"),
    [
        ("９号", "0–9"),
        ("  Ａlpha", "A"),
        ("Écho", "E"),
        ("重庆森林", "C"),
        ("阿尔法", "A"),
        ("许嵩", "X"),
        ("一无所有", "Y"),
        ("周杰倫", "Z"),
        ("#有符号", "#"),
        ("Ω", "#"),
        ("😀", "#"),
        ("", "#"),
    ],
)
def test_normalization_pinyin_and_unclassified_names_are_repeatable(name, group):
    expected = name_order(name)
    assert expected[0] == group
    # New connections and cache eviction cannot choose a different polyphonic reading.
    name_order.cache_clear()
    assert name_order(name) == expected


@pytest.fixture
def large_library(settings):
    names = [f"A{number:03}" for number in range(120)] + [
        "９号",
        "阿尔法",
        "重庆森林",
        "许嵩",
        "一无所有",
        "周杰伦",
        "Zebra",
        "#未知",
        "Ω",
    ]
    for number, title in enumerate(reversed(names)):
        song(settings, number, title)
    report = scan_library(settings)
    assert report["counts"]["added"] == 129


@pytest.mark.parametrize("kind", ["tracks", "albums", "artists"])
def test_global_index_jumps_beyond_loaded_pages(
    settings, authenticated_client, large_library, kind
):
    with authenticated_client(settings) as client:
        params = {"role": "artist"} if kind == "artists" else {}
        index = client.get("/api/v1/browse-index", params={"kind": kind} | params).json()
        assert index["total"] == 129 and index["kind"] == kind
        assert [group["key"] for group in index["groups"]] == list(BROWSE_KEYS)
        groups = {group["key"]: group for group in index["groups"]}
        expected = {
            "0–9": (0, 1),
            "A": (1, 121),
            "C": (122, 1),
            "X": (123, 1),
            "Y": (124, 1),
            "Z": (125, 2),
            "#": (127, 2),
        }
        for key, group in groups.items():
            assert (group["offset"], group["count"]) == expected.get(key, (None, 0))
        # Fetch Z before the middle page has ever been loaded.
        target = client.get(
            f"/api/v1/{kind}", params=params | {"limit": 1, "offset": groups["Z"]["offset"]}
        ).json()
        name = "name" if kind == "artists" else "title"
        assert target["items"][0][name] == "Zebra"
        items = []
        for offset in (0, 50, 100):
            page = client.get(
                f"/api/v1/{kind}", params=params | {"limit": 50, "offset": offset}
            ).json()
            assert page["total"] == 129
            items.extend(page["items"])
        assert len({item["id"] for item in items}) == 129
        assert [item[name] for item in items[:3]] == ["９号", "A000", "A001"]
        assert [item[name] for item in items[121:127]] == [
            "阿尔法",
            "重庆森林",
            "许嵩",
            "一无所有",
            "Zebra",
            "周杰伦",
        ]
        for key, (offset, count) in expected.items():
            assert len(items[offset : offset + count]) == count
            first = client.get(
                f"/api/v1/{kind}", params=params | {"limit": 1, "offset": offset}
            ).json()["items"][0]
            assert first["id"] == items[offset]["id"], key


def test_indexes_share_literal_search_contributor_filters_and_availability(
    settings, authenticated_client, tmp_path
):
    song(settings, 0, "一无所有", artist="许嵩", album="共同专辑", composer="周杰伦", track=2)
    removed = song(settings, 1, "Zebra", artist="许嵩", album="共同专辑", track=1)
    song(settings, 2, "100%_原样", artist="甲", album="百分比", composer="许嵩")
    song(settings, 3, "100XY其他", artist="甲", album="其他")
    scan_library(settings)
    removed.unlink()
    scan_library(settings)
    with authenticated_client(settings) as client:
        artist = client.get("/api/v1/artists", params={"q": "许嵩"}).json()["items"][0]
        for kind in ("tracks", "albums"):
            for role, total in (("artist", 1), ("composer", 1), (None, 2)):
                filters = {} if role is None else {"role": role}
                index = client.get(
                    "/api/v1/browse-index",
                    params={"kind": kind, "artist_id": artist["id"]} | filters,
                ).json()
                page = client.get(f"/api/v1/artists/{artist['id']}/{kind}", params=filters).json()
                assert index["total"] == page["total"] == total
                assert sum(group["count"] for group in index["groups"]) == total
                for group in index["groups"]:
                    if group["offset"] is not None:
                        name = page["items"][group["offset"]]["title"]
                        assert name_order(name)[0] == group["key"]
        for kind in ("tracks", "albums", "artists"):
            for query in ("%_", "%' OR 1=1 --", "许嵩", "不存在"):
                index = client.get("/api/v1/browse-index", params={"kind": kind, "q": query}).json()
                page = client.get(f"/api/v1/{kind}", params={"q": query}).json()
                assert index["total"] == page["total"]
                assert sum(group["count"] for group in index["groups"]) == page["total"]
        # The same database can hold another root without exposing its names/counts.
        other = tmp_path / "another-root"
        other.mkdir()
        store = LibraryRepository(Database(settings.data_dir), other)
        assert store.browse_index("tracks")["total"] == 0
        assert store.browse_index("albums")["total"] == 0
        assert store.browse_index("artists")["total"] == 0


def test_album_index_uses_album_names_when_song_titles_have_different_initials(
    settings, authenticated_client
):
    # Album names deliberately differ from track names. SQLite resolves a name
    # inside a function to the source column before considering a SELECT alias.
    albums = [f"Alpha {number:03}" for number in range(51)] + [
        "合成测试专辑",
        "九月",
        "摇滚",
        "Zebra",
    ]
    for number, album in enumerate(albums):
        song(settings, number, f"曲目{999 - number}", album=album, artist="同一艺人")
    song(settings, 55, "#额外曲目", album="九月", artist="同一艺人", track=2)
    scan_library(settings)
    with authenticated_client(settings) as client:
        artist_id = client.get("/api/v1/artists?role=artist").json()["items"][0]["id"]
        for artist in (None, artist_id):
            filters = {"artist_id": artist, "role": "artist"} if artist else {}
            endpoint = f"/api/v1/artists/{artist}/albums" if artist else "/api/v1/albums"
            index = client.get("/api/v1/browse-index", params={"kind": "albums"} | filters).json()
            groups = {group["key"]: group for group in index["groups"]}
            assert (index["total"], groups["J"]["offset"], groups["J"]["count"]) == (55, 52, 1)
            page = client.get(endpoint, params={"limit": 1, "offset": 52, "role": "artist"}).json()
            assert page["items"][0]["title"] == "九月"
            items = []
            for offset in (0, 50):
                items.extend(
                    client.get(endpoint, params={"limit": 50, "offset": offset}).json()["items"]
                )
            assert [item["title"] for item in items] == albums
            assert items[52]["track_count"] == 2
            for group in index["groups"]:
                if group["offset"] is not None:
                    target = client.get(
                        endpoint, params={"limit": 1, "offset": group["offset"]}
                    ).json()["items"][0]
                    assert target["title"] == albums[group["offset"]]


def test_album_track_order_statistics_and_duplicate_names_remain_stable(
    settings, authenticated_client
):
    song(settings, 0, "Alpha", artist="许嵩", album="V", disc=2, track=1)
    song(settings, 1, "周杰伦", artist="许嵩", album="V", disc=1, track=2)
    song(settings, 2, "Zebra", artist="许嵩", album="V", disc=1, track=1)
    song(settings, 3, "Alpha", artist="许嵩", album="V", disc=2, track=2)
    scan_library(settings)
    with authenticated_client(settings) as client:
        page = client.get("/api/v1/tracks").json()["items"]
        duplicates = [item["id"] for item in page if item["title"] == "Alpha"]
        assert duplicates == sorted(duplicates)
        assert (
            client.get("/api/v1/tracks?limit=1&offset=1").json()["items"][0]["id"] == duplicates[1]
        )
        album_id = page[0]["album_id"]
        album_tracks = client.get(f"/api/v1/albums/{album_id}/tracks").json()["items"]
        assert [(item["disc_number"], item["track_number"]) for item in album_tracks] == [
            (1, 1),
            (1, 2),
            (2, 1),
            (2, 2),
        ]
        artist_id = client.get("/api/v1/artists?q=许嵩").json()["items"][0]["id"]
        intersection = client.get(
            f"/api/v1/artists/{artist_id}/tracks", params={"album_id": album_id}
        ).json()["items"]
        assert [item["id"] for item in intersection] == [item["id"] for item in album_tracks]
        database = Database(settings.data_dir)
        with database.connect(write=True) as connection:
            connection.execute(
                "INSERT INTO user_track_state(user_id,track_id,play_count,listened_ms,last_played_at) VALUES('admin',?,5,60000,'2026-10-17')",
                (album_tracks[1]["id"],),
            )
        for sort in ("play_count", "listened_ms", "last_played_at"):
            sorted_tracks = client.get("/api/v1/tracks", params={"sort": sort}).json()["items"]
            assert sorted_tracks[0]["id"] == album_tracks[1]["id"]


@pytest.mark.parametrize(
    ("sort", "listener_order", "admin_order"),
    [
        ("play_count", ["Alpha", "Zebra", "中文"], ["中文", "Zebra", "Alpha"]),
        ("listened_ms", ["Zebra", "中文", "Alpha"], ["Alpha", "Zebra", "中文"]),
        ("last_played_at", ["中文", "Zebra", "Alpha"], ["Alpha", "Zebra", "中文"]),
    ],
)
def test_album_and_artist_http_statistics_sorts_use_the_current_users_metrics(
    settings, authenticated_client, sort, listener_order, admin_order
):
    for number, (title, position) in enumerate((("Alpha", 3), ("Zebra", 1), ("中文", 2))):
        song(settings, number, title, artist="许嵩", album="V", track=position)
    scan_library(settings)
    with authenticated_client(settings) as admin:
        tracks = admin.get("/api/v1/tracks").json()["items"]
        artist_id = admin.get("/api/v1/artists?q=许嵩").json()["items"][0]["id"]
        album_id = tracks[0]["album_id"]
        account = new_user(admin)
        admin_metrics = [(1, 500, "2026-10-17"), (5, 200, "2026-10-16"), (10, 100, "2026-10-15")]
        listener_metrics = [(20, 10, "2026-10-15"), (10, 300, "2026-10-16"), (5, 200, "2026-10-17")]
        with Database(settings.data_dir).connect(write=True) as connection:
            for user_id, metrics in (("admin", admin_metrics), (account["id"], listener_metrics)):
                connection.executemany(
                    "INSERT INTO user_track_state(user_id,track_id,play_count,listened_ms,last_played_at) VALUES(?,?,?,?,?)",
                    [
                        (user_id, track["id"], *metric)
                        for track, metric in zip(tracks, metrics, strict=True)
                    ],
                )
        endpoints = [
            (f"/api/v1/albums/{album_id}/tracks", {}),
            (f"/api/v1/artists/{artist_id}/tracks", {}),
            (f"/api/v1/artists/{artist_id}/tracks", {"album_id": album_id}),
        ]
        with TestClient(create_app(settings)) as listener:
            assert login(listener).status_code == 200
            for endpoint, filters in endpoints:
                defaults = listener.get(endpoint, params=filters).json()["items"]
                expected_default = (
                    ["Zebra", "中文", "Alpha"]
                    if "albums/" in endpoint or filters
                    else ["Alpha", "Zebra", "中文"]
                )
                assert [item["title"] for item in defaults] == expected_default
                page = listener.get(endpoint, params=filters | {"sort": sort}).json()
                assert [item["title"] for item in page["items"]] == listener_order
                assert page["total"] == 3
                second = listener.get(
                    endpoint, params=filters | {"sort": sort, "offset": 1, "limit": 1}
                ).json()
                assert second["items"][0]["title"] == listener_order[1]
                private = admin.get(endpoint, params=filters | {"sort": sort}).json()["items"]
                assert [item["title"] for item in private] == admin_order
                assert (
                    listener.get(endpoint, params=filters | {"sort": "invalid"}).status_code == 422
                )


def test_index_auth_validation_empty_library_and_regular_user(settings, authenticated_client):
    with TestClient(create_app(settings)) as unauthenticated:
        assert unauthenticated.get("/api/v1/browse-index?kind=tracks").status_code == 401
    with authenticated_client(settings) as admin:
        for kind in ("tracks", "albums", "artists"):
            index = admin.get("/api/v1/browse-index", params={"kind": kind}).json()
            assert index["total"] == 0
            assert len(index["groups"]) == 28
            assert all(group["offset"] is None and group["count"] == 0 for group in index["groups"])
        for params in ({}, {"kind": "playlists"}, {"kind": "tracks", "role": "invalid"}):
            assert admin.get("/api/v1/browse-index", params=params).status_code == 422
        assert admin.get("/api/v1/browse-index?kind=tracks&artist_id=missing").status_code == 404
        for kind in ("tracks", "albums", "artists"):
            response = admin.get("/api/v1/browse-index", params={"kind": kind, "album_id": "x"})
            assert response.status_code == 400
            assert response.json()["detail"] == "browse_index_not_supported"
        assert admin.get("/api/v1/browse-index?kind=artists&artist_id=x").status_code == 400
        song(settings, 0, "许嵩")
        scan_library(settings)
        new_user(admin)
        with TestClient(create_app(settings)) as listener:
            assert login(listener).status_code == 200
            response = listener.get("/api/v1/browse-index?kind=tracks")
            assert response.status_code == 200
            assert response.json()["total"] == 1
            assert response.json() == admin.get("/api/v1/browse-index?kind=tracks").json()


@pytest.mark.parametrize("order", ["asc", "desc"])
def test_explicit_track_sorting_and_disc_offsets_cover_the_whole_filtered_album(
    settings, authenticated_client, order
):
    for i, (title, disc, track) in enumerate((("Zebra", 1, 1), ("Alpha", 1, 2), ("Middle", 2, 1))):
        song(settings, i, title, artist="同一艺人", album="双碟", disc=disc, track=track)
    scan_library(settings)
    with authenticated_client(settings) as client:
        album = client.get("/api/v1/albums").json()["items"][0]["id"]
        artist = client.get("/api/v1/artists").json()["items"][0]["id"]
        for endpoint, extra in (
            (f"/api/v1/albums/{album}/tracks", {}),
            (f"/api/v1/artists/{artist}/tracks", {"album_id": album}),
        ):

            def page(sort, offset=0, endpoint=endpoint, extra=extra):
                response = client.get(
                    endpoint,
                    params=extra | {"sort": sort, "order": order, "limit": 1, "offset": offset},
                )
                assert response.status_code == 200, response.text
                return response.json()

            names = [page("name", i)["items"][0]["title"] for i in range(3)]
            assert names == sorted(["Zebra", "Alpha", "Middle"], reverse=order == "desc")
            original = [page("track_number", i)["items"][0]["title"] for i in range(3)]
            assert original == (
                ["Zebra", "Alpha", "Middle"] if order == "asc" else ["Middle", "Alpha", "Zebra"]
            )
            summaries = page("track_number", 1)["discs"]
            assert [(d["number"], d["track_count"], d["offset"]) for d in summaries] == (
                [(1, 2, 0), (2, 1, 2)] if order == "asc" else [(2, 1, 0), (1, 2, 1)]
            )
        assert client.get("/api/v1/tracks?sort=added_at&order=INVALID").status_code == 422
        assert client.get("/api/v1/albums?sort=title%3BDROP%20TABLE%20tracks").status_code == 422


@pytest.mark.parametrize("order", ["asc", "desc"])
def test_album_sorting_uses_first_import_date_and_unknown_release_dates_stay_last(
    settings, authenticated_client, order
):
    for i, (album, artist) in enumerate(
        (("Alpha", "Zebra"), ("Zebra", "Alpha"), ("Missing", "Middle"))
    ):
        song(settings, i, album, album=album, artist=artist)
    scan_library(settings)
    database = Database(settings.data_dir)
    with database.connect(write=True) as connection:
        connection.execute(
            "UPDATE tracks SET added_at = '2020-01-01T00:00:00Z', extra = '{\"release_date\":\"2010\"}' WHERE album='Alpha'"
        )
        connection.execute(
            "UPDATE tracks SET added_at = '2022-01-01T00:00:00Z', extra = '{\"release_date\":\"2020-02\"}' WHERE album='Zebra'"
        )
        connection.execute(
            "UPDATE tracks SET added_at = '2024-01-01T00:00:00Z' WHERE album='Missing'"
        )
    # Re-reading tags and adding another song must not reset the original import date.
    scan_library(settings, full=True)
    with database.connect(write=True) as connection:
        connection.execute(
            "UPDATE tracks SET extra = '{\"release_date\":\"2010\"}' WHERE album='Alpha'"
        )
        connection.execute(
            "UPDATE tracks SET extra = '{\"release_date\":\"2020-02\"}' WHERE album='Zebra'"
        )
    song(settings, 3, "补入", album="Alpha", artist="Zebra", track=2)
    scan_library(settings)
    with authenticated_client(settings) as client:

        def titles(sort):
            return [
                client.get(
                    "/api/v1/albums", params={"sort": sort, "order": order, "limit": 1, "offset": i}
                ).json()["items"][0]["title"]
                for i in range(3)
            ]

        assert titles("added_at") == (
            ["Alpha", "Zebra", "Missing"] if order == "asc" else ["Missing", "Zebra", "Alpha"]
        )
        assert titles("release_date") == (
            ["Alpha", "Zebra", "Missing"] if order == "asc" else ["Zebra", "Alpha", "Missing"]
        )
        assert titles("artist") == (
            ["Zebra", "Missing", "Alpha"] if order == "asc" else ["Alpha", "Missing", "Zebra"]
        )
        item = client.get("/api/v1/albums?sort=added_at&order=asc").json()["items"][0]
        assert item["added_at"] == "2020-01-01T00:00:00Z"
        for sort in ("added_at", "duration_ms", "play_count", "last_played_at"):
            all_ids = [
                t["id"]
                for t in client.get("/api/v1/tracks", params={"sort": sort, "order": order}).json()[
                    "items"
                ]
            ]
            paged = [
                client.get(
                    "/api/v1/tracks", params={"sort": sort, "order": order, "limit": 1, "offset": i}
                ).json()["items"][0]["id"]
                for i in range(4)
            ]
            assert paged == all_ids
