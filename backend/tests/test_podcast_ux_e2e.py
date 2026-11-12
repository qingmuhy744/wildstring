"""End-to-End & Integration Test Suite for WildString Podcast UX & Episode Favoriting.

Covers:
- Tier 1: Unified pending queue & 3-option delivery actions (ignore, queue_last, queue_next),
  episode completion progress toggling, episode favoriting API, audio cleanup retention guard.
- Tier 2: Boundary conditions (favoriting non-existent episode, unauthorized catalog access,
  toggle idempotency, empty queue operations, multiple users favoriting the same episode).
- Tier 3: Cross-feature interactions (episode favorited and queued; episode completed and
  favorited; unplayed count updates).
- Tier 4: Full lifecycle scenario (user favorites episode, download occurs, references dropped,
  cleanup runs -> file is strictly preserved; user unfavorites -> file becomes eligible for cleanup).
"""

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from wildstring.database import Database
from wildstring.podcast_queue import distribute_new_episodes

HEADERS = {"X-Wildstring-Client": "web"}
SHOW_ID = "show-e2e-ux"
SHOW_TITLE = "UX Test Show"
SHOW_AUTHOR = "UX Creator"
SHOW_FEED = "https://example.test/show-ux.xml"


@pytest.fixture
def e2e_context(settings, authenticated_client):
    """Provides owner (admin) client, listener client, database, and podcast manager."""
    with authenticated_client(settings) as owner_client:
        database = Database(settings.data_dir)
        manager = owner_client.app.state.podcasts

        # Ensure test show exists
        with database.connect(write=True) as conn:
            conn.execute(
                """INSERT OR IGNORE INTO podcasts
                   (id, title, author, description, feed_url, auto_update, download_policy, created_at)
                   VALUES (?,?,?,?,?,0,'none','2026-01-01')""",
                (SHOW_ID, SHOW_TITLE, SHOW_AUTHOR, "Show Description", SHOW_FEED),
            )
            owner_row = conn.execute("SELECT id FROM users WHERE username='admin'").fetchone()
            owner_id = owner_row[0] if owner_row else "admin"
            conn.execute(
                "INSERT OR IGNORE INTO podcast_user_catalog(user_id, podcast_id) VALUES (?,?)",
                (owner_id, SHOW_ID),
            )

        # Create secondary listener user via admin API
        create_user_resp = owner_client.post(
            "/api/v1/manage/users",
            headers=HEADERS,
            json={
                "username": "listener",
                "password": "test-listener-password",
                "library_ids": [],
            },
        )
        assert create_user_resp.status_code == 201, create_user_resp.text
        listener_info = create_user_resp.json()
        listener_id = listener_info["id"]

        with database.connect(write=True) as conn:
            conn.execute(
                "INSERT OR IGNORE INTO podcast_user_catalog(user_id, podcast_id) VALUES (?,?)",
                (listener_id, SHOW_ID),
            )

        # Login secondary listener client
        listener_client = TestClient(owner_client.app)
        login_resp = listener_client.post(
            "/api/v1/auth/login",
            headers=HEADERS,
            json={"username": "listener", "password": "test-listener-password"},
        )
        assert login_resp.status_code == 200, login_resp.text

        # Helper to create episodes
        def add_episode(
            ep_id: str,
            title: str | None = None,
            duration: int = 3600,
            pub_date: str = "2026-01-01",
            audio_bytes: bytes | None = None,
            show_id: str = SHOW_ID,
        ) -> Path | None:
            audio_path = None
            if audio_bytes is not None:
                audio_path = settings.podcasts_dir / f"{ep_id}.mp3"
                audio_path.write_bytes(audio_bytes)

            with database.connect(write=True) as conn:
                conn.execute(
                    """INSERT OR IGNORE INTO podcast_episodes
                       (id, podcast_id, guid, title, audio_url, duration_seconds, pub_date, created_at, local_path, download_status)
                       VALUES (?,?,?,?,?,?,?,?,?,?)""",
                    (
                        ep_id,
                        show_id,
                        f"guid-{ep_id}",
                        title or ep_id,
                        f"https://example.test/{ep_id}.mp3",
                        duration,
                        pub_date,
                        pub_date,
                        str(audio_path) if audio_path else None,
                        "downloaded" if audio_path else "none",
                    ),
                )
                if audio_path:
                    manager.resources.downloaded(conn, ep_id)
            return audio_path

        def set_preference(
            client: TestClient, action: str, auto_limit: int = 3, show_id: str = SHOW_ID
        ):
            response = client.put(
                "/api/v1/podcasts/queue/preferences",
                headers=HEADERS,
                json={
                    "default_action": "queue_last",
                    "auto_limit": auto_limit,
                    "shows": {
                        show_id: {
                            "action": action,
                            "auto_limit": auto_limit,
                            "order": "follow",
                            "skip_completed": True,
                            "auto_continue": True,
                        }
                    },
                },
            )
            assert response.status_code == 200, response.text

        def deliver(ep_ids: list[str], show_id: str = SHOW_ID):
            with database.connect(write=True) as conn:
                return distribute_new_episodes(conn, show_id, ep_ids)

        def follow_show(client: TestClient, show_id: str = SHOW_ID):
            return client.put(
                f"/api/v1/podcasts/{show_id}/follow", headers=HEADERS, json={"followed": True}
            )

        try:
            yield {
                "owner": owner_client,
                "listener": listener_client,
                "owner_id": owner_id,
                "listener_id": listener_id,
                "database": database,
                "manager": manager,
                "settings": settings,
                "add_episode": add_episode,
                "set_preference": set_preference,
                "deliver": deliver,
                "follow_show": follow_show,
            }
        finally:
            listener_client.close()


# ==============================================================================
# Tier 1: Core Functionality Tests
# ==============================================================================


def test_tier1_queue_delivery_action_queue_last(e2e_context):
    """Verify 'queue_last' appends new episodes to the end of the pending queue."""
    client = e2e_context["owner"]
    e2e_context["follow_show"](client)
    e2e_context["set_preference"](client, "queue_last")

    # Seed 2 historical episodes first
    e2e_context["add_episode"]("ep-base-1")
    e2e_context["add_episode"]("ep-base-2")

    # Deliver first new episode
    e2e_context["add_episode"]("ep-qlast-1")
    e2e_context["deliver"](["ep-qlast-1"])

    queue_resp = client.get("/api/v1/podcasts/queue", headers=HEADERS)
    assert queue_resp.status_code == 200
    items = queue_resp.json()["items"]
    assert [item["episode_id"] for item in items] == ["ep-qlast-1"]

    # Deliver second new episode -> appended to tail
    e2e_context["add_episode"]("ep-qlast-2")
    e2e_context["deliver"](["ep-qlast-2"])

    queue_resp2 = client.get("/api/v1/podcasts/queue", headers=HEADERS)
    items2 = queue_resp2.json()["items"]
    assert [item["episode_id"] for item in items2] == ["ep-qlast-1", "ep-qlast-2"]

    assert queue_resp2.json()["notice"] == ""


def test_tier1_queue_delivery_action_queue_next(e2e_context):
    """Verify 'queue_next' places the newest episode at the front of the queue."""
    client = e2e_context["owner"]
    e2e_context["follow_show"](client)

    # Establish an existing queue with ep-1 and ep-2
    e2e_context["add_episode"]("ep-qexist-1")
    e2e_context["add_episode"]("ep-qexist-2")
    current_q = client.get("/api/v1/podcasts/queue", headers=HEADERS).json()
    put_resp = client.put(
        "/api/v1/podcasts/queue",
        headers=HEADERS,
        json={
            "version": current_q["version"],
            "device_id": "test-dev",
            "items": [
                {"episode_id": "ep-qexist-1", "origin": "manual"},
                {"episode_id": "ep-qexist-2", "origin": "manual"},
            ],
        },
    )
    assert put_resp.status_code == 200

    # Set delivery preference to queue_next
    e2e_context["set_preference"](client, "queue_next")

    e2e_context["add_episode"]("ep-qnext-1")
    e2e_context["deliver"](["ep-qnext-1"])

    queue_resp = client.get("/api/v1/podcasts/queue", headers=HEADERS).json()
    assert [item["episode_id"] for item in queue_resp["items"]] == [
        "ep-qnext-1",
        "ep-qexist-1",
        "ep-qexist-2",
    ]

    e2e_context["add_episode"]("ep-qnext-2")
    e2e_context["deliver"](["ep-qnext-2"])

    queue_resp2 = client.get("/api/v1/podcasts/queue", headers=HEADERS).json()
    assert [item["episode_id"] for item in queue_resp2["items"]] == [
        "ep-qnext-2",
        "ep-qnext-1",
        "ep-qexist-1",
        "ep-qexist-2",
    ]


def test_tier1_queue_delivery_action_ignore(e2e_context):
    """Verify 'ignore' leaves the queue unchanged."""
    client = e2e_context["owner"]
    e2e_context["follow_show"](client)
    e2e_context["set_preference"](client, "ignore")

    e2e_context["add_episode"]("ep-ignore-1")
    assert e2e_context["deliver"](["ep-ignore-1"]) == 0

    assert client.get("/api/v1/podcasts/queue", headers=HEADERS).json()["items"] == []

    # Episode is still accessible in podcast details
    show_detail = client.get(f"/api/v1/podcasts/{SHOW_ID}", headers=HEADERS).json()
    ep_ids = [ep["id"] for ep in show_detail["episodes"]]
    assert "ep-ignore-1" in ep_ids


def test_tier1_queue_delivery_rejects_legacy_inbox_action(e2e_context):
    client = e2e_context["owner"]
    e2e_context["follow_show"](client)
    response = client.put(
        "/api/v1/podcasts/queue/preferences",
        headers=HEADERS,
        json={
            "default_action": "inbox",
            "auto_limit": 3,
            "shows": {},
        },
    )
    assert response.status_code == 422


def test_tier1_episode_completion_progress_toggle(e2e_context):
    """Verify marking episode as completed ('标为已听完') and unplayed ('标为未听')."""
    client = e2e_context["owner"]
    e2e_context["add_episode"]("ep-toggle-compl", duration=1800)

    # Initial state
    show = client.get(f"/api/v1/podcasts/{SHOW_ID}", headers=HEADERS).json()
    ep = next(e for e in show["episodes"] if e["id"] == "ep-toggle-compl")
    assert ep["completed"] is False
    assert ep["position_seconds"] == 0

    # 1. Mark completed (event="ended", position_seconds=duration)
    end_resp = client.put(
        "/api/v1/podcasts/episodes/ep-toggle-compl/progress",
        headers=HEADERS,
        json={
            "session_id": "session-device-e2e-1",
            "device_id": "dev-web",
            "base_version": 0,
            "sequence": 1,
            "position_seconds": 1800,
            "duration_seconds": 1800,
            "event": "ended",
        },
    )
    assert end_resp.status_code == 200, end_resp.text
    progress_state = end_resp.json()
    assert progress_state["completed"] is True

    # Verify reflected in show detail
    show_after_end = client.get(f"/api/v1/podcasts/{SHOW_ID}", headers=HEADERS).json()
    ep_after_end = next(e for e in show_after_end["episodes"] if e["id"] == "ep-toggle-compl")
    assert ep_after_end["completed"] is True

    # 2. Mark unplayed (event="stop", position_seconds=0)
    stop_resp = client.put(
        "/api/v1/podcasts/episodes/ep-toggle-compl/progress",
        headers=HEADERS,
        json={
            "session_id": "session-device-e2e-1",
            "device_id": "dev-web",
            "base_version": progress_state["version"],
            "sequence": 2,
            "position_seconds": 0,
            "duration_seconds": 1800,
            "event": "stop",
        },
    )
    assert stop_resp.status_code == 200, stop_resp.text
    assert stop_resp.json()["completed"] is False
    assert stop_resp.json()["position_seconds"] == 0

    show_after_stop = client.get(f"/api/v1/podcasts/{SHOW_ID}", headers=HEADERS).json()
    ep_after_stop = next(e for e in show_after_stop["episodes"] if e["id"] == "ep-toggle-compl")
    assert ep_after_stop["completed"] is False
    assert ep_after_stop["position_seconds"] == 0


def test_tier1_episode_favorite_api_crud(e2e_context):
    """Verify PUT /favorite, GET /favorites/ids, GET /favorites, and PodcastEpisodeResponse enrichment."""
    client = e2e_context["owner"]
    e2e_context["add_episode"]("ep-fav-crud", title="CRUD Episode")

    # Initial: not favorited
    initial_ids = client.get("/api/v1/podcasts/favorites/ids", headers=HEADERS)
    assert initial_ids.status_code == 200
    assert "ep-fav-crud" not in initial_ids.json().get("ids", [])

    # 1. Favorite via {"favorite": True}
    fav_resp = client.put(
        "/api/v1/podcasts/episodes/ep-fav-crud/favorite",
        headers=HEADERS,
        json={"favorite": True},
    )
    assert fav_resp.status_code == 200, fav_resp.text
    fav_data = fav_resp.json()
    assert fav_data["episode_id"] == "ep-fav-crud"
    assert fav_data["favorite"] is True
    assert fav_data.get("loved") is True

    # 2. Check /favorites/ids
    ids_resp = client.get("/api/v1/podcasts/favorites/ids", headers=HEADERS)
    assert ids_resp.status_code == 200
    assert "ep-fav-crud" in ids_resp.json()["ids"]

    # 3. Check /favorites list
    favs_resp = client.get("/api/v1/podcasts/favorites", headers=HEADERS)
    assert favs_resp.status_code == 200
    fav_items = favs_resp.json()
    if isinstance(fav_items, dict) and "items" in fav_items:
        fav_items = fav_items["items"]
    assert any(item["id"] == "ep-fav-crud" for item in fav_items)
    matched_fav = next(item for item in fav_items if item["id"] == "ep-fav-crud")
    assert matched_fav["podcast_id"] == SHOW_ID
    assert matched_fav["podcast_title"] == SHOW_TITLE
    assert matched_fav.get("favorite") is True or matched_fav.get("loved") is True

    # 4. Check show detail and episode detail enrichment
    show_detail = client.get(f"/api/v1/podcasts/{SHOW_ID}", headers=HEADERS).json()
    matched_ep = next(e for e in show_detail["episodes"] if e["id"] == "ep-fav-crud")
    assert matched_ep.get("favorite") is True or matched_ep.get("loved") is True

    ep_detail = client.get("/api/v1/podcasts/episodes/ep-fav-crud", headers=HEADERS).json()
    assert ep_detail.get("favorite") is True or ep_detail.get("loved") is True

    # 5. Unfavorite via {"favorite": False}
    unfav_resp = client.put(
        "/api/v1/podcasts/episodes/ep-fav-crud/favorite",
        headers=HEADERS,
        json={"favorite": False},
    )
    assert unfav_resp.status_code == 200, unfav_resp.text
    assert unfav_resp.json()["favorite"] is False

    # Check /favorites/ids no longer contains it
    ids_after = client.get("/api/v1/podcasts/favorites/ids", headers=HEADERS).json()["ids"]
    assert "ep-fav-crud" not in ids_after


def test_tier1_audio_cleanup_retention_guard_direct(e2e_context):
    """Verify audio file is preserved during cleanup if favorited with 0 download references."""
    client = e2e_context["owner"]
    manager = e2e_context["manager"]
    path = e2e_context["add_episode"]("ep-cleanup-guard", audio_bytes=b"guarded audio content")
    assert path.is_file()

    # Favorite the episode
    fav_resp = client.put(
        "/api/v1/podcasts/episodes/ep-cleanup-guard/favorite",
        headers=HEADERS,
        json={"favorite": True},
    )
    assert fav_resp.status_code == 200

    # Ensure zero resource download references exist
    with e2e_context["database"].connect() as conn:
        refs_count = conn.execute(
            "SELECT count(*) FROM podcast_resource_refs WHERE episode_id='ep-cleanup-guard'"
        ).fetchone()[0]
        assert refs_count == 0

    # Execute cleanup (not dry run)
    cleanup_result = manager.resources.cleanup(dry_run=False)
    assert cleanup_result["deleted_count"] == 0

    # File MUST be strictly preserved
    assert path.exists()


# ==============================================================================
# Tier 2: Boundary Conditions & Edge Cases
# ==============================================================================


def test_tier2_favorite_non_existent_episode(e2e_context):
    """Favoriting a non-existent episode must return 404 or 422, not 500."""
    client = e2e_context["owner"]
    resp = client.put(
        "/api/v1/podcasts/episodes/ep-does-not-exist/favorite",
        headers=HEADERS,
        json={"favorite": True},
    )
    assert resp.status_code in (404, 422)


def test_tier2_favorite_unauthorized_catalog_episode(e2e_context):
    """A user cannot favorite an episode from a show outside their catalog."""
    listener = e2e_context["listener"]
    database = e2e_context["database"]

    # Create a secret show accessible ONLY to admin
    with database.connect(write=True) as conn:
        conn.execute(
            """INSERT OR IGNORE INTO podcasts(id, title, author, feed_url, auto_update, download_policy, created_at)
               VALUES ('show-secret', 'Secret', 'Secret Author', 'https://example.test/secret.xml', 0, 'none', '2026-01-01')"""
        )
        conn.execute(
            "INSERT OR IGNORE INTO podcast_user_catalog(user_id, podcast_id) VALUES (?, 'show-secret')",
            (e2e_context["owner_id"],),
        )

    e2e_context["add_episode"]("ep-secret-1", show_id="show-secret")

    # Listener tries to favorite the secret episode
    resp = listener.put(
        "/api/v1/podcasts/episodes/ep-secret-1/favorite",
        headers=HEADERS,
        json={"favorite": True},
    )
    assert resp.status_code in (403, 404)


def test_tier2_favorite_toggle_idempotency(e2e_context):
    """Favoriting or unfavoriting multiple times is idempotent with clean state."""
    client = e2e_context["owner"]
    database = e2e_context["database"]
    e2e_context["add_episode"]("ep-idemp")

    # 1. Favorite twice
    resp1 = client.put(
        "/api/v1/podcasts/episodes/ep-idemp/favorite", headers=HEADERS, json={"favorite": True}
    )
    assert resp1.status_code == 200
    resp2 = client.put(
        "/api/v1/podcasts/episodes/ep-idemp/favorite", headers=HEADERS, json={"favorite": True}
    )
    assert resp2.status_code == 200

    with database.connect() as conn:
        rows = conn.execute(
            "SELECT count(*) FROM podcast_episode_favorites WHERE episode_id='ep-idemp'"
        ).fetchone()[0]
        assert rows == 1

    # 2. Unfavorite twice
    resp3 = client.put(
        "/api/v1/podcasts/episodes/ep-idemp/favorite", headers=HEADERS, json={"favorite": False}
    )
    assert resp3.status_code == 200
    resp4 = client.put(
        "/api/v1/podcasts/episodes/ep-idemp/favorite", headers=HEADERS, json={"favorite": False}
    )
    assert resp4.status_code == 200

    with database.connect() as conn:
        rows = conn.execute(
            "SELECT count(*) FROM podcast_episode_favorites WHERE episode_id='ep-idemp'"
        ).fetchone()[0]
        assert rows == 0


def test_tier2_empty_queue_operations(e2e_context):
    """Verify empty queue queries, CAS empty updates, and delivery into empty queue."""
    client = e2e_context["owner"]
    q = client.get("/api/v1/podcasts/queue", headers=HEADERS).json()
    assert "version" in q
    assert q["items"] == []

    # CAS replace with empty items
    cas_resp = client.put(
        "/api/v1/podcasts/queue",
        headers=HEADERS,
        json={"version": q["version"], "device_id": "test-dev", "items": []},
    )
    assert cas_resp.status_code == 200
    assert cas_resp.json()["version"] == q["version"] + 1

    # Deliver queue_next into empty queue
    e2e_context["follow_show"](client)
    e2e_context["set_preference"](client, "queue_next")
    e2e_context["add_episode"]("ep-empty-deliv")
    e2e_context["deliver"](["ep-empty-deliv"])

    items = client.get("/api/v1/podcasts/queue", headers=HEADERS).json()["items"]
    assert [item["episode_id"] for item in items] == ["ep-empty-deliv"]


def test_tier2_multi_user_favorite_isolation_and_retention(e2e_context):
    """User A and User B maintain isolated favorite states; cleanup protects if any user favorites."""
    owner = e2e_context["owner"]
    listener = e2e_context["listener"]
    manager = e2e_context["manager"]

    path = e2e_context["add_episode"]("ep-multi-user", audio_bytes=b"multi-user shared audio")
    assert path.is_file()

    # User A favorites
    owner.put(
        "/api/v1/podcasts/episodes/ep-multi-user/favorite", headers=HEADERS, json={"favorite": True}
    )

    # User A sees it in favorites, User B does NOT
    assert (
        "ep-multi-user"
        in owner.get("/api/v1/podcasts/favorites/ids", headers=HEADERS).json()["ids"]
    )
    assert (
        "ep-multi-user"
        not in listener.get("/api/v1/podcasts/favorites/ids", headers=HEADERS).json()["ids"]
    )

    # User B also favorites
    listener.put(
        "/api/v1/podcasts/episodes/ep-multi-user/favorite", headers=HEADERS, json={"favorite": True}
    )
    assert (
        "ep-multi-user"
        in listener.get("/api/v1/podcasts/favorites/ids", headers=HEADERS).json()["ids"]
    )

    # User A unfavorites
    owner.put(
        "/api/v1/podcasts/episodes/ep-multi-user/favorite",
        headers=HEADERS,
        json={"favorite": False},
    )
    assert (
        "ep-multi-user"
        not in owner.get("/api/v1/podcasts/favorites/ids", headers=HEADERS).json()["ids"]
    )
    assert (
        "ep-multi-user"
        in listener.get("/api/v1/podcasts/favorites/ids", headers=HEADERS).json()["ids"]
    )

    # Zero-reference cleanup: User B still favorites it -> file preserved
    cleanup_res = manager.resources.cleanup(dry_run=False)
    assert cleanup_res["deleted_count"] == 0
    assert path.exists()


# ==============================================================================
# Tier 3: Cross-Feature Interaction Tests
# ==============================================================================


def test_tier3_episode_favorited_and_queued(e2e_context):
    """An episode can be queued and favorited independently without state conflict."""
    client = e2e_context["owner"]
    e2e_context["add_episode"]("ep-cross-qfav")

    # Add to queue
    current_q = client.get("/api/v1/podcasts/queue", headers=HEADERS).json()
    client.put(
        "/api/v1/podcasts/queue",
        headers=HEADERS,
        json={
            "version": current_q["version"],
            "device_id": "test-dev",
            "items": [{"episode_id": "ep-cross-qfav", "origin": "manual"}],
        },
    )

    # Favorite it
    client.put(
        "/api/v1/podcasts/episodes/ep-cross-qfav/favorite", headers=HEADERS, json={"favorite": True}
    )

    # Verify present in both
    q_items = client.get("/api/v1/podcasts/queue", headers=HEADERS).json()["items"]
    assert any(i["episode_id"] == "ep-cross-qfav" for i in q_items)

    fav_ids = client.get("/api/v1/podcasts/favorites/ids", headers=HEADERS).json()["ids"]
    assert "ep-cross-qfav" in fav_ids

    # Remove from queue -> favorite status intact
    next_q = client.get("/api/v1/podcasts/queue", headers=HEADERS).json()
    client.put(
        "/api/v1/podcasts/queue",
        headers=HEADERS,
        json={"version": next_q["version"], "device_id": "test-dev", "items": []},
    )
    fav_ids_after = client.get("/api/v1/podcasts/favorites/ids", headers=HEADERS).json()["ids"]
    assert "ep-cross-qfav" in fav_ids_after


def test_tier3_episode_completed_and_favorited(e2e_context):
    """Episode completed status is correctly reflected in favorites view and details."""
    client = e2e_context["owner"]
    e2e_context["add_episode"]("ep-cross-compfav", duration=2400)

    # Mark completed
    client.put(
        "/api/v1/podcasts/episodes/ep-cross-compfav/progress",
        headers=HEADERS,
        json={
            "session_id": "session-device-e2e-2",
            "device_id": "dev-web",
            "base_version": 0,
            "sequence": 1,
            "position_seconds": 2400,
            "duration_seconds": 2400,
            "event": "ended",
        },
    )

    # Favorite it
    client.put(
        "/api/v1/podcasts/episodes/ep-cross-compfav/favorite",
        headers=HEADERS,
        json={"favorite": True},
    )

    # Verify in favorites list: completed is True
    favs_resp = client.get("/api/v1/podcasts/favorites", headers=HEADERS).json()
    if isinstance(favs_resp, dict) and "items" in favs_resp:
        favs_resp = favs_resp["items"]
    matched = next(item for item in favs_resp if item["id"] == "ep-cross-compfav")
    assert matched["completed"] is True
    assert matched.get("favorite") is True or matched.get("loved") is True

    # Mark unplayed
    client.put(
        "/api/v1/podcasts/episodes/ep-cross-compfav/progress",
        headers=HEADERS,
        json={
            "session_id": "session-device-e2e-2",
            "device_id": "dev-web",
            "base_version": 1,
            "sequence": 2,
            "position_seconds": 0,
            "duration_seconds": 2400,
            "event": "stop",
        },
    )

    # Verify in favorites list: completed is now False, favorite remains True
    favs_resp2 = client.get("/api/v1/podcasts/favorites", headers=HEADERS).json()
    if isinstance(favs_resp2, dict) and "items" in favs_resp2:
        favs_resp2 = favs_resp2["items"]
    matched2 = next(item for item in favs_resp2 if item["id"] == "ep-cross-compfav")
    assert matched2["completed"] is False
    assert matched2.get("favorite") is True or matched2.get("loved") is True


def test_tier3_unplayed_count_with_favoriting_and_completion(e2e_context):
    """Favoriting episodes must not alter the unplayed_episodes count."""
    client = e2e_context["owner"]
    e2e_context["add_episode"]("ep-cnt-1")
    e2e_context["add_episode"]("ep-cnt-2")
    e2e_context["add_episode"]("ep-cnt-3")

    show = client.get(f"/api/v1/podcasts/{SHOW_ID}", headers=HEADERS).json()["podcast"]
    assert show["unplayed_episodes"] == 3

    # Favorite ep-1 -> unplayed count remains 3
    client.put(
        "/api/v1/podcasts/episodes/ep-cnt-1/favorite", headers=HEADERS, json={"favorite": True}
    )
    show_after_fav = client.get(f"/api/v1/podcasts/{SHOW_ID}", headers=HEADERS).json()["podcast"]
    assert show_after_fav["unplayed_episodes"] == 3

    # Mark ep-1 complete -> unplayed count becomes 2
    client.put(
        "/api/v1/podcasts/episodes/ep-cnt-1/progress",
        headers=HEADERS,
        json={
            "session_id": "session-device-e2e-3",
            "device_id": "dev-web",
            "base_version": 0,
            "sequence": 1,
            "position_seconds": 3600,
            "duration_seconds": 3600,
            "event": "ended",
        },
    )
    show_after_comp = client.get(f"/api/v1/podcasts/{SHOW_ID}", headers=HEADERS).json()["podcast"]
    assert show_after_comp["unplayed_episodes"] == 2

    # Favorite ep-2 -> unplayed count remains 2
    client.put(
        "/api/v1/podcasts/episodes/ep-cnt-2/favorite", headers=HEADERS, json={"favorite": True}
    )
    show_after_fav2 = client.get(f"/api/v1/podcasts/{SHOW_ID}", headers=HEADERS).json()["podcast"]
    assert show_after_fav2["unplayed_episodes"] == 2

    # Mark ep-1 unplayed -> unplayed count returns to 3
    client.put(
        "/api/v1/podcasts/episodes/ep-cnt-1/progress",
        headers=HEADERS,
        json={
            "session_id": "session-device-e2e-3",
            "device_id": "dev-web",
            "base_version": 1,
            "sequence": 2,
            "position_seconds": 0,
            "duration_seconds": 3600,
            "event": "stop",
        },
    )
    show_after_unplay = client.get(f"/api/v1/podcasts/{SHOW_ID}", headers=HEADERS).json()["podcast"]
    assert show_after_unplay["unplayed_episodes"] == 3


# ==============================================================================
# Tier 4: Full Lifecycle Scenario
# ==============================================================================


def test_tier4_full_lifecycle_favorite_download_cleanup_unfavorite(e2e_context):
    """Full lifecycle:
    1. Server audio file exists for episode.
    2. User 1 establishes a download resource reference.
    3. User 2 favorites the episode.
    4. User 1 drops their download reference (0 download references).
    5. Cleanup runs -> Audio file is strictly preserved because User 2 has it favorited.
    6. User 2 unfavorites the episode (0 references, 0 favorites).
    7. Cleanup runs -> Audio file is eligible and deleted from storage.
    """
    owner = e2e_context["owner"]
    listener = e2e_context["listener"]
    manager = e2e_context["manager"]

    # 1. Server has audio file
    path = e2e_context["add_episode"](
        "ep-lifecycle", audio_bytes=b"lifecycle persistent audio bytes"
    )
    assert path.is_file()

    # 2. User 1 (owner) saves / downloads the episode
    save_resp = owner.post("/api/v1/podcasts/episodes/ep-lifecycle/download", headers=HEADERS)
    assert save_resp.status_code == 200
    assert save_resp.json()["reused"] is True

    # 3. User 2 (listener) favorites the episode
    fav_resp = listener.put(
        "/api/v1/podcasts/episodes/ep-lifecycle/favorite",
        headers=HEADERS,
        json={"favorite": True},
    )
    assert fav_resp.status_code == 200

    # 4. User 1 releases their download reference
    del_resp = owner.delete("/api/v1/podcasts/episodes/ep-lifecycle/download", headers=HEADERS)
    assert del_resp.status_code == 200
    assert del_resp.json()["saved"] is False

    # Verify references in DB is 0
    with e2e_context["database"].connect() as conn:
        refs_count = conn.execute(
            "SELECT count(*) FROM podcast_resource_refs WHERE episode_id='ep-lifecycle'"
        ).fetchone()[0]
        assert refs_count == 0

    # 5. Cleanup runs -> File MUST be preserved
    cleanup1 = manager.resources.cleanup(dry_run=False)
    assert cleanup1["deleted_count"] == 0
    assert path.exists(), "Audio file must NOT be deleted while favorited by User 2"

    # 6. User 2 unfavorites the episode
    unfav_resp = listener.put(
        "/api/v1/podcasts/episodes/ep-lifecycle/favorite",
        headers=HEADERS,
        json={"favorite": False},
    )
    assert unfav_resp.status_code == 200

    # 7. Cleanup runs again -> File is deleted
    cleanup2 = manager.resources.cleanup(dry_run=False)
    assert cleanup2["deleted_count"] == 1
    assert not path.exists(), "Audio file should be deleted once unfavorited and unreferenced"
