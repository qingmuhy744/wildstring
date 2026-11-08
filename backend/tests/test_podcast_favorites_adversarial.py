"""Adversarial challenge test suite for podcast episode favorites API.

Stress-tests:
- Idempotency of PUT /favorite (repeated True/False, parameter precedence, forbidden extras, invalid types)
- Non-existent episodes and injection payloads
- Catalog authorization barriers (unauthorized listeners, catalog revocation, access leaks)
- Concurrency (same-user races, multi-user races, favorite vs storage cleanup)
- GET /favorites metadata completeness, progress tracking isolation, and download status
"""

import concurrent.futures
import time

import pytest
from fastapi.testclient import TestClient
from test_podcast_publishers import seed

from wildstring.database import Database

HEADERS = {"X-Wildstring-Client": "web"}


@pytest.fixture
def adversarial_setup(settings, authenticated_client):
    with authenticated_client(settings) as owner_client:
        db = Database(settings.data_dir)
        seed(db)
        manager = owner_client.app.state.podcasts
        manager.queue_download_episode = lambda identity: True
        audio_path = settings.podcasts_dir / "adv_protected_ep.mp3"
        audio_path.write_bytes(b"adversarial audio payload")

        # Create Listener 1 (catalog: east only)
        u1 = owner_client.post(
            "/api/v1/manage/users",
            headers=HEADERS,
            json={"username": "listener-east", "password": "pass-listener-east", "library_ids": []},
        ).json()
        u1_id = u1["id"]
        with db.connect(write=True) as conn:
            conn.execute("INSERT INTO podcast_user_catalog VALUES (?, 'east')", (u1_id,))

        client_1 = TestClient(owner_client.app)
        res1 = client_1.post(
            "/api/v1/auth/login",
            headers=HEADERS,
            json={"username": "listener-east", "password": "pass-listener-east"},
        )
        assert res1.status_code == 200

        # Create Listener 2 (catalog: coffee only)
        u2 = owner_client.post(
            "/api/v1/manage/users",
            headers=HEADERS,
            json={
                "username": "listener-coffee",
                "password": "pass-listener-coffee",
                "library_ids": [],
            },
        ).json()
        u2_id = u2["id"]
        with db.connect(write=True) as conn:
            conn.execute("INSERT INTO podcast_user_catalog VALUES (?, 'coffee')", (u2_id,))

        client_2 = TestClient(owner_client.app)
        res2 = client_2.post(
            "/api/v1/auth/login",
            headers=HEADERS,
            json={"username": "listener-coffee", "password": "pass-listener-coffee"},
        )
        assert res2.status_code == 200

        try:
            yield owner_client, client_1, client_2, manager, db, audio_path, u1_id, u2_id
        finally:
            client_1.close()
            client_2.close()


# ----------------------------------------------------------------------
# 1. Stress-test Idempotency of PUT /favorite
# ----------------------------------------------------------------------
def test_idempotency_put_favorite_true_and_false_bursts(adversarial_setup):
    owner, client_1, _, manager, db, _, u1_id, _ = adversarial_setup

    # 1.1 Burst of 30 sequential PUT True calls
    created_at_first = None
    for i in range(30):
        res = client_1.put(
            "/api/v1/podcasts/episodes/ep-east/favorite",
            headers=HEADERS,
            json={"favorite": True},
        )
        assert res.status_code == 200, f"Burst True iteration {i} failed with {res.status_code}"
        body = res.json()
        assert body == {"episode_id": "ep-east", "favorite": True, "loved": True}

        # Verify DB integrity: exactly 1 row, created_at never changes
        with db.connect() as conn:
            row = conn.execute(
                "SELECT created_at FROM podcast_episode_favorites WHERE user_id=? AND episode_id='ep-east'",
                (u1_id,),
            ).fetchone()
            assert row is not None
            if created_at_first is None:
                created_at_first = row[0]
            else:
                assert row[0] == created_at_first, "created_at mutated on idempotent PUT True"

            # zero_since must remain NULL
            zs = conn.execute(
                "SELECT zero_since FROM podcast_resource_state WHERE episode_id='ep-east'"
            ).fetchone()
            assert zs is None or zs[0] is None

    # 1.2 Burst of 30 sequential PUT False calls
    zero_since_first = None
    for i in range(30):
        res = client_1.put(
            "/api/v1/podcasts/episodes/ep-east/favorite",
            headers=HEADERS,
            json={"favorite": False},
        )
        assert res.status_code == 200, f"Burst False iteration {i} failed with {res.status_code}"
        body = res.json()
        assert body == {"episode_id": "ep-east", "favorite": False, "loved": False}

        # Verify DB integrity: exactly 0 rows
        with db.connect() as conn:
            count = conn.execute(
                "SELECT count(*) FROM podcast_episode_favorites WHERE user_id=? AND episode_id='ep-east'",
                (u1_id,),
            ).fetchone()[0]
            assert count == 0

            zs = conn.execute(
                "SELECT zero_since FROM podcast_resource_state WHERE episode_id='ep-east'"
            ).fetchone()
            if zs and zs[0] is not None:
                if zero_since_first is None:
                    zero_since_first = zs[0]
                else:
                    assert zs[0] == zero_since_first, (
                        "zero_since was overwritten on redundant PUT False"
                    )

    # 1.3 Payload combinations and precedence:
    # 'favorite' has precedence over 'loved'
    res = client_1.put(
        "/api/v1/podcasts/episodes/ep-east/favorite",
        headers=HEADERS,
        json={"favorite": True, "loved": False},
    )
    assert res.status_code == 200
    assert res.json()["favorite"] is True

    res = client_1.put(
        "/api/v1/podcasts/episodes/ep-east/favorite",
        headers=HEADERS,
        json={"favorite": False, "loved": True},
    )
    assert res.status_code == 200
    assert res.json()["favorite"] is False

    # 'loved' alone works
    res = client_1.put(
        "/api/v1/podcasts/episodes/ep-east/favorite",
        headers=HEADERS,
        json={"loved": True},
    )
    assert res.status_code == 200
    assert res.json()["favorite"] is True

    # Empty dict defaults to True
    res = client_1.put(
        "/api/v1/podcasts/episodes/ep-east/favorite",
        headers=HEADERS,
        json={},
    )
    assert res.status_code == 200
    assert res.json()["favorite"] is True

    # Missing body defaults to True
    res = client_1.put(
        "/api/v1/podcasts/episodes/ep-east/favorite",
        headers=HEADERS,
    )
    assert res.status_code == 200
    assert res.json()["favorite"] is True

    # 1.4 Extra fields should be rejected (extra="forbid") -> 422
    res = client_1.put(
        "/api/v1/podcasts/episodes/ep-east/favorite",
        headers=HEADERS,
        json={"favorite": True, "malicious_field": 123},
    )
    assert res.status_code == 422

    # 1.5 Malformed type -> 422
    res = client_1.put(
        "/api/v1/podcasts/episodes/ep-east/favorite",
        headers=HEADERS,
        json={"favorite": "yes_please"},
    )
    assert res.status_code == 422


# ----------------------------------------------------------------------
# 2. Stress-test Non-Existent Episodes & Injections
# ----------------------------------------------------------------------
def test_nonexistent_episodes_and_injection(adversarial_setup):
    owner, client_1, _, _, db, _, _, _ = adversarial_setup

    malformed_ids = [
        "non-existent-id-12345",
        "../../etc/passwd",
        "' OR '1'='1",
        "ep-east'; DROP TABLE podcast_episode_favorites; --",
        "spaces in id",
        "null%00byte",
    ]

    for bad_id in malformed_ids:
        # PUT True
        res_put_true = client_1.put(
            f"/api/v1/podcasts/episodes/{bad_id}/favorite",
            headers=HEADERS,
            json={"favorite": True},
        )
        assert res_put_true.status_code in (404, 422, 403)

        # PUT False
        res_put_false = client_1.put(
            f"/api/v1/podcasts/episodes/{bad_id}/favorite",
            headers=HEADERS,
            json={"favorite": False},
        )
        assert res_put_false.status_code in (404, 422, 403)

    # Verify table is completely intact and empty
    with db.connect() as conn:
        count = conn.execute("SELECT count(*) FROM podcast_episode_favorites").fetchone()[0]
        assert count == 0


# ----------------------------------------------------------------------
# 3. Catalog Authorization Barriers
# ----------------------------------------------------------------------
def test_catalog_authorization_barriers_and_revocation(adversarial_setup):
    owner, client_1, client_2, manager, db, _, u1_id, u2_id = adversarial_setup

    # Listener 1 only has 'east' in catalog; Listener 2 only has 'coffee'
    # 3.1 Listener 1 cannot favorite 'ep-coffee'
    res = client_1.put(
        "/api/v1/podcasts/episodes/ep-coffee/favorite",
        headers=HEADERS,
        json={"favorite": True},
    )
    assert res.status_code == 404, (
        "Listener 1 should not be able to favorite an uncatalogued podcast"
    )

    # Listener 2 cannot favorite 'ep-east'
    res = client_2.put(
        "/api/v1/podcasts/episodes/ep-east/favorite",
        headers=HEADERS,
        json={"favorite": True},
    )
    assert res.status_code == 404, (
        "Listener 2 should not be able to favorite an uncatalogued podcast"
    )

    # 3.2 Listener 1 can favorite 'ep-east'
    res = client_1.put(
        "/api/v1/podcasts/episodes/ep-east/favorite",
        headers=HEADERS,
        json={"favorite": True},
    )
    assert res.status_code == 200

    # Listener 2 cannot see Listener 1's favorite in GET /favorites or GET /favorites/ids
    assert client_2.get("/api/v1/podcasts/favorites", headers=HEADERS).json() == []
    assert client_2.get("/api/v1/podcasts/favorites/ids", headers=HEADERS).json() == {"ids": []}

    # Listener 1 sees 'ep-east'
    favs = client_1.get("/api/v1/podcasts/favorites", headers=HEADERS).json()
    assert len(favs) == 1
    assert favs[0]["id"] == "ep-east"

    # 3.3 Catalog Revocation scenario:
    # Admin revokes 'east' from Listener 1's personal catalog
    with db.connect(write=True) as conn:
        conn.execute(
            "DELETE FROM podcast_user_catalog WHERE user_id=? AND podcast_id='east'", (u1_id,)
        )

    # Now verify behavior:
    # A. GET /favorites should NOT show ep-east because user lacks catalog access
    revoked_favs = client_1.get("/api/v1/podcasts/favorites", headers=HEADERS).json()
    assert revoked_favs == [], "Revoked catalog item should be filtered out from GET /favorites"

    # B. GET /episodes/ep-east should return 404
    assert client_1.get("/api/v1/podcasts/episodes/ep-east", headers=HEADERS).status_code == 404

    # C. Check GET /favorites/ids behavior: does it filter or leak?
    revoked_ids = client_1.get("/api/v1/podcasts/favorites/ids", headers=HEADERS).json()["ids"]
    # Favorite IDs index retains favorited ID until unfavorited or cascade-deleted
    assert "ep-east" in revoked_ids

    # D. Unfavoriting an episode when catalog access is revoked:
    # require_episode raises 404, so user cannot unfavorite
    unfav_revoked = client_1.put(
        "/api/v1/podcasts/episodes/ep-east/favorite",
        headers=HEADERS,
        json={"favorite": False},
    )
    assert unfav_revoked.status_code == 404

    # Restore catalog access to Listener 1
    with db.connect(write=True) as conn:
        conn.execute("INSERT INTO podcast_user_catalog VALUES (?, 'east')", (u1_id,))

    # Immediately restored in GET /favorites
    restored_favs = client_1.get("/api/v1/podcasts/favorites", headers=HEADERS).json()
    assert len(restored_favs) == 1
    assert restored_favs[0]["id"] == "ep-east"


# ----------------------------------------------------------------------
# 4. Concurrency Stress Test
# ----------------------------------------------------------------------
def test_concurrent_favorites_same_user_and_multi_user(adversarial_setup):
    owner, client_1, client_2, manager, db, audio_path, u1_id, u2_id = adversarial_setup

    # 4.1 20 concurrent threads toggling favorite on ep-east for Listener 1
    def worker_put(fav: bool):
        return client_1.put(
            "/api/v1/podcasts/episodes/ep-east/favorite",
            headers=HEADERS,
            json={"favorite": fav},
        )

    # 20 threads simultaneously putting favorite=True
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
        futures = [executor.submit(worker_put, True) for _ in range(20)]
        results = [f.result() for f in concurrent.futures.as_completed(futures)]

    # All should return 200
    assert all(r.status_code == 200 for r in results)

    # Exactly 1 row in DB
    with db.connect() as conn:
        count = conn.execute(
            "SELECT count(*) FROM podcast_episode_favorites WHERE user_id=? AND episode_id='ep-east'",
            (u1_id,),
        ).fetchone()[0]
        assert count == 1

    # 4.2 Multi-user concurrency: 10 distinct users favoriting ep-east concurrently
    # Create 10 users with catalog access
    extra_clients = []
    for i in range(10):
        uname = f"concur-user-{i}"
        created = owner.post(
            "/api/v1/manage/users",
            headers=HEADERS,
            json={"username": uname, "password": f"test-concur-password-{i}", "library_ids": []},
        ).json()
        uid = created["id"]
        with db.connect(write=True) as conn:
            conn.execute("INSERT INTO podcast_user_catalog VALUES (?, 'east')", (uid,))
        c = TestClient(owner.app)
        c.post(
            "/api/v1/auth/login",
            headers=HEADERS,
            json={"username": uname, "password": f"test-concur-password-{i}"},
        )
        extra_clients.append((c, uid))

    def user_fav(client_tuple):
        cl, uid = client_tuple
        return cl.put(
            "/api/v1/podcasts/episodes/ep-east/favorite",
            headers=HEADERS,
            json={"favorite": True},
        )

    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
        futures = [executor.submit(user_fav, ct) for ct in extra_clients]
        results = [f.result() for f in concurrent.futures.as_completed(futures)]

    assert all(r.status_code == 200 for r in results)

    # Verify 11 total favorites for ep-east (listener_1 + 10 extra users)
    with db.connect() as conn:
        total = conn.execute(
            "SELECT count(*) FROM podcast_episode_favorites WHERE episode_id='ep-east'"
        ).fetchone()[0]
        assert total == 11

    # 4.3 Race condition between favorites and storage cleanup
    store = manager.resources
    with db.connect(write=True) as conn:
        conn.execute(
            "UPDATE podcast_episodes SET local_path=?, download_status='downloaded' WHERE id='ep-east'",
            (str(audio_path),),
        )
        store.downloaded(conn, "ep-east")

    stop_flag = False

    def toggle_loop(client_tuple):
        cl, _ = client_tuple
        while not stop_flag:
            cl.put(
                "/api/v1/podcasts/episodes/ep-east/favorite",
                headers=HEADERS,
                json={"favorite": False},
            )
            cl.put(
                "/api/v1/podcasts/episodes/ep-east/favorite",
                headers=HEADERS,
                json={"favorite": True},
            )
            time.sleep(0.01)

    def cleanup_loop():
        for _ in range(10):
            store.cleanup(dry_run=False, automatic=False)
            time.sleep(0.02)

    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor:
        f_toggle = executor.submit(toggle_loop, extra_clients[0])
        f_clean = executor.submit(cleanup_loop)
        f_clean.result()
        stop_flag = True
        f_toggle.result()

    # The audio file must NEVER be deleted while other users still have it favorited!
    assert audio_path.exists(), (
        "Audio file was improperly deleted during concurrent favorite/cleanup operations!"
    )

    # Clean up test clients
    for c, _ in extra_clients:
        c.close()


# ----------------------------------------------------------------------
# 5. GET /favorites Metadata, Progress & Download Status Verification
# ----------------------------------------------------------------------
def test_favorites_metadata_progress_and_download_status(adversarial_setup):
    owner, client_1, client_2, manager, db, audio_path, u1_id, u2_id = adversarial_setup

    # 5.1 Metadata fields completeness and values
    # Favorite ep-east
    client_1.put(
        "/api/v1/podcasts/episodes/ep-east/favorite",
        headers=HEADERS,
        json={"favorite": True},
    )

    favs = client_1.get("/api/v1/podcasts/favorites", headers=HEADERS).json()
    assert len(favs) == 1
    ep = favs[0]

    # Verify all expected schema fields
    required_fields = {
        "id",
        "podcast_id",
        "guid",
        "title",
        "description",
        "audio_url",
        "duration_seconds",
        "pub_date",
        "episode_number",
        "season_number",
        "created_at",
        "position_seconds",
        "completed",
        "local_path",
        "download_status",
        "resource_saved",
        "resource_automatic",
        "resource_playback_cached",
        "favorite",
        "loved",
        "podcast_title",
        "cover_url",
        "author",
        "favorited_at",
    }
    assert required_fields.issubset(ep.keys())
    assert ep["id"] == "ep-east"
    assert ep["podcast_id"] == "east"
    assert ep["favorite"] is True
    assert ep["loved"] is True
    assert ep["podcast_title"] == "east"
    assert ep["author"] == "ETW Studio"
    assert ep["local_path"] is None  # local_path hidden for client security

    # 5.2 Ordering: reverse chronological by favorited_at
    # Give Listener 1 access to 'coffee' as well to test multi-show favorites ordering
    with db.connect(write=True) as conn:
        conn.execute("INSERT INTO podcast_user_catalog VALUES (?, 'coffee')", (u1_id,))

    time.sleep(0.05)  # ensure different timestamp
    client_1.put(
        "/api/v1/podcasts/episodes/ep-coffee/favorite",
        headers=HEADERS,
        json={"favorite": True},
    )

    favs_ordered = client_1.get("/api/v1/podcasts/favorites", headers=HEADERS).json()
    assert [f["id"] for f in favs_ordered] == ["ep-coffee", "ep-east"]
    assert favs_ordered[0]["favorited_at"] >= favs_ordered[1]["favorited_at"]

    # Re-favoriting ep-east after unfavoriting updates its favorited_at to the top
    time.sleep(0.05)
    client_1.put(
        "/api/v1/podcasts/episodes/ep-east/favorite", headers=HEADERS, json={"favorite": False}
    )
    client_1.put(
        "/api/v1/podcasts/episodes/ep-east/favorite", headers=HEADERS, json={"favorite": True}
    )
    favs_reordered = client_1.get("/api/v1/podcasts/favorites", headers=HEADERS).json()
    assert [f["id"] for f in favs_reordered] == ["ep-east", "ep-coffee"]

    # 5.3 Progress tracking: position_seconds and completed
    # Initially progress is 0, completed is False
    assert favs_reordered[0]["position_seconds"] == 0
    assert favs_reordered[0]["completed"] is False

    # Update progress to 180s (out of 600s)
    prog_res = client_1.put(
        "/api/v1/podcasts/episodes/ep-east/progress",
        headers=HEADERS,
        json={
            "session_id": "session-unique-12345",
            "device_id": "dev-1",
            "sequence": 1,
            "position_seconds": 180,
            "duration_seconds": 600,
            "event": "progress",
            "base_version": 0,
        },
    )
    assert prog_res.status_code == 200

    # GET /favorites must immediately reflect position_seconds=180, completed=False
    favs_progress = client_1.get("/api/v1/podcasts/favorites", headers=HEADERS).json()
    ep_prog = next(f for f in favs_progress if f["id"] == "ep-east")
    assert ep_prog["position_seconds"] == 180
    assert ep_prog["completed"] is False

    # Mark completed with event="ended"
    cur_ver = prog_res.json()["version"]
    prog_end = client_1.put(
        "/api/v1/podcasts/episodes/ep-east/progress",
        headers=HEADERS,
        json={
            "session_id": "session-unique-12345",
            "device_id": "dev-1",
            "sequence": 2,
            "position_seconds": 600,
            "duration_seconds": 600,
            "event": "ended",
            "base_version": cur_ver,
        },
    )
    assert prog_end.status_code == 200
    assert prog_end.json()["completed"] is True

    # GET /favorites must immediately reflect completed=True
    favs_completed = client_1.get("/api/v1/podcasts/favorites", headers=HEADERS).json()
    ep_completed = next(f for f in favs_completed if f["id"] == "ep-east")
    assert ep_completed["completed"] is True
    assert ep_completed["position_seconds"] == 600

    # Progress isolation check:
    # Give Listener 2 access to 'east' and have Listener 2 favorite it
    with db.connect(write=True) as conn:
        conn.execute("INSERT INTO podcast_user_catalog VALUES (?, 'east')", (u2_id,))
    client_2.put(
        "/api/v1/podcasts/episodes/ep-east/favorite", headers=HEADERS, json={"favorite": True}
    )

    # Listener 2 must have position_seconds=0 and completed=False
    favs_user2 = client_2.get("/api/v1/podcasts/favorites", headers=HEADERS).json()
    ep_user2 = next(f for f in favs_user2 if f["id"] == "ep-east")
    assert ep_user2["position_seconds"] == 0
    assert ep_user2["completed"] is False

    # 5.4 Download status and resource_saved flag
    # Check default download_status
    assert ep_completed["download_status"] in ("none", "downloaded")
    assert ep_completed["resource_saved"] is False

    # Explicitly save download for Listener 1
    save_res = client_1.post("/api/v1/podcasts/episodes/ep-east/download", headers=HEADERS)
    assert save_res.status_code == 200

    favs_saved = client_1.get("/api/v1/podcasts/favorites", headers=HEADERS).json()
    ep_saved = next(f for f in favs_saved if f["id"] == "ep-east")
    assert ep_saved["resource_saved"] is True

    # Listener 2's resource_saved must remain False
    favs_user2_after = client_2.get("/api/v1/podcasts/favorites", headers=HEADERS).json()
    ep_user2_after = next(f for f in favs_user2_after if f["id"] == "ep-east")
    assert ep_user2_after["resource_saved"] is False

    # Simulate download status update to "downloading" then "downloaded"
    with db.connect(write=True) as conn:
        conn.execute("UPDATE podcast_episodes SET download_status='downloading' WHERE id='ep-east'")

    favs_downloading = client_1.get("/api/v1/podcasts/favorites", headers=HEADERS).json()
    assert (
        next(f for f in favs_downloading if f["id"] == "ep-east")["download_status"]
        == "downloading"
    )

    with db.connect(write=True) as conn:
        conn.execute("UPDATE podcast_episodes SET download_status='downloaded' WHERE id='ep-east'")

    favs_downloaded = client_1.get("/api/v1/podcasts/favorites", headers=HEADERS).json()
    assert (
        next(f for f in favs_downloaded if f["id"] == "ep-east")["download_status"] == "downloaded"
    )


# ----------------------------------------------------------------------
# 6. Audio Retention & Shared Path Alias Adversarial Stress Test
# ----------------------------------------------------------------------
def test_storage_retention_and_alias_adversarial(adversarial_setup):
    owner, client_1, client_2, manager, db, audio_path, u1_id, u2_id = adversarial_setup
    store = manager.resources

    # Create a shared audio file on disk
    shared_audio = audio_path.parent / "shared_alias_test.mp3"
    shared_audio.write_bytes(b"shared alias audio data")

    # Ep 1 and Ep 2 point to the SAME local audio path
    with db.connect(write=True) as conn:
        conn.execute(
            "UPDATE podcast_episodes SET local_path=?, download_status='downloaded' WHERE id='ep-east'",
            (str(shared_audio),),
        )
        conn.execute(
            "UPDATE podcast_episodes SET local_path=?, download_status='downloaded' WHERE id='ep-coffee'",
            (str(shared_audio),),
        )
        store.downloaded(conn, "ep-east")
        store.downloaded(conn, "ep-coffee")

    # Initially, neither episode is favorited, neither has refs -> both zero_since ticking
    preview = store.cleanup()
    candidate_ids = {c["id"] for c in preview["candidates"]}
    assert len(candidate_ids) == 1 and candidate_ids.issubset({"ep-east", "ep-coffee"})

    # User 2 favorites ONLY ep-coffee (ep-east remains completely unfavorited and unreferenced)
    client_2.put(
        "/api/v1/podcasts/episodes/ep-coffee/favorite", headers=HEADERS, json={"favorite": True}
    )

    # Now verify cleanup preview:
    # ep-east points to shared_audio, but its alias ep-coffee has favorite_count > 0!
    # Therefore, shared_audio MUST be preserved and ep-east candidate must be skipped!
    preview_protected = store.cleanup()
    protected_candidates = [
        c for c in preview_protected["candidates"] if c["id"] in ("ep-east", "ep-coffee")
    ]
    assert len(protected_candidates) == 0, (
        f"Expected 0 candidates for shared audio, got: {protected_candidates}"
    )

    # Run cleanup (both dry_run=False and automatic=True/False)
    store.cleanup(dry_run=False, automatic=True)
    assert shared_audio.exists(), "Automatic cleanup deleted shared audio of favorited alias!"

    store.cleanup(dry_run=False, automatic=False)
    assert shared_audio.exists(), "Manual cleanup deleted shared audio of favorited alias!"

    # Test synchronize(): Ensure background reconcile keeps zero_since=NULL for favorited episodes
    with db.connect(write=True) as conn:
        store.synchronize(conn)
        zs_coffee = conn.execute(
            "SELECT zero_since FROM podcast_resource_state WHERE episode_id='ep-coffee'"
        ).fetchone()[0]
        assert zs_coffee is None, "synchronize() improperly set zero_since for a favorited episode!"

    # Test release(): Call release on ep-coffee
    # Even if release is called, because it is favorited, zero_since must NOT start ticking
    store.release("ep-coffee", u2_id)
    with db.connect() as conn:
        zs_coffee = conn.execute(
            "SELECT zero_since FROM podcast_resource_state WHERE episode_id='ep-coffee'"
        ).fetchone()[0]
        assert zs_coffee is None, "release() improperly set zero_since for a favorited episode!"

    # Unfavorite ep-coffee: now both are unreferenced and unfavorited
    client_2.put(
        "/api/v1/podcasts/episodes/ep-coffee/favorite", headers=HEADERS, json={"favorite": False}
    )

    # Now cleanup should find them
    preview_unprotected = store.cleanup()
    unprotected_ids = {c["id"] for c in preview_unprotected["candidates"]}
    assert "ep-coffee" in unprotected_ids or "ep-east" in unprotected_ids

    # Execute cleanup
    store.cleanup(dry_run=False)
    assert not shared_audio.exists(), (
        "Audio file should be cleaned up after all favorites/refs removed"
    )
