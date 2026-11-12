"""Unit and integration tests for podcast episode favorites and audio retention protection."""

import pytest
from fastapi.testclient import TestClient
from test_podcast_publishers import seed

from wildstring.database import SCHEMA_VERSION, Database
from wildstring.podcast_identity_backfill import IdentityBackfill

HEADERS = {"X-Wildstring-Client": "web"}


@pytest.fixture
def favorites_setup(settings, authenticated_client):
    with authenticated_client(settings) as client:
        db = Database(settings.data_dir)
        seed(db)
        manager = client.app.state.podcasts
        manager.queue_download_episode = lambda identity: True
        audio_path = settings.podcasts_dir / "protected_ep.mp3"
        audio_path.write_bytes(b"podcast audio payload")

        # Create secondary listener account
        created = client.post(
            "/api/v1/manage/users",
            headers=HEADERS,
            json={
                "username": "fav-listener",
                "password": "fav-listener-password",
                "library_ids": [],
            },
        ).json()
        listener_id = created["id"]
        with db.connect(write=True) as conn:
            conn.execute("INSERT INTO podcast_user_catalog VALUES (?,?)", (listener_id, "east"))
            conn.execute("INSERT INTO podcast_user_catalog VALUES (?,?)", (listener_id, "coffee"))

        listener = TestClient(client.app)
        res = listener.post(
            "/api/v1/auth/login",
            headers=HEADERS,
            json={"username": "fav-listener", "password": "fav-listener-password"},
        )
        assert res.status_code == 200

        try:
            yield client, listener, manager, db, audio_path, listener_id
        finally:
            listener.close()


def test_schema52_version_and_cascade(settings):
    db = Database(settings.data_dir)
    db.initialize()
    with db.connect() as conn:
        assert conn.execute("PRAGMA user_version").fetchone()[0] == 52
        assert conn.execute("PRAGMA user_version").fetchone()[0] == SCHEMA_VERSION
        # Check table structure
        columns = {row[1] for row in conn.execute("PRAGMA table_info(podcast_episode_favorites)")}
        assert {"user_id", "episode_id", "created_at"}.issubset(columns)

    # Verify foreign key cascade on episode deletion
    with db.connect(write=True) as conn:
        conn.execute(
            "INSERT INTO podcasts(id,title,feed_url,created_at) VALUES ('p1','p1','https://ex.com/p1.rss','2026-01-01')"
        )
        conn.execute(
            "INSERT INTO podcast_episodes(id,podcast_id,guid,title,audio_url,created_at) VALUES ('e1','p1','g1','t1','https://ex.com/e1.mp3','2026-01-01')"
        )
        conn.execute(
            "INSERT INTO podcast_episode_favorites(user_id,episode_id,created_at) VALUES ('admin','e1','2026-01-01')"
        )
        assert conn.execute("SELECT count(*) FROM podcast_episode_favorites").fetchone()[0] == 1
        # Delete episode cascades to favorites
        conn.execute("DELETE FROM podcast_episodes WHERE id='e1'")
        assert conn.execute("SELECT count(*) FROM podcast_episode_favorites").fetchone()[0] == 0


def test_favorite_toggle_put_and_enrichment(favorites_setup):
    owner, listener, manager, db, _, _ = favorites_setup

    # Initial state: not favorited
    ep_res = owner.get("/api/v1/podcasts/episodes/ep-east")
    assert ep_res.status_code == 200
    assert ep_res.json()["favorite"] is False
    assert ep_res.json()["loved"] is False

    # Favorite with {"favorite": True}
    res = owner.put(
        "/api/v1/podcasts/episodes/ep-east/favorite", headers=HEADERS, json={"favorite": True}
    )
    assert res.status_code == 200
    assert res.json() == {"episode_id": "ep-east", "favorite": True, "loved": True}

    # Verify episode detail reflects favorite
    ep_res = owner.get("/api/v1/podcasts/episodes/ep-east")
    assert ep_res.json()["favorite"] is True
    assert ep_res.json()["loved"] is True

    # Verify podcast detail reflects favorite on episode
    show_res = owner.get("/api/v1/podcasts/east")
    assert show_res.status_code == 200
    matched = next(ep for ep in show_res.json()["episodes"] if ep["id"] == "ep-east")
    assert matched["favorite"] is True
    assert matched["loved"] is True

    # Verify listener does NOT see owner's favorite
    listener_ep = listener.get("/api/v1/podcasts/episodes/ep-east")
    assert listener_ep.json()["favorite"] is False
    assert listener_ep.json()["loved"] is False

    # Unfavorite with {"loved": False}
    unfav_res = owner.put(
        "/api/v1/podcasts/episodes/ep-east/favorite", headers=HEADERS, json={"loved": False}
    )
    assert unfav_res.status_code == 200
    assert unfav_res.json() == {"episode_id": "ep-east", "favorite": False, "loved": False}

    # Verify unfavorited state
    ep_res = owner.get("/api/v1/podcasts/episodes/ep-east")
    assert ep_res.json()["favorite"] is False
    assert ep_res.json()["loved"] is False

    # Favorite without explicit body (defaults to True)
    default_fav = owner.put("/api/v1/podcasts/episodes/ep-east/favorite", headers=HEADERS)
    assert default_fav.status_code == 200
    assert default_fav.json()["favorite"] is True

    # 404 for non-existent episode
    err = owner.put(
        "/api/v1/podcasts/episodes/non-existent/favorite", headers=HEADERS, json={"favorite": True}
    )
    assert err.status_code == 404


def test_favorites_ids_and_list_endpoints(favorites_setup):
    owner, listener, manager, db, _, _ = favorites_setup

    # Empty initially
    assert owner.get("/api/v1/podcasts/favorites/ids").json() == {"ids": []}
    assert owner.get("/api/v1/podcasts/favorites").json() == []

    # Favorite ep-east, then ep-coffee
    owner.put(
        "/api/v1/podcasts/episodes/ep-east/favorite", headers=HEADERS, json={"favorite": True}
    )
    owner.put(
        "/api/v1/podcasts/episodes/ep-coffee/favorite", headers=HEADERS, json={"favorite": True}
    )

    # IDs returned in reverse chronological order
    ids_res = owner.get("/api/v1/podcasts/favorites/ids").json()
    assert ids_res["ids"] == ["ep-coffee", "ep-east"]

    # Full list returned with show metadata and favorite flags
    favs_res = owner.get("/api/v1/podcasts/favorites")
    assert favs_res.status_code == 200
    items = favs_res.json()
    assert len(items) == 2
    assert items[0]["id"] == "ep-coffee"
    assert items[0]["podcast_title"] == "coffee"
    assert items[0]["author"] == "声动活泼"
    assert items[0]["favorite"] is True
    assert items[0]["loved"] is True
    assert "favorited_at" in items[0]

    assert items[1]["id"] == "ep-east"
    assert items[1]["podcast_title"] == "east"
    assert items[1]["author"] == "ETW Studio"
    assert items[1]["favorite"] is True

    # Listener still has separate empty favorites
    assert listener.get("/api/v1/podcasts/favorites/ids").json() == {"ids": []}
    assert listener.get("/api/v1/podcasts/favorites").json() == []

    # Listener favorites ep-east
    listener.put(
        "/api/v1/podcasts/episodes/ep-east/favorite", headers=HEADERS, json={"favorite": True}
    )
    assert listener.get("/api/v1/podcasts/favorites/ids").json() == {"ids": ["ep-east"]}


def test_audio_cleanup_retention_protection_guard(favorites_setup):
    owner, listener, manager, db, audio_path, _ = favorites_setup
    store = manager.resources

    # Associate audio file with ep-east as downloaded
    with db.connect(write=True) as conn:
        conn.execute(
            "UPDATE podcast_episodes SET local_path=?,download_status='downloaded' WHERE id='ep-east'",
            (str(audio_path),),
        )
        store.downloaded(conn, "ep-east")

    # Confirm neither user has personal save
    with db.connect() as conn:
        assert (
            conn.execute(
                "SELECT count(*) FROM podcast_resource_refs WHERE episode_id='ep-east'"
            ).fetchone()[0]
            == 0
        )

    # Before favorite: zero_since has started ticking, eligible for cleanup
    preview_unprotected = store.cleanup()
    assert preview_unprotected["candidate_count"] == 1
    assert preview_unprotected["candidates"][0]["id"] == "ep-east"

    # User A (owner) favorites ep-east
    owner.put(
        "/api/v1/podcasts/episodes/ep-east/favorite", headers=HEADERS, json={"favorite": True}
    )

    # zero_since must be reset to NULL
    with db.connect() as conn:
        zero_since = conn.execute(
            "SELECT zero_since FROM podcast_resource_state WHERE episode_id='ep-east'"
        ).fetchone()[0]
        assert zero_since is None

    # Audio cleanup guard: cleanup preview must skip ep-east because favorite_count > 0!
    preview_protected = store.cleanup()
    assert preview_protected["candidate_count"] == 0
    assert preview_protected["candidates"] == []

    # Automatic cleanup must not delete it
    auto_res = store.cleanup(dry_run=False, automatic=True)
    assert auto_res["deleted_count"] == 0
    assert audio_path.is_file()

    # Manual cleanup must not delete it either
    manual_res = store.cleanup(dry_run=False, automatic=False)
    assert manual_res["deleted_count"] == 0
    assert audio_path.is_file()

    # User B (listener) also favorites ep-east
    listener.put(
        "/api/v1/podcasts/episodes/ep-east/favorite", headers=HEADERS, json={"favorite": True}
    )

    # User A unfavorites ep-east, but User B still has it favorited!
    owner.put(
        "/api/v1/podcasts/episodes/ep-east/favorite", headers=HEADERS, json={"favorite": False}
    )

    # Cleanup must still NOT delete audio because User B still favorites it
    assert store.cleanup()["candidate_count"] == 0
    assert store.cleanup(dry_run=False)["deleted_count"] == 0
    assert audio_path.is_file()

    # User B unfavorites ep-east
    listener.put(
        "/api/v1/podcasts/episodes/ep-east/favorite", headers=HEADERS, json={"favorite": False}
    )

    # Now with 0 favorites and 0 saves, it is eligible for cleanup!
    preview_final = store.cleanup()
    assert preview_final["candidate_count"] == 1
    assert preview_final["candidates"][0]["id"] == "ep-east"

    # Executing cleanup unlinks the audio file
    clean_res = store.cleanup(dry_run=False)
    assert clean_res["deleted_count"] == 1
    assert not audio_path.exists()


def test_episode_merge_migrates_favorites(favorites_setup):
    owner, _, manager, db, _, _ = favorites_setup

    with db.connect(write=True) as conn:
        conn.execute(
            "INSERT INTO podcast_episodes(id,podcast_id,guid,title,audio_url,created_at) "
            "VALUES ('ep-old','east','guid-old','Title Old','https://ex.com/old.mp3','2026-10-01')"
        )
        conn.execute(
            "INSERT INTO podcast_episodes(id,podcast_id,guid,title,audio_url,created_at) "
            "VALUES ('ep-target','east','guid-target','Title Target','https://ex.com/new.mp3','2026-10-01')"
        )

    # Favorite ep-old
    owner.put("/api/v1/podcasts/episodes/ep-old/favorite", headers=HEADERS, json={"favorite": True})

    with db.connect() as conn:
        assert (
            conn.execute(
                "SELECT count(*) FROM podcast_episode_favorites WHERE episode_id='ep-old'"
            ).fetchone()[0]
            == 1
        )
        assert (
            conn.execute(
                "SELECT count(*) FROM podcast_episode_favorites WHERE episode_id='ep-target'"
            ).fetchone()[0]
            == 0
        )

    # Merge ep-old into ep-target
    stats = {"progress_moved": 0, "progress_replaced": 0, "downloads_moved": 0}
    orphans = []
    with db.connect(write=True) as conn:
        old_row = {"id": "ep-old", "local_path": None, "download_status": "none"}
        target_row = {"id": "ep-target", "local_path": None, "download_status": "none"}
        IdentityBackfill._merge_episode(conn, old_row, target_row, stats, orphans)

    # ep-target should now be favorited
    with db.connect() as conn:
        assert (
            conn.execute(
                "SELECT count(*) FROM podcast_episode_favorites WHERE episode_id='ep-target'"
            ).fetchone()[0]
            == 1
        )
