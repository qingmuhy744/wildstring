"""Policies, access and reference origins remain independent across accounts."""

import time

import pytest
from fastapi.testclient import TestClient
from migration_support import pre40
from test_podcast_follows import HEADERS
from test_podcast_publishers import seed

from wildstring.database import SCHEMA_VERSION, Database
from wildstring.podcast_download_settings import ordered_episodes

ROOT = "/api/v1/podcasts"


@pytest.fixture
def personal(settings, authenticated_client, monkeypatch):
    with authenticated_client(settings) as owner:
        manager = owner.app.state.podcasts
        db = Database(settings.data_dir)
        seed(db)
        queued = []
        monkeypatch.setattr(
            manager, "queue_download_episode", lambda identity: queued.append(identity) or True
        )
        created = owner.post(
            "/api/v1/manage/users",
            headers=HEADERS,
            json={
                "username": "private-listener",
                "password": "private-listener-password",
                "library_ids": [],
            },
        ).json()
        other = TestClient(owner.app)
        assert (
            other.post(
                "/api/v1/auth/login",
                headers=HEADERS,
                json={"username": "private-listener", "password": "private-listener-password"},
            ).status_code
            == 200
        )
        try:
            yield owner, other, manager, db, created["id"], queued
        finally:
            other.close()


def associate(db, user_id):
    with db.connect(write=True) as conn:
        conn.execute("INSERT OR IGNORE INTO podcast_user_catalog VALUES (?, 'east')", (user_id,))
        conn.execute(
            "INSERT OR IGNORE INTO podcast_follows VALUES (?, 'east', CURRENT_TIMESTAMP)",
            (user_id,),
        )


def episodes(db):
    with db.connect(write=True) as conn:
        conn.execute("DELETE FROM podcast_episodes WHERE podcast_id='east'")
        for number in range(6, 0, -1):
            date = (
                f"2026-10-{number:02}T12:00:00Z"
                if number % 2
                else f"0{number} Oct 2026 12:00:00 GMT"
            )
            conn.execute(
                """INSERT INTO podcast_episodes(id,podcast_id,guid,title,audio_url,pub_date,created_at)
                VALUES (?,'east',?,?,'https://audio.example.com/test.mp3',?,'2026-10-10')""",
                (f"e{number}", str(number), str(number), date),
            )


def policy(client, download="none", retention="keep", version=None):
    endpoint = f"{ROOT}/east/download-settings"
    current = client.get(endpoint)
    assert current.status_code == 200, current.text
    return client.put(
        endpoint,
        headers=HEADERS,
        json={
            "version": version or current.json()["version"],
            "download_policy": download,
            "retention_policy": retention,
        },
    )


def references(db, user):
    with db.connect() as conn:
        return {
            r[0]: (r[1], r[2])
            for r in conn.execute(
                "SELECT episode_id,manual,automatic FROM podcast_resource_refs WHERE user_id=?",
                (user,),
            )
        }


def test_ordinary_account_cannot_read_or_bootstrap_another_catalogue(personal):
    owner, listener, _, db, user, _ = personal
    publisher = owner.put(
        f"{ROOT}/east/publisher", headers=HEADERS, json={"version": 1, "name": "Private studio"}
    ).json()["podcast"]["publisher"]["id"]
    assert listener.get(ROOT).json() == []
    assert listener.get(f"{ROOT}?followed=false").json() == []
    assert listener.get(f"{ROOT}/publishers").json() == []
    for path in (
        "/east",
        "/east/download-settings",
        "/episodes/ep-east",
        "/episodes/ep-east/stream?cache=1",
        "/episodes/ep-east/progress",
        f"/publishers/{publisher}",
    ):
        assert listener.get(ROOT + path, follow_redirects=False).status_code == 404, path
    assert (
        listener.put(f"{ROOT}/east/follow", headers=HEADERS, json={"followed": True}).status_code
        == 404
    )
    assert listener.post(f"{ROOT}/episodes/ep-east/download", headers=HEADERS).status_code == 404
    assert (
        listener.put(
            f"{ROOT}/east/download-settings",
            headers=HEADERS,
            json={"version": 1, "download_policy": "all"},
        ).status_code
        == 404
    )
    assert (
        listener.put(
            f"{ROOT}/episodes/ep-east/progress",
            headers=HEADERS,
            json={
                "session_id": "private-listening-session",
                "device_id": "phone",
                "base_version": 0,
                "sequence": 1,
                "position_seconds": 1,
                "duration_seconds": 30,
                "event": "play",
            },
        ).status_code
        == 404
    )
    assert len(owner.get(ROOT).json()) == 3
    with db.connect() as conn:
        assert not conn.execute(
            "SELECT 1 FROM podcast_user_catalog WHERE user_id=?", (user,)
        ).fetchone()
    associate(db, user)
    assert [p["id"] for p in listener.get(ROOT).json()] == ["east"]
    assert listener.get(f"{ROOT}/east").status_code == 200
    assert listener.get(f"{ROOT}/publishers/{publisher}").json()["publisher"]["podcast_count"] == 1


def test_stale_client_account_binding_cannot_read_or_write_new_session(personal):
    _, listener, manager, db, user, _ = personal
    associate(db, user)
    endpoint = f"{ROOT}/east/download-settings"
    stale = {**HEADERS, "X-Wildstring-Account": "admin"}
    assert listener.get(endpoint, headers=stale).status_code == 401
    assert (
        listener.put(
            endpoint, headers=stale, json={"version": 1, "download_policy": "all"}
        ).status_code
        == 401
    )
    assert manager.auto_downloads.settings(user, "east")["version"] == 1
    assert (
        listener.get(endpoint, headers={**HEADERS, "X-Wildstring-Account": user}).status_code == 200
    )


def test_fixed_latest_window_shared_audio_and_private_versions(personal, settings):
    owner, listener, manager, db, user, queued = personal
    associate(db, "admin")
    associate(db, user)
    episodes(db)
    assert policy(listener, "latest_3").status_code == 200
    assert queued == ["e6", "e5", "e4"]
    for identity in queued[:]:
        path = settings.podcasts_dir / f"{identity}.mp3"
        path.write_bytes(b"shared audio")
        with db.connect(write=True) as conn:
            conn.execute(
                "UPDATE podcast_episodes SET local_path=?,download_status='downloaded' WHERE id=?",
                (str(path), identity),
            )
    queued.clear()
    assert manager.auto_downloads.reconcile_all() == 0
    assert queued == []
    assert set(references(db, user)) == {"e6", "e5", "e4"}
    assert policy(owner, "latest_5").status_code == 200
    assert queued == ["e3", "e2"]
    assert manager.auto_downloads.settings(user, "east")["download_policy"] == "latest_3"
    assert policy(listener, "all", version=1).status_code == 409
    assert (
        listener.put(
            f"{ROOT}/east/download-settings",
            headers=HEADERS,
            json={"version": 2, "download_policy": "all", "user_id": "admin"},
        ).status_code
        == 422
    )
    assert len(references(db, "admin")) == 5
    assert len(references(db, user)) == 3
    with db.connect() as conn:
        assert [r["id"] for r in ordered_episodes(conn, "east")] == [
            f"e{n}" for n in range(6, 0, -1)
        ]
    # Missing/empty cached files are retried inside the same fixed window.
    (settings.podcasts_dir / "e6.mp3").write_bytes(b"")
    queued.clear()
    manager.auto_downloads.reconcile(user, "east")
    assert queued == ["e6"]


def test_private_unplayed_retention_manual_refs_and_unfollow(personal):
    owner, listener, manager, db, user, _ = personal
    associate(db, "admin")
    associate(db, user)
    episodes(db)
    assert policy(owner, "all").status_code == 200
    assert policy(listener, "latest_3", "delete_after_played").status_code == 200
    saved = listener.post(f"{ROOT}/episodes/e6/download", headers=HEADERS)
    assert saved.status_code == 200
    assert references(db, user)["e6"] == (1, 1)
    completed = listener.put(
        f"{ROOT}/episodes/e6/progress",
        headers=HEADERS,
        json={
            "session_id": "private-retention-session",
            "device_id": "phone",
            "base_version": 0,
            "sequence": 1,
            "position_seconds": 30,
            "duration_seconds": 30,
            "event": "ended",
        },
    )
    assert completed.status_code == 200
    assert references(db, user) == {"e6": (1, 0), "e5": (0, 1), "e4": (0, 1)}
    assert references(db, "admin")["e6"] == (0, 1)
    assert listener.get(f"{ROOT}/episodes/e5").json()["resource_automatic"]
    assert listener.delete(f"{ROOT}/episodes/e5/download", headers=HEADERS).status_code == 200
    assert references(db, user)["e5"] == (0, 1)
    assert (
        listener.put(f"{ROOT}/east/follow", headers=HEADERS, json={"followed": False}).status_code
        == 200
    )
    assert references(db, user) == {"e6": (1, 0)}
    assert listener.get(f"{ROOT}/east/download-settings").json()["active"] is False
    assert policy(listener, "all").status_code == 409
    assert (
        listener.put(f"{ROOT}/east/follow", headers=HEADERS, json={"followed": True}).status_code
        == 200
    )
    assert set(references(db, user)) == {"e6", "e5", "e4"}
    assert policy(listener, "unplayed").status_code == 200
    assert set(references(db, user)) == {f"e{n}" for n in range(1, 7)}  # e6 retained manually
    assert policy(listener).status_code == 200
    assert references(db, user) == {"e6": (1, 0)}
    with db.connect(write=True) as conn:
        conn.execute("UPDATE users SET enabled=0 WHERE id='admin'")
    manager.auto_downloads.reconcile_all()
    assert references(db, "admin") == {}
    assert references(db, user) == {"e6": (1, 0)}


def test_schema39_upgrade_preserves_associations_policies_and_manual_resources(personal, settings):
    _, _, manager, db, user, _ = personal
    associate(db, user)
    path = settings.podcasts_dir / "migration.mp3"
    path.write_bytes(b"legacy audio")
    with db.connect(write=True) as conn:
        pre40(conn)
        conn.execute(
            "UPDATE podcasts SET download_policy='latest_5',retention_policy='delete_after_played' WHERE id='east'"
        )
        conn.execute(
            "INSERT INTO podcast_resource_refs(user_id,episode_id,created_at) VALUES ('admin','ep-coffee',?)",
            (time.time(),),
        )
        conn.execute(
            "INSERT INTO podcast_progress(user_id,episode_id,position_seconds,last_listened_at) VALUES (?, 'ep-other', 42, CURRENT_TIMESTAMP)",
            (user,),
        )
        conn.execute(
            "UPDATE podcast_episodes SET local_path=?,download_status='downloaded' WHERE id='ep-coffee'",
            (str(path),),
        )
        conn.execute("PRAGMA user_version=39")
    db.initialize()
    assert manager.auto_downloads.settings(user, "east")["download_policy"] == "latest_5"
    assert manager.auto_downloads.settings("admin", "east")["download_policy"] == "none"
    assert references(db, "admin") == {"ep-coffee": (1, 0)}
    with db.connect() as conn:
        assert conn.execute("PRAGMA user_version").fetchone()[0] == SCHEMA_VERSION
        assert {
            r[0]
            for r in conn.execute(
                "SELECT podcast_id FROM podcast_user_catalog WHERE user_id=?", (user,)
            )
        } == {"east", "other"}
        assert conn.execute(
            "SELECT 1 FROM podcast_user_catalog WHERE user_id='admin' AND podcast_id='coffee'"
        ).fetchone()
        assert (
            conn.execute(
                "SELECT position_seconds FROM podcast_progress WHERE user_id=?", (user,)
            ).fetchone()[0]
            == 42
        )
        assert conn.execute(
            "SELECT local_path FROM podcast_episodes WHERE id='ep-coffee'"
        ).fetchone()[0] == str(path)
    assert path.read_bytes() == b"legacy audio"


def test_two_personal_policies_use_one_download_task_per_episode(personal, settings):
    from wildstring.podcast_download_settings import DownloadSettingsUpdate
    from wildstring.podcasts import PodcastManager

    _, _, _, db, user, _ = personal
    associate(db, "admin")
    associate(db, user)
    episodes(db)
    manager = PodcastManager(db, storage_dir=settings.podcasts_dir)
    body = DownloadSettingsUpdate(version=1, download_policy="latest_3")
    manager.auto_downloads.configure("admin", "east", body)
    manager.auto_downloads.configure(user, "east", body)
    assert manager._download_queue.qsize() == 3
    assert set(manager._queued_episodes) == {"e6", "e5", "e4"}
    manager.auto_downloads.reconcile_all()
    assert manager._download_queue.qsize() == 3
    with db.connect() as conn:
        assert conn.execute("SELECT count(*) FROM podcast_resource_refs").fetchone()[0] == 6
    assert manager.auto_downloads.settings(user, "east")["download_policy"] == "latest_3"


def test_playback_cache_is_personal_when_reusing_audio_and_remains_collectable(personal, settings):
    owner, listener, manager, db, user, _ = personal
    associate(db, user)
    path = settings.podcasts_dir / "playback-cache.mp3"
    path.write_bytes(b"shared playback audio")
    with db.connect(write=True) as conn:
        conn.execute(
            "UPDATE podcast_episodes SET local_path=?,download_status='downloaded' WHERE id='ep-east'",
            (str(path),),
        )
    current = listener.get(f"{ROOT}/playback-settings").json()
    assert (
        listener.put(
            f"{ROOT}/playback-settings",
            headers=HEADERS,
            json={
                "version": current["version"],
                "auto_cache_current": True,
                "prefetch_next": False,
                "network_policy": "any",
            },
        ).status_code
        == 200
    )
    endpoint = f"{ROOT}/episodes/ep-east"
    assert listener.get(endpoint + "/stream").status_code == 200
    assert not listener.get(endpoint).json()["resource_playback_cached"]
    response = listener.get(endpoint + "/stream?cache=1&network=unknown")
    assert response.status_code == 200 and response.content == path.read_bytes()
    assert listener.get(endpoint).json()["resource_playback_cached"]
    assert listener.get(f"{ROOT}/east").json()["episodes"][0]["resource_playback_cached"]
    assert not owner.get(endpoint).json()["resource_playback_cached"]
    assert references(db, user) == {}
    assert manager.resources.cleanup(dry_run=False)["deleted_count"] == 1
    assert not path.exists()
    assert not listener.get(endpoint).json()["resource_playback_cached"]


@pytest.mark.parametrize(
    ("enabled", "policy", "network"),
    [(False, "any", "wifi"), (True, "off", "wifi"), (True, "wifi", "cellular")],
)
def test_playback_cache_does_not_claim_downloads_when_disallowed(
    personal, settings, enabled, policy, network
):
    _, listener, _, db, user, queued = personal
    associate(db, user)
    path = settings.podcasts_dir / "existing.mp3"
    path.write_bytes(b"existing audio")
    with db.connect(write=True) as conn:
        conn.execute(
            "UPDATE podcast_episodes SET local_path=?,download_status='downloaded' WHERE id='ep-east'",
            (str(path),),
        )
    current = listener.get(f"{ROOT}/playback-settings").json()
    assert (
        listener.put(
            f"{ROOT}/playback-settings",
            headers=HEADERS,
            json={
                "version": current["version"],
                "auto_cache_current": enabled,
                "prefetch_next": False,
                "network_policy": policy,
            },
        ).status_code
        == 200
    )
    endpoint = f"{ROOT}/episodes/ep-east"
    assert listener.get(endpoint + f"/stream?cache=1&network={network}").status_code == 200
    assert not listener.get(endpoint).json()["resource_playback_cached"]
    assert queued == []


def test_playback_cache_and_next_episode_share_tasks_but_track_each_account(personal, settings):
    from wildstring.podcasts import PodcastManager

    _, _, _, db, user, _ = personal
    associate(db, user)
    episodes(db)
    with db.connect(write=True) as conn:
        for number in range(1, 7):
            conn.execute(
                "UPDATE podcast_episodes SET created_at=? WHERE id=?",
                (f"2026-10-{number:02}T12:00:00Z", f"e{number}"),
            )
    manager = PodcastManager(db, storage_dir=settings.podcasts_dir)
    for account in ("admin", user):
        current = manager.playback_settings(account)
        manager.update_playback_settings(
            account,
            version=current["version"],
            auto_cache_current=True,
            prefetch_next=True,
            network_policy="any",
        )
    assert manager.queue_playback_cache("e6", user, "wifi") == 2
    assert manager.resources.playback_ids(user) == {"e6", "e5"}
    assert manager.resources.playback_ids("admin") == set()
    assert manager.queue_playback_cache("e6", "admin", "wifi") == 0
    assert manager.resources.playback_ids("admin") == {"e6", "e5"}
    assert manager._download_queue.qsize() == 2
    assert references(db, user) == references(db, "admin") == {}


def test_schema40_upgrade_preserves_downloads_without_guessing_cache_owner(personal, settings):
    _, _, _, db, user, _ = personal
    associate(db, user)
    path = settings.podcasts_dir / "pre41.mp3"
    path.write_bytes(b"existing shared audio")
    with db.connect(write=True) as conn:
        conn.execute("DROP TABLE podcast_playback_cache")
        conn.execute("PRAGMA user_version=40")
        conn.execute(
            "UPDATE podcast_episodes SET local_path=?,download_status='downloaded' WHERE id='ep-east'",
            (str(path),),
        )
        conn.execute(
            "INSERT INTO podcast_resource_refs(user_id,episode_id,created_at,manual,automatic) VALUES (?,'ep-east',?,1,1)",
            (user, time.time()),
        )
    db.initialize()
    db.initialize()
    with db.connect() as conn:
        assert conn.execute("PRAGMA user_version").fetchone()[0] == SCHEMA_VERSION
        assert conn.execute("SELECT count(*) FROM podcast_playback_cache").fetchone()[0] == 0
        assert conn.execute(
            "SELECT local_path,download_status FROM podcast_episodes WHERE id='ep-east'"
        ).fetchone()[:] == (str(path), "downloaded")
    assert references(db, user) == {"ep-east": (1, 1)}
    assert path.read_bytes() == b"existing shared audio"


def test_explicit_bulk_downloads_belong_to_requester_including_existing_audio(personal, settings):
    owner, listener, manager, db, user, queued = personal
    associate(db, user)
    episodes(db)
    path = settings.podcasts_dir / "bulk-existing.mp3"
    path.write_bytes(b"existing audio")
    with db.connect(write=True) as conn:
        conn.execute(
            "UPDATE podcast_episodes SET local_path=?,download_status='downloaded' WHERE id='e6'",
            (str(path),),
        )
    endpoint = f"{ROOT}/east/download-all"
    assert listener.post(endpoint, headers=HEADERS).status_code == 403
    response = owner.post(endpoint, headers=HEADERS)
    assert response.status_code == 200 and response.json()["queued_episodes"] == 5
    assert queued == [f"e{n}" for n in range(5, 0, -1)]
    assert references(db, "admin") == {f"e{n}": (1, 0) for n in range(1, 7)}
    assert references(db, user) == {}
    assert path.read_bytes() == b"existing audio"
    assert manager.resources.cleanup()["candidate_count"] == 0
