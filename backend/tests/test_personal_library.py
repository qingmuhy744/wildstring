"""Artist credits, persistent collections and trustworthy listening aggregation."""

import shutil
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

from fastapi.testclient import TestClient
from mutagen.flac import FLAC

from wildstring.database import AUTH_SCHEMA, IMPORT_SCHEMA, SCHEMA, Database
from wildstring.library.repository import LibraryRepository
from wildstring.library.scanner import scan_library
from wildstring.main import create_app

FIXTURE = Path(__file__).resolve().parents[2] / "tests/fixtures/audio/silence.flac"
HEADERS = {"X-Wildstring-Client": "web"}


def music(settings, name, artists, album_artists, album="共同专辑", number=1):
    path = settings.library_dir / name
    path.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(FIXTURE, path)
    tags = FLAC(path)
    for key in ("artist", "albumartist"):
        if key in tags:
            del tags[key]
    if artists:
        tags["artist"] = artists
    if album_artists:
        tags["albumartist"] = album_artists
    tags["title"], tags["album"] = name, album
    tags["tracknumber"] = str(number)
    tags.save()
    return path


def get_tracks(client):
    return {track["title"]: track for track in client.get("/api/v1/tracks").json()["items"]}


def create_playlist(client, name="自己的歌单", definition=None):
    response = client.post(
        "/api/v1/playlists",
        headers=HEADERS,
        json={"name": name, "kind": "smart" if definition else "manual", "definition": definition},
    )
    assert response.status_code == 201, response.text
    return response.json()


def test_artist_credits_album_intersection_and_normalized_identity(settings, authenticated_client):
    music(settings, "合唱.flac", ["甲", "乙", "甲"], ["甲"], number=1)
    music(settings, "独唱.flac", ["甲"], ["甲"], number=2)
    music(settings, "合辑甲.flac", ["甲"], ["Various Artists"], album="摇滚合集", number=1)
    music(settings, "合辑丙.flac", ["丙"], ["Various Artists"], album="摇滚合集", number=2)
    music(settings, "电流1.flac", ["AC/DC"], ["AC/DC"], album="电流")
    music(settings, "电流2.flac", ["ac/dc"], ["ＡＣ／ＤＣ"], album="电流", number=2)
    music(settings, "无标签.flac", [], [], album="未知")
    scan_library(settings)
    with authenticated_client(settings) as client:
        artists = client.get("/api/v1/artists").json()
        assert artists["total"] == 5
        by_name = {item["name"]: item for item in artists["items"]}
        main = by_name["甲"]
        assert (main["track_count"], main["album_count"]) == (3, 2)
        assert by_name["乙"]["track_count"] == 1
        assert by_name["AC/DC"]["track_count"] == 2
        assert client.get("/api/v1/artists", params={"q": "ａｃ／ｄｃ"}).json()["total"] == 1
        assert client.get("/api/v1/artists?q=摇滚合集").json()["total"] == 0
        detail = client.get("/api/v1/artists/" + main["id"]).json()
        assert detail == main
        assert detail["duration_ms"] == sum(
            t["duration_ms"] for t in get_tracks(client).values() if "甲" in t["artists"]
        )
        albums = client.get(f"/api/v1/artists/{main['id']}/albums").json()["items"]
        compilation = next(item for item in albums if item["title"] == "摇滚合集")
        assert compilation["track_count"] == 1
        scoped = client.get(
            f"/api/v1/artists/{main['id']}/tracks", params={"album_id": compilation["id"]}
        ).json()
        assert [t["title"] for t in scoped["items"]] == ["合辑甲.flac"]
        assert client.get("/api/v1/artists?limit=1").json()["total"] == 5
        assert len(client.get("/api/v1/artists?limit=1&offset=1").json()["items"]) == 1
        before = main["id"]
        music(settings, "新曲.flac", ["甲"], ["甲"], album="新专辑")
        scan_library(settings)
        assert client.get("/api/v1/artists?q=甲").json()["items"][0]["id"] == before
        assert client.get("/api/v1/artists?limit=101").status_code == 422
        assert client.get("/api/v1/artists?offset=-1").status_code == 422
        assert client.get("/api/v1/artists/missing/tracks").status_code == 404


def test_artist_literal_search_missing_and_library_isolation(
    settings, authenticated_client, tmp_path
):
    path = music(settings, "literal.flac", ["100%_乐队"], [], album="一")
    music(settings, "other.flac", ["100XY乐队"], [], album="二")
    scan_library(settings)
    with authenticated_client(settings) as client:
        page = client.get("/api/v1/artists", params={"q": "%_"}).json()
        assert page["total"] == 1
        artist_id = page["items"][0]["id"]
        other_root = tmp_path / "other-library"
        other_root.mkdir()
        isolated = LibraryRepository(Database(settings.data_dir), other_root)
        assert isolated.artists()["total"] == 0
        assert isolated.artist(artist_id) is None
        assert isolated.tracks(artist_id=artist_id)["total"] == 0
        path.unlink()
        scan_library(settings)
        assert client.get("/api/v1/artists/" + artist_id).status_code == 404


def test_default_favorites_persist_and_share_track_state(settings, authenticated_client):
    music(settings, "歌.flac", ["乐队"], ["乐队"])
    scan_library(settings)
    with authenticated_client(settings) as client:
        track = next(iter(get_tracks(client).values()))
        lists = client.get("/api/v1/playlists").json()["items"]
        assert len(lists) == 1
        default = lists[0]
        assert default["kind"] == "favorites" and default["track_count"] == 0
        assert default["name"] == "♥ 我喜欢"
        url = f"/api/v1/tracks/{track['id']}/favorite"
        assert client.put(url, json={"loved": True}).status_code == 403
        assert client.put(url, headers=HEADERS, json={"loved": True}).status_code == 200
        assert client.put(url, headers=HEADERS, json={"loved": True}).status_code == 200
        favorite_tracks = client.get(f"/api/v1/playlists/{default['id']}/tracks").json()["items"]
        assert len(favorite_tracks) == 1 and favorite_tracks[0]["loved"] is True
        assert (
            client.delete(
                f"/api/v1/playlists/{default['id']}?version=1", headers=HEADERS
            ).status_code
            == 409
        )
        assert (
            client.post(
                f"/api/v1/playlists/{default['id']}/tracks",
                headers=HEADERS,
                json={"version": 1, "track_ids": [track["id"]]},
            ).status_code
            == 409
        )
    with authenticated_client(settings) as client:
        assert len(client.get("/api/v1/playlists").json()["items"]) == 1
        assert client.get("/api/v1/favorites/ids").json()["ids"] == [track["id"]]
        client.put(url, headers=HEADERS, json={"loved": False})
        assert client.get(f"/api/v1/playlists/{default['id']}/tracks").json()["total"] == 0


def test_manual_playlist_atomic_add_order_move_remove_and_versions(settings, authenticated_client):
    for i in range(3):
        music(settings, f"{i}.flac", ["乐队"], ["乐队"], number=i + 1)
    scan_library(settings)
    with authenticated_client(settings) as client:
        ids = [t["id"] for t in get_tracks(client).values()]
        playlist = create_playlist(client)
        endpoint = "/api/v1/playlists/" + playlist["id"]
        body = {"version": 1, "track_ids": ids[:2]}
        response = client.post(endpoint + "/tracks", headers=HEADERS, json=body)
        assert response.status_code == 200
        assert response.json()["track_count"] == 2
        assert client.post(endpoint + "/tracks", headers=HEADERS, json=body).status_code == 409
        response = client.post(
            endpoint + "/tracks", headers=HEADERS, json={"version": 2, "track_ids": [ids[0]]}
        )
        assert response.json()["track_count"] == 2
        assert (
            client.post(
                endpoint + "/tracks",
                headers=HEADERS,
                json={"version": 3, "track_ids": [ids[2], "missing"]},
            ).status_code
            == 404
        )
        assert client.get(endpoint).json()["version"] == 3
        assert client.get(endpoint + "/tracks").json()["total"] == 2
        response = client.put(
            endpoint + "/order",
            headers=HEADERS,
            json={"version": 3, "track_ids": list(reversed(ids[:2]))},
        )
        assert response.status_code == 200
        assert [t["id"] for t in client.get(endpoint + "/tracks").json()["items"]] == list(
            reversed(ids[:2])
        )
        assert (
            client.put(
                endpoint + "/order",
                headers=HEADERS,
                json={"version": 4, "track_ids": [ids[0], ids[0]]},
            ).status_code
            == 409
        )
        response = client.post(
            endpoint + "/move",
            headers=HEADERS,
            json={"version": 4, "track_id": ids[0], "direction": -1},
        )
        assert response.status_code == 200
        assert [t["id"] for t in client.get(endpoint + "/tracks").json()["items"]] == ids[:2]
        assert (
            client.delete(
                endpoint + "/tracks/" + ids[0] + "?version=5", headers=HEADERS
            ).status_code
            == 200
        )
        assert client.get(endpoint + "/tracks?limit=1").json()["total"] == 1
        assert (
            client.put(
                endpoint, headers=HEADERS, json={"version": 6, "name": "新名字", "kind": "manual"}
            ).status_code
            == 200
        )
        assert client.get(endpoint).json()["name"] == "新名字"
        assert client.delete(endpoint + "?version=7", headers=HEADERS).status_code == 204
        assert client.get(endpoint).status_code == 404


def test_smart_nested_rules_live_favorites_limits_and_literal_values(
    settings, authenticated_client
):
    music(settings, "A%_.flac", ["AC/DC"], ["AC/DC"], album="摇滚")
    music(settings, "B.flac", ["其他"], ["其他"], album="民谣")
    music(settings, "C.flac", ["AC/DC"], ["AC/DC"], album="现场")
    scan_library(settings)
    with authenticated_client(settings) as client:
        tracks = get_tracks(client)
        definition = {
            "all": [
                {"is": {"artist": "ac/dc"}},
                {"any": [{"contains": {"album": "摇"}}, {"is": {"loved": True}}]},
            ],
            "sort": "title",
            "order": "asc",
            "limit": 1,
        }
        playlist = create_playlist(client, "我的规则", definition)
        endpoint = "/api/v1/playlists/" + playlist["id"]
        assert playlist["track_count"] == 1
        assert [t["title"] for t in client.get(endpoint + "/tracks").json()["items"]] == [
            "A%_.flac"
        ]
        assert client.get(endpoint + "/tracks?q=C.flac").json()["total"] == 0  # filter after cap
        definition["limit"] = 10
        updated = client.put(
            endpoint,
            headers=HEADERS,
            json={"name": "新规则", "kind": "smart", "version": 1, "definition": definition},
        )
        assert updated.status_code == 200
        assert (
            client.post(
                endpoint + "/tracks",
                headers=HEADERS,
                json={"version": 2, "track_ids": [tracks["B.flac"]["id"]]},
            ).status_code
            == 409
        )
        client.put(
            f"/api/v1/tracks/{tracks['C.flac']['id']}/favorite",
            headers=HEADERS,
            json={"loved": True},
        )
        assert client.get(endpoint + "/tracks").json()["total"] == 2
        literal = create_playlist(client, "literal", {"all": [{"contains": {"title": "%_"}}]})
        assert literal["track_count"] == 1
        injection = create_playlist(
            client, "injection", {"all": [{"contains": {"title": "' OR 1=1 --"}}]}
        )
        assert injection["track_count"] == 0
        dates = create_playlist(
            client,
            "最近入库",
            {"all": [{"inTheLast": {"dateAdded": 1}}, {"gt": {"playCount": -1}}]},
        )
        assert dates["track_count"] == 3
        absent = create_playlist(
            client, "从未播放", {"all": [{"notInTheLast": {"lastPlayed": 30}}]}
        )
        assert absent["track_count"] == 3


def test_rule_validation_and_playlist_library_authorization(
    settings, authenticated_client, tmp_path
):
    music(settings, "歌.flac", ["歌手"], ["歌手"])
    scan_library(settings)
    invalid = [
        {"all": []},
        {"all": [{"is": {"loved": "true"}}]},
        {"all": [{"gt": {"duration": "10"}}]},
        {"all": [{"is": {"unknown": "x"}}]},
        {"all": [{"is": {"title);DROP TABLE tracks;--": "x"}}]},
        {"all": [{"inTheRange": {"duration": [10, 1]}}]},
        {"all": [{"inTheLast": {"lastPlayed": 0}}]},
        {"all": [{"is": {"title": "x"}}], "limit": 5001},
        {"all": [{"is": {"title": "x"}}], "sort": "title;DROP TABLE tracks;"},
        {"all": [{"is": {"title": "x"}}], "unknown": True},
    ]
    deep = {"is": {"loved": True}}
    for _ in range(7):
        deep = {"any": [deep]}
    invalid.append({"all": [deep]})
    with authenticated_client(settings) as client:
        for definition in invalid:
            assert (
                client.post(
                    "/api/v1/playlists",
                    headers=HEADERS,
                    json={"name": "bad", "kind": "smart", "definition": definition},
                ).status_code
                == 422
            )
        playlist = create_playlist(client)
        track_id = next(iter(get_tracks(client).values()))["id"]
        root = tmp_path / "isolated"
        root.mkdir()
        separate = settings.model_copy(update={"library_dir": root})
        with authenticated_client(separate) as other:
            assert other.get("/api/v1/playlists/" + playlist["id"]).status_code == 404
            assert (
                other.put(
                    f"/api/v1/tracks/{track_id}/favorite", headers=HEADERS, json={"loved": True}
                ).status_code
                == 404
            )
            assert (
                other.post(
                    "/api/v1/listening",
                    headers=HEADERS,
                    json={"session_id": str(uuid4()), "track_id": track_id, "listened_ms": 0},
                ).status_code
                == 404
            )
    with TestClient(create_app(settings)) as anonymous:
        for path in (
            "/api/v1/artists",
            "/api/v1/playlists",
            "/api/v1/listening/summary",
            "/api/v1/favorites/ids",
        ):
            assert anonymous.get(path).status_code == 401
        assert (
            anonymous.post("/api/v1/playlists", headers=HEADERS, json={"name": "x"}).status_code
            == 401
        )


def test_listening_deduplicates_retries_counts_once_and_caps_wall_time(
    settings, authenticated_client, monkeypatch
):
    music(settings, "one.flac", ["乐队"], ["乐队"])
    music(settings, "two.flac", ["乐队"], ["乐队"])
    scan_library(settings)
    clock = [1000.0]
    monkeypatch.setattr("wildstring.library.listening.time", SimpleNamespace(time=lambda: clock[0]))
    database = Database(settings.data_dir)
    with database.connect(write=True) as connection:
        connection.execute("UPDATE tracks SET duration_ms = 300000")
    with authenticated_client(settings) as client:
        tracks = list(get_tracks(client).values())
        session = str(uuid4())

        def report(value, sid=session, track_id=tracks[0]["id"]):
            return client.post(
                "/api/v1/listening",
                headers=HEADERS,
                json={"session_id": sid, "track_id": track_id, "listened_ms": value},
            )

        assert report(0).json()["play_count"] == 0
        assert report(900000).json()["accepted_ms"] <= 1000
        clock[0] += 5
        first = report(5000).json()
        assert first["listened_ms"] == 5000 and first["play_count"] == 0
        assert report(5000).json()["listened_ms"] == 5000
        assert report(2000).json()["listened_ms"] == 5000
        clock[0] += 150
        assert report(150000).json()["play_count"] == 1
        assert report(150000).json()["play_count"] == 1
        assert report(150000, track_id=tracks[1]["id"]).status_code == 409
        clock[0] += 10
        assert report(160000).json()["listened_ms"] == 160000
        record = client.get("/api/v1/tracks/" + tracks[0]["id"]).json()
        assert (
            record["play_count"] == 1
            and record["listened_ms"] == 160000
            and record["last_played_at"]
        )
        summary = client.get("/api/v1/listening/summary").json()
        assert (summary["play_count"], summary["listened_ms"], summary["tracks_played"]) == (
            1,
            160000,
            1,
        )
        playlist = create_playlist(
            client,
            "常听",
            {
                "all": [{"gt": {"playCount": 0}}, {"gt": {"listened": 100}}],
                "sort": "playCount",
                "order": "desc",
            },
        )
        assert playlist["track_count"] == 1
        played = client.get("/api/v1/tracks?played_only=true&sort=play_count").json()
        assert played["total"] == 1 and played["items"][0]["id"] == tracks[0]["id"]
        assert client.get("/api/v1/tracks?sort=unsafe").status_code == 422


def test_v4_upgrade_preserves_track_identity_and_seeds_one_default(settings, authenticated_client):
    database = Database(settings.data_dir)
    settings.data_dir.mkdir()
    with database.connect(write=True) as connection:
        connection.executescript(SCHEMA)
        connection.executescript(AUTH_SCHEMA)
        connection.execute("ALTER TABLE tracks ADD COLUMN album_id TEXT NOT NULL DEFAULT ''")
        connection.commit()
        connection.executescript(IMPORT_SCHEMA)
        connection.execute(
            "INSERT INTO libraries VALUES (?,?)", ("library", str(settings.library_dir))
        )
        connection.execute(
            "INSERT INTO scan_runs VALUES ('scan','library','completed','2026-10-01T00:00:00+00:00',NULL,'{}')"
        )
        connection.execute(
            "INSERT INTO tracks VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                "stable-track",
                "library",
                "old.flac",
                "旧曲",
                "tag",
                '["乐队"]',
                "旧专辑",
                '["乐队"]',
                1,
                1,
                10000,
                "flac",
                44100,
                2,
                0,
                100,
                1,
                "available",
                "scan",
                "旧曲 乐队",
                "album",
            ),
        )
    database.initialize()
    with authenticated_client(settings) as client:
        track = client.get("/api/v1/tracks/stable-track").json()
        assert (
            track["id"] == "stable-track" and track["loved"] is False and track["play_count"] == 0
        )
        assert track["added_at"] == "2026-10-01T00:00:00+00:00"
        assert client.get("/api/v1/artists").json()["items"][0]["name"] == "乐队"
        assert client.get("/api/v1/playlists").json()["total"] == 1
    with authenticated_client(settings) as client:
        assert client.get("/api/v1/playlists").json()["total"] == 1
