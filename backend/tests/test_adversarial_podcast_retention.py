"""Adversarial stress harness challenging the podcast server audio cleanup retention guard.

Tests empirical edge cases:
1. Multi-podcast alias episodes sharing the same physical audio file on disk.
2. zero_since lifecycle, state transitions, and multi-user overlaps.
3. Download completion after pre-favoriting.
4. Resurrecting expired retention by favoriting before cleanup.
5. Releasing personal saves while favorited.
6. Healing desynchronized zero_since via synchronize().
7. User account deletion cascade.
8. Concurrent favorite during cleanup traversal.
9. Idempotent favorite and unfavorite state mutations.
"""

import time

import pytest
from fastapi.testclient import TestClient
from test_podcast_publishers import seed

from wildstring.database import Database

HEADERS = {"X-Wildstring-Client": "web"}


@pytest.fixture
def adversarial_setup(settings, authenticated_client):
    with authenticated_client(settings) as client:
        db = Database(settings.data_dir)
        seed(db)
        manager = client.app.state.podcasts
        manager.queue_download_episode = lambda identity: True

        # Create two additional users for multi-user tests
        u1_res = client.post(
            "/api/v1/manage/users",
            headers=HEADERS,
            json={"username": "adv-user-1", "password": "adv-password-1", "library_ids": []},
        ).json()
        u1_id = u1_res["id"]

        u2_res = client.post(
            "/api/v1/manage/users",
            headers=HEADERS,
            json={"username": "adv-user-2", "password": "adv-password-2", "library_ids": []},
        ).json()
        u2_id = u2_res["id"]

        with db.connect(write=True) as conn:
            for uid in (u1_id, u2_id):
                conn.execute("INSERT INTO podcast_user_catalog VALUES (?, 'east')", (uid,))
                conn.execute("INSERT INTO podcast_user_catalog VALUES (?, 'coffee')", (uid,))
                conn.execute("INSERT INTO podcast_user_catalog VALUES (?, 'other')", (uid,))

        c1 = TestClient(client.app)
        assert (
            c1.post(
                "/api/v1/auth/login",
                headers=HEADERS,
                json={"username": "adv-user-1", "password": "adv-password-1"},
            ).status_code
            == 200
        )

        c2 = TestClient(client.app)
        assert (
            c2.post(
                "/api/v1/auth/login",
                headers=HEADERS,
                json={"username": "adv-user-2", "password": "adv-password-2"},
            ).status_code
            == 200
        )

        try:
            yield client, c1, c2, manager, db, u1_id, u2_id, settings
        finally:
            c1.close()
            c2.close()


def test_shared_disk_audio_alias_protected_when_any_alias_favorited(adversarial_setup):
    """Adversarial Challenge 1:
    Two episodes (ep-east in podcast 'east', ep-other in podcast 'other') point to the SAME physical audio file.
    Only ep-east is favorited. ep-other is un-favorited and its zero_since is long expired.
    Neither manual, automatic, nor targeted cleanup should unlink the shared file.
    """
    owner, user1, user2, manager, db, u1_id, u2_id, settings = adversarial_setup
    store = manager.resources

    shared_file = settings.podcasts_dir / "shared_audio.mp3"
    shared_file.write_bytes(b"shared audio payload across shows")

    # Link both ep-east and ep-other to shared_file
    with db.connect(write=True) as conn:
        conn.execute(
            "UPDATE podcast_episodes SET local_path=?, download_status='downloaded' WHERE id='ep-east'",
            (str(shared_file),),
        )
        conn.execute(
            "UPDATE podcast_episodes SET local_path=?, download_status='downloaded' WHERE id='ep-other'",
            (str(shared_file),),
        )
        # Register both in resource state
        store.downloaded(conn, "ep-east")
        store.downloaded(conn, "ep-other")

        # Age ep-other's zero_since by 100 days (way past retention)
        expired_stamp = time.time() - (100 * 86400)
        conn.execute(
            "UPDATE podcast_resource_state SET zero_since=? WHERE episode_id='ep-other'",
            (expired_stamp,),
        )

    # Favorite ONLY ep-east (via user1)
    res = user1.put(
        "/api/v1/podcasts/episodes/ep-east/favorite", headers=HEADERS, json={"favorite": True}
    )
    assert res.status_code == 200

    # Ensure ep-other is NOT favorited
    with db.connect() as conn:
        fav_count_other = conn.execute(
            "SELECT count(*) FROM podcast_episode_favorites WHERE episode_id='ep-other'"
        ).fetchone()[0]
        assert fav_count_other == 0

        fav_count_east = conn.execute(
            "SELECT count(*) FROM podcast_episode_favorites WHERE episode_id='ep-east'"
        ).fetchone()[0]
        assert fav_count_east == 1

    # 1. Preview cleanup: candidate count MUST be 0 because ep-east is an alias referencing the same file
    preview = store.cleanup()
    assert preview["candidate_count"] == 0
    assert preview["candidates"] == []

    # 2. Automatic cleanup: MUST NOT delete shared_file
    auto_res = store.cleanup(dry_run=False, automatic=True)
    assert auto_res["deleted_count"] == 0
    assert shared_file.is_file()

    # 3. Manual cleanup: MUST NOT delete shared_file
    manual_res = store.cleanup(dry_run=False, automatic=False)
    assert manual_res["deleted_count"] == 0
    assert shared_file.is_file()

    # 4. Targeted cleanup on podcast 'other' (where ep-other lives, which has expired zero_since and 0 favorites)
    # This specifically attacks whether targeted cleanup ignores aliases outside the target show
    targeted_res = store.cleanup(dry_run=False, podcast_id="other")
    assert targeted_res["deleted_count"] == 0
    assert shared_file.is_file()

    # Verify database state remained intact: neither episode had local_path wiped
    with db.connect() as conn:
        assert conn.execute(
            "SELECT local_path FROM podcast_episodes WHERE id='ep-east'"
        ).fetchone()[0] == str(shared_file)
        assert conn.execute(
            "SELECT local_path FROM podcast_episodes WHERE id='ep-other'"
        ).fetchone()[0] == str(shared_file)

    # Now, unfavorite ep-east
    res_unfav = user1.put(
        "/api/v1/podcasts/episodes/ep-east/favorite", headers=HEADERS, json={"favorite": False}
    )
    assert res_unfav.status_code == 200

    # Now with 0 favorites on both aliases, manual cleanup SHOULD delete the shared file
    final_clean = store.cleanup(dry_run=False, automatic=False)
    assert final_clean["deleted_count"] == 1
    assert not shared_file.exists()

    with db.connect() as conn:
        assert (
            conn.execute("SELECT local_path FROM podcast_episodes WHERE id='ep-east'").fetchone()[0]
            is None
        )
        assert (
            conn.execute("SELECT local_path FROM podcast_episodes WHERE id='ep-other'").fetchone()[
                0
            ]
            is None
        )


def test_alias_with_different_path_representations(adversarial_setup):
    """Adversarial Challenge 2:
    Two episodes pointing to the same file via different path representations (e.g. ./path vs absolute).
    _safe_local_path canonicalizes them and cleanup still protects the file.
    """
    owner, user1, _, manager, db, _, _, settings = adversarial_setup
    store = manager.resources

    audio_file = settings.podcasts_dir / "canonical_audio.mp3"
    audio_file.write_bytes(b"canonical audio bytes")

    # Representation 1: absolute string
    path_str1 = str(audio_file)
    # Representation 2: path with /./ embedded
    path_str2 = str(audio_file.parent) + "/./" + audio_file.name

    with db.connect(write=True) as conn:
        conn.execute(
            "UPDATE podcast_episodes SET local_path=?, download_status='downloaded' WHERE id='ep-east'",
            (path_str1,),
        )
        conn.execute(
            "UPDATE podcast_episodes SET local_path=?, download_status='downloaded' WHERE id='ep-other'",
            (path_str2,),
        )
        store.downloaded(conn, "ep-east")
        store.downloaded(conn, "ep-other")

    # Favorite ep-other (which uses path_str2)
    user1.put(
        "/api/v1/podcasts/episodes/ep-other/favorite", headers=HEADERS, json={"favorite": True}
    )

    # Cleanup must protect audio_file
    preview = store.cleanup()
    assert preview["candidate_count"] == 0
    clean = store.cleanup(dry_run=False)
    assert clean["deleted_count"] == 0
    assert audio_file.is_file()


def test_multi_user_favorite_overlap_and_zero_since_transitions(adversarial_setup):
    """Adversarial Challenge 3:
    Multi-user favorite lifecycle:
    U1 favorites -> zero_since is NULL
    U2 favorites -> zero_since stays NULL
    U1 unfavorites -> zero_since stays NULL because U2 still favorites!
    U2 unfavorites -> zero_since transitions to current timestamp (> 0).
    Automatic cleanup with retention period does NOT delete file until retention expires.
    """
    owner, user1, user2, manager, db, u1_id, u2_id, settings = adversarial_setup
    store = manager.resources

    audio_file = settings.podcasts_dir / "multi_user.mp3"
    audio_file.write_bytes(b"multi-user payload")

    with db.connect(write=True) as conn:
        conn.execute(
            "UPDATE podcast_episodes SET local_path=?, download_status='downloaded' WHERE id='ep-east'",
            (str(audio_file),),
        )
        store.downloaded(conn, "ep-east")

    # Configure 7-day retention
    store.configure(
        type("SettingsInput", (), {"enabled": True, "retention_days": 7, "version": 1})()
    )

    # Step 1: User 1 favorites ep-east
    user1.put(
        "/api/v1/podcasts/episodes/ep-east/favorite", headers=HEADERS, json={"favorite": True}
    )
    with db.connect() as conn:
        assert (
            conn.execute(
                "SELECT zero_since FROM podcast_resource_state WHERE episode_id='ep-east'"
            ).fetchone()[0]
            is None
        )

    # Step 2: User 2 favorites ep-east
    user2.put(
        "/api/v1/podcasts/episodes/ep-east/favorite", headers=HEADERS, json={"favorite": True}
    )
    with db.connect() as conn:
        assert (
            conn.execute(
                "SELECT zero_since FROM podcast_resource_state WHERE episode_id='ep-east'"
            ).fetchone()[0]
            is None
        )

    # Step 3: User 1 unfavorites ep-east (User 2 still has it)
    user1.put(
        "/api/v1/podcasts/episodes/ep-east/favorite", headers=HEADERS, json={"favorite": False}
    )
    with db.connect() as conn:
        zero_since = conn.execute(
            "SELECT zero_since FROM podcast_resource_state WHERE episode_id='ep-east'"
        ).fetchone()[0]
        assert zero_since is None, (
            f"zero_since must remain NULL while User 2 favorites it, got {zero_since}"
        )

    # Verify cleanup protects it
    assert store.cleanup(dry_run=False, automatic=True)["deleted_count"] == 0
    assert store.cleanup(dry_run=False, automatic=False)["deleted_count"] == 0
    assert audio_file.is_file()

    # Step 4: User 2 unfavorites ep-east (now 0 users favorite it)
    user2.put(
        "/api/v1/podcasts/episodes/ep-east/favorite", headers=HEADERS, json={"favorite": False}
    )
    with db.connect() as conn:
        zero_since = conn.execute(
            "SELECT zero_since FROM podcast_resource_state WHERE episode_id='ep-east'"
        ).fetchone()[0]
        assert zero_since is not None, (
            "zero_since must be set to timestamp when all favorites removed"
        )
        assert zero_since <= time.time()

    # Step 5: Automatic cleanup must NOT delete it immediately because zero_since is fresh (retention = 7 days)
    auto_res = store.cleanup(dry_run=False, automatic=True)
    assert auto_res["deleted_count"] == 0
    assert audio_file.is_file()

    # Step 6: Age zero_since by 8 days (past 7 days retention)
    with db.connect(write=True) as conn:
        conn.execute(
            "UPDATE podcast_resource_state SET zero_since=? WHERE episode_id='ep-east'",
            (time.time() - (8 * 86400),),
        )

    # Now automatic cleanup SHOULD delete it
    auto_res_expired = store.cleanup(dry_run=False, automatic=True)
    assert auto_res_expired["deleted_count"] == 1
    assert not audio_file.exists()


def test_download_after_favorite_keeps_zero_since_null(adversarial_setup):
    """Adversarial Challenge 4:
    User favorites episode BEFORE download completes.
    When downloaded() is called, zero_since must be set to NULL (not timestamp).
    """
    owner, user1, _, manager, db, _, _, settings = adversarial_setup
    store = manager.resources

    # Favorite ep-coffee while local_path is None
    res = user1.put(
        "/api/v1/podcasts/episodes/ep-coffee/favorite", headers=HEADERS, json={"favorite": True}
    )
    assert res.status_code == 200

    audio_file = settings.podcasts_dir / "coffee.mp3"
    audio_file.write_bytes(b"coffee podcast bytes")

    with db.connect(write=True) as conn:
        conn.execute(
            "UPDATE podcast_episodes SET local_path=?, download_status='downloaded' WHERE id='ep-coffee'",
            (str(audio_file),),
        )
        store.downloaded(conn, "ep-coffee")

        zero_since = conn.execute(
            "SELECT zero_since FROM podcast_resource_state WHERE episode_id='ep-coffee'"
        ).fetchone()[0]
        assert zero_since is None, (
            f"Expected zero_since to be NULL after downloaded() on favorited episode, got {zero_since}"
        )

    # Cleanup must not delete it
    clean = store.cleanup(dry_run=False)
    assert clean["deleted_count"] == 0
    assert audio_file.is_file()


def test_resurrect_expired_retention_by_favoriting_before_cleanup(adversarial_setup):
    """Adversarial Challenge 5:
    Episode has expired zero_since (100 days ago).
    Favoriting it resets zero_since to NULL and aborts cleanup.
    """
    owner, user1, _, manager, db, _, _, settings = adversarial_setup
    store = manager.resources

    audio_file = settings.podcasts_dir / "resurrect.mp3"
    audio_file.write_bytes(b"resurrect audio")

    with db.connect(write=True) as conn:
        conn.execute(
            "UPDATE podcast_episodes SET local_path=?, download_status='downloaded' WHERE id='ep-east'",
            (str(audio_file),),
        )
        store.downloaded(conn, "ep-east")
        # Age zero_since by 100 days
        conn.execute(
            "UPDATE podcast_resource_state SET zero_since=? WHERE episode_id='ep-east'",
            (time.time() - 100 * 86400,),
        )

    # Pre-check: cleanup sees 1 candidate
    preview_before = store.cleanup()
    assert preview_before["candidate_count"] == 1

    # User favorites ep-east
    user1.put(
        "/api/v1/podcasts/episodes/ep-east/favorite", headers=HEADERS, json={"favorite": True}
    )

    # Post-check: zero_since reset to NULL and candidate count is 0
    with db.connect() as conn:
        assert (
            conn.execute(
                "SELECT zero_since FROM podcast_resource_state WHERE episode_id='ep-east'"
            ).fetchone()[0]
            is None
        )

    preview_after = store.cleanup()
    assert preview_after["candidate_count"] == 0
    assert store.cleanup(dry_run=False, automatic=True)["deleted_count"] == 0
    assert store.cleanup(dry_run=False, automatic=False)["deleted_count"] == 0
    assert audio_file.is_file()


def test_personal_save_release_with_active_favorite(adversarial_setup):
    """Adversarial Challenge 6:
    User has personal save (manual=1) AND has favorited.
    Releasing personal save must NOT start zero_since countdown because favorite is active!
    """
    owner, user1, _, manager, db, u1_id, _, settings = adversarial_setup
    store = manager.resources

    audio_file = settings.podcasts_dir / "saved_and_fav.mp3"
    audio_file.write_bytes(b"saved and favorited")

    with db.connect(write=True) as conn:
        conn.execute(
            "UPDATE podcast_episodes SET local_path=?, download_status='downloaded' WHERE id='ep-east'",
            (str(audio_file),),
        )
        store.downloaded(conn, "ep-east")

    # Personal save by user1
    store.save("ep-east", u1_id)
    # Favorite by user1
    user1.put(
        "/api/v1/podcasts/episodes/ep-east/favorite", headers=HEADERS, json={"favorite": True}
    )

    # Release personal save
    store.release("ep-east", u1_id)

    # zero_since must STILL be NULL!
    with db.connect() as conn:
        zero_since = conn.execute(
            "SELECT zero_since FROM podcast_resource_state WHERE episode_id='ep-east'"
        ).fetchone()[0]
        assert zero_since is None, (
            f"zero_since must stay NULL after save release when favorite is active, got {zero_since}"
        )

    assert store.cleanup(dry_run=False)["deleted_count"] == 0
    assert audio_file.is_file()


def test_synchronize_heals_inconsistent_zero_since_for_favorited_episode(adversarial_setup):
    """Adversarial Challenge 7:
    Directly inject corruption into podcast_resource_state: zero_since is set to an expired timestamp
    even though the episode is favorited.
    Calling store.synchronize() must heal zero_since to NULL.
    """
    owner, user1, _, manager, db, _, _, settings = adversarial_setup
    store = manager.resources

    audio_file = settings.podcasts_dir / "desync.mp3"
    audio_file.write_bytes(b"desync audio")

    with db.connect(write=True) as conn:
        conn.execute(
            "UPDATE podcast_episodes SET local_path=?, download_status='downloaded' WHERE id='ep-east'",
            (str(audio_file),),
        )
        conn.execute(
            "INSERT INTO podcast_episode_favorites(user_id, episode_id, created_at) VALUES ('admin', 'ep-east', '2026-01-01')"
        )
        # Corrupt zero_since to 50 days ago
        conn.execute(
            "INSERT OR REPLACE INTO podcast_resource_state(episode_id, protected, zero_since) VALUES ('ep-east', 0, ?)",
            (time.time() - 50 * 86400,),
        )

    # Trigger synchronize
    with db.connect(write=True) as conn:
        store.synchronize(conn)
        healed_zero_since = conn.execute(
            "SELECT zero_since FROM podcast_resource_state WHERE episode_id='ep-east'"
        ).fetchone()[0]
        assert healed_zero_since is None, (
            f"synchronize() did not heal zero_since to NULL! Got {healed_zero_since}"
        )

    # Ensure cleanup skips it
    assert store.cleanup(dry_run=False)["deleted_count"] == 0
    assert audio_file.is_file()


def test_user_deletion_cascade_unprotects_episode_properly(adversarial_setup):
    """Adversarial Challenge 8:
    Episode favorited only by a temporary user.
    When that user is deleted, ON DELETE CASCADE removes the favorite row.
    Subsequent synchronize() and cleanup() handle the state cleanly.
    """
    owner, user1, _, manager, db, u1_id, _, settings = adversarial_setup
    store = manager.resources

    audio_file = settings.podcasts_dir / "user_cascade.mp3"
    audio_file.write_bytes(b"user cascade audio")

    with db.connect(write=True) as conn:
        conn.execute(
            "UPDATE podcast_episodes SET local_path=?, download_status='downloaded' WHERE id='ep-east'",
            (str(audio_file),),
        )
        store.downloaded(conn, "ep-east")

    # Favorite only by user1
    user1.put(
        "/api/v1/podcasts/episodes/ep-east/favorite", headers=HEADERS, json={"favorite": True}
    )
    assert store.cleanup()["candidate_count"] == 0

    # Delete user1 from the users table (simulating account removal)
    with db.connect(write=True) as conn:
        conn.execute("DELETE FROM users WHERE id=?", (u1_id,))
        # Verify cascade removed favorite
        fav_count = conn.execute(
            "SELECT count(*) FROM podcast_episode_favorites WHERE episode_id='ep-east'"
        ).fetchone()[0]
        assert fav_count == 0

    # Manual cleanup now sees 1 candidate and cleans it up cleanly without crashes
    clean_res = store.cleanup(dry_run=False, automatic=False)
    assert clean_res["deleted_count"] == 1
    assert not audio_file.exists()


def test_idempotent_favorite_and_unfavorite(adversarial_setup):
    """Adversarial Challenge 9:
    Idempotency:
    - Repeated favorite=True does not crash or corrupt state
    - Repeated favorite=False does not advance zero_since timestamp to a later time
    """
    owner, user1, _, manager, db, _, _, settings = adversarial_setup
    store = manager.resources

    audio_file = settings.podcasts_dir / "idempotent.mp3"
    audio_file.write_bytes(b"idempotent audio")

    with db.connect(write=True) as conn:
        conn.execute(
            "UPDATE podcast_episodes SET local_path=?, download_status='downloaded' WHERE id='ep-east'",
            (str(audio_file),),
        )
        store.downloaded(conn, "ep-east")

    # Double favorite
    res1 = user1.put(
        "/api/v1/podcasts/episodes/ep-east/favorite", headers=HEADERS, json={"favorite": True}
    )
    res2 = user1.put(
        "/api/v1/podcasts/episodes/ep-east/favorite", headers=HEADERS, json={"favorite": True}
    )
    assert res1.status_code == 200 and res2.status_code == 200

    with db.connect() as conn:
        assert (
            conn.execute(
                "SELECT count(*) FROM podcast_episode_favorites WHERE episode_id='ep-east'"
            ).fetchone()[0]
            == 1
        )
        assert (
            conn.execute(
                "SELECT zero_since FROM podcast_resource_state WHERE episode_id='ep-east'"
            ).fetchone()[0]
            is None
        )

    # First unfavorite
    res3 = user1.put(
        "/api/v1/podcasts/episodes/ep-east/favorite", headers=HEADERS, json={"favorite": False}
    )
    assert res3.status_code == 200
    with db.connect() as conn:
        first_zero_since = conn.execute(
            "SELECT zero_since FROM podcast_resource_state WHERE episode_id='ep-east'"
        ).fetchone()[0]
        assert first_zero_since is not None

    time.sleep(0.05)

    # Second unfavorite (already unfavorited)
    res4 = user1.put(
        "/api/v1/podcasts/episodes/ep-east/favorite", headers=HEADERS, json={"favorite": False}
    )
    assert res4.status_code == 200
    with db.connect() as conn:
        second_zero_since = conn.execute(
            "SELECT zero_since FROM podcast_resource_state WHERE episode_id='ep-east'"
        ).fetchone()[0]
        # zero_since must NOT have been updated or overwritten (COALESCE preserves existing timestamp)
        assert second_zero_since == first_zero_since, (
            f"Repeated unfavorite must not advance zero_since timestamp! ({first_zero_since} != {second_zero_since})"
        )


def test_concurrent_favorite_during_cleanup_traversal_simulation(adversarial_setup):
    """Adversarial Challenge 10:
    Race condition simulation:
    Snapshot in cleanup() is captured while favorite_count == 0.
    Before the inner writer transaction is entered for that candidate, a user favorites the episode.
    When inner transaction acquires BEGIN IMMEDIATE and re-reads aliases, favorite_count is 1.
    Cleanup must abort unlinking and keep the file safe.
    """
    owner, user1, _, manager, db, _, _, settings = adversarial_setup
    store = manager.resources

    audio_file = settings.podcasts_dir / "race.mp3"
    audio_file.write_bytes(b"race audio payload")

    with db.connect(write=True) as conn:
        conn.execute(
            "UPDATE podcast_episodes SET local_path=?, download_status='downloaded' WHERE id='ep-east'",
            (str(audio_file),),
        )
        store.downloaded(conn, "ep-east")

    # Step 1: Emulate cleanup step 1 (snapshot taken before favorite)
    with db.connect(write=True) as conn:
        store.synchronize(conn)
        snapshot = store.rows(conn)

    candidate_row = next(r for r in snapshot if r["id"] == "ep-east")
    assert candidate_row["favorite_count"] == 0

    # Step 2: Concurrently, user favorites ep-east
    user1.put(
        "/api/v1/podcasts/episodes/ep-east/favorite", headers=HEADERS, json={"favorite": True}
    )

    # Step 3: Emulate cleanup step 2 (inner writer transaction re-reading under lock)
    with db.connect(write=True) as conn:
        conn.execute("BEGIN IMMEDIATE")
        re_read_aliases = store.rows(conn, [candidate_row["local_path"]])
        should_skip = any(r.get("favorite_count", 0) > 0 for r in re_read_aliases)
        assert should_skip is True, (
            "Re-read under writer lock failed to observe concurrent favorite!"
        )

    # And full cleanup call must not delete the file
    assert store.cleanup(dry_run=False)["deleted_count"] == 0
    assert audio_file.is_file()
