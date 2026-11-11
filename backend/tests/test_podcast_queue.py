"""Podcast inbox, play queue and new-episode delivery (contracts/podcast-queue.md)."""

import sqlite3

import pytest

from wildstring.database import SCHEMA_VERSION, Database
from wildstring.podcast_queue import distribute_new_episodes

HEADERS = {"X-Wildstring-Client": "web"}
SHOW = "show-queue"


def add_episode(database, episode_id):
    with database.connect(write=True) as db:
        db.execute(
            """INSERT OR IGNORE INTO podcast_episodes
               (id, podcast_id, guid, title, audio_url, pub_date, created_at)
               VALUES (?,?,?,?,?,?,?)""",
            (
                episode_id,
                SHOW,
                f"guid-{episode_id}",
                episode_id,
                f"https://example.test/{episode_id}.mp3",
                "2026-01-01",
                "2026-01-01",
            ),
        )


@pytest.fixture
def context(settings, authenticated_client):
    with authenticated_client(settings) as client:
        database = Database(settings.data_dir)
        with database.connect(write=True) as db:
            db.execute(
                """INSERT OR IGNORE INTO podcasts(id, title, author, feed_url, created_at)
                   VALUES (?,?,?,?,?)""",
                (SHOW, "Show", "Author", "https://example.test/queue.xml", "2026-01-01"),
            )
            owner = db.execute("SELECT id FROM users WHERE username='admin'").fetchone()
            if owner is not None:
                db.execute(
                    "INSERT OR IGNORE INTO podcast_user_catalog(user_id,podcast_id) VALUES (?,?)",
                    (owner[0], SHOW),
                )
        for episode_id in ("ep-history-1", "ep-history-2"):
            add_episode(database, episode_id)
        yield client, database


def follow(client, value=True):
    return client.put(f"/api/v1/podcasts/{SHOW}/follow", headers=HEADERS, json={"followed": value})


def inbox(client):
    return client.get("/api/v1/podcasts/inbox", headers=HEADERS).json()["items"]


def queue(client):
    return client.get("/api/v1/podcasts/queue", headers=HEADERS).json()


def set_preference(client, action, auto_limit=3):
    response = client.put(
        "/api/v1/podcasts/queue/preferences",
        headers=HEADERS,
        json={
            "default_action": "inbox",
            "auto_limit": 3,
            "shows": {
                SHOW: {
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


def deliver(database, episode_ids):
    for episode_id in episode_ids:
        add_episode(database, episode_id)
    with database.connect(write=True) as db:
        return distribute_new_episodes(db, SHOW, episode_ids)


def test_schema_49_migrates_and_backfills_baselines(context):
    client, database = context
    assert SCHEMA_VERSION >= 49
    assert follow(client).status_code == 200
    with database.connect() as db:
        tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert {
        "podcast_inbox",
        "podcast_queue_state",
        "podcast_queue_prefs",
        "podcast_inbox_baseline",
    } <= tables
    with sqlite3.connect(database.path) as raw:
        raw.execute("PRAGMA user_version=48")
        raw.execute("DELETE FROM podcast_inbox_baseline")
        raw.commit()
    database.initialize()
    with database.connect() as db:
        assert db.execute("SELECT COUNT(*) FROM podcast_inbox_baseline").fetchone()[0] == 1


def test_follow_does_not_backfill_history(context):
    client, _ = context
    assert follow(client).status_code == 200
    assert inbox(client) == []
    assert queue(client)["items"] == []


def test_new_episode_defaults_to_inbox(context):
    client, database = context
    follow(client)
    assert deliver(database, ["ep-new"]) == 1
    assert [item["episode_id"] for item in inbox(client)] == ["ep-new"]
    assert queue(client)["items"] == []


def test_queue_last_and_queue_next(context):
    client, database = context
    follow(client)
    set_preference(client, "queue_last")
    deliver(database, ["ep-a"])
    assert [item["episode_id"] for item in queue(client)["items"]] == ["ep-a"]
    set_preference(client, "queue_next")
    deliver(database, ["ep-b"])
    items = queue(client)["items"]
    assert [item["episode_id"] for item in items] == ["ep-a", "ep-b"]
    assert all(item["added_at"] for item in items)
    assert items[0]["added_at"] <= items[1]["added_at"]


def test_ignore_delivers_nothing(context):
    client, database = context
    follow(client)
    set_preference(client, "ignore")
    assert deliver(database, ["ep-c"]) == 0
    assert inbox(client) == []
    assert queue(client)["items"] == []


def test_auto_limit_moves_overflow_to_inbox(context):
    client, database = context
    follow(client)
    set_preference(client, "queue_last", auto_limit=1)
    deliver(database, ["ep-1", "ep-2", "ep-3"])
    assert len(queue(client)["items"]) == 1
    assert len(inbox(client)) == 2


def test_queue_version_conflict_and_validation(context):
    client, database = context
    add_episode(database, "ep-valid")
    current = queue(client)
    body = {
        "version": current["version"],
        "device_id": "test-device",
        "items": [{"episode_id": "ep-valid", "origin": "manual"}],
    }
    assert client.put("/api/v1/podcasts/queue", headers=HEADERS, json=body).status_code == 200
    conflict = client.put("/api/v1/podcasts/queue", headers=HEADERS, json=body)
    assert conflict.status_code == 409
    assert conflict.json()["detail"]["code"] == "podcast_queue_conflict"
    stale = client.put(
        "/api/v1/podcasts/queue",
        headers=HEADERS,
        json={
            **body,
            "version": current["version"] + 1,
            "items": [{"episode_id": "missing-episode", "origin": "manual"}],
        },
    )
    assert stale.status_code == 422


def test_inbox_write_does_not_create_follow(context):
    client, database = context
    response = client.put("/api/v1/podcasts/inbox/items/ep-history-1", headers=HEADERS, json={})
    assert response.status_code == 200
    assert [item["episode_id"] for item in inbox(client)] == ["ep-history-1"]
    with database.connect() as db:
        assert db.execute("SELECT COUNT(*) FROM podcast_follows").fetchone()[0] == 0


def test_default_auto_continue_round_trip(context):
    client, _ = context
    saved = client.put(
        "/api/v1/podcasts/queue/preferences",
        headers=HEADERS,
        json={"default_action": "inbox", "auto_limit": 3, "auto_continue": False, "shows": {}},
    )
    assert saved.status_code == 200, saved.text
    body = saved.json()
    assert body["auto_continue"] is False
    assert body["default_action"] == "inbox"
    again = client.get("/api/v1/podcasts/queue/preferences", headers=HEADERS)
    assert again.json()["auto_continue"] is False
    # A later show update must not reset the account default.
    kept = client.put(
        "/api/v1/podcasts/queue/preferences",
        headers=HEADERS,
        json={
            "default_action": "queue_last",
            "auto_limit": 2,
            "auto_continue": False,
            "shows": {
                SHOW: {
                    "action": "ignore",
                    "auto_limit": 1,
                    "order": "asc",
                    "skip_completed": False,
                    "auto_continue": False,
                }
            },
        },
    )
    assert kept.status_code == 200, kept.text
    assert kept.json()["auto_continue"] is False
    assert kept.json()["shows"][SHOW]["action"] == "ignore"
    assert kept.json()["shows"][SHOW]["order"] == "asc"
    cleared = client.put(
        "/api/v1/podcasts/queue/preferences",
        headers=HEADERS,
        json={"default_action": "inbox", "auto_limit": 3, "auto_continue": False, "shows": {}},
    )
    assert cleared.status_code == 200, cleared.text
    assert cleared.json()["auto_continue"] is False
    assert cleared.json()["shows"] == {}


def test_unavailable_episode_rejected(context):
    client, _ = context
    response = client.put("/api/v1/podcasts/inbox/items/does-not-exist", headers=HEADERS, json={})
    assert response.status_code == 422


def test_queue_put_stamps_preserves_added_at_and_drains_inbox(context):
    client, database = context
    follow(client)
    for episode_id in ("ep-join-1", "ep-join-2"):
        add_episode(database, episode_id)

    version = queue(client)["version"]
    saved = client.put(
        "/api/v1/podcasts/queue",
        headers=HEADERS,
        json={
            "version": version,
            "device_id": "web",
            "items": [{"episode_id": "ep-join-1"}, {"episode_id": "ep-join-2"}],
        },
    ).json()
    stamps = [item["added_at"] for item in saved["items"]]
    assert all(stamps)
    assert stamps[0] <= stamps[1]

    reordered = client.put(
        "/api/v1/podcasts/queue",
        headers=HEADERS,
        json={
            "version": saved["version"],
            "device_id": "web",
            "items": [
                {"episode_id": "ep-join-2", "origin": "manual", "added_at": stamps[1]},
                {"episode_id": "ep-join-1", "origin": "manual", "added_at": stamps[0]},
            ],
        },
    ).json()
    assert [item["added_at"] for item in reordered["items"]] == [stamps[1], stamps[0]]

    client.put("/api/v1/podcasts/inbox/items/ep-join-2", headers=HEADERS)
    assert "ep-join-2" in [item["episode_id"] for item in inbox(client)]
    client.put(
        "/api/v1/podcasts/queue",
        headers=HEADERS,
        json={
            "version": reordered["version"],
            "device_id": "web",
            "items": [
                {"episode_id": "ep-join-2", "origin": "manual", "added_at": stamps[1]},
                {"episode_id": "ep-join-1", "origin": "manual", "added_at": stamps[0]},
            ],
        },
    )
    assert "ep-join-2" not in [item["episode_id"] for item in inbox(client)]


def test_queue_put_accepts_null_added_at_and_preserves_manual_order(context):
    client, database = context
    for episode_id in ("ep-null-1", "ep-null-2"):
        add_episode(database, episode_id)

    version = queue(client)["version"]
    response = client.put(
        "/api/v1/podcasts/queue",
        headers={"X-Wildstring-Client": "android"},
        json={
            "version": version,
            "device_id": "android-phone",
            "items": [
                {"episode_id": "ep-null-1", "origin": "manual", "added_at": None},
                {"episode_id": "ep-null-2", "origin": "manual", "added_at": None},
            ],
        },
    )
    assert response.status_code == 200, response.text
    saved = response.json()
    assert [item["episode_id"] for item in saved["items"]] == ["ep-null-1", "ep-null-2"]
    assert all(item["added_at"] for item in saved["items"])

    reordered = client.put(
        "/api/v1/podcasts/queue",
        headers={"X-Wildstring-Client": "android"},
        json={
            "version": saved["version"],
            "device_id": "android-phone",
            "items": [
                {
                    "episode_id": "ep-null-2",
                    "origin": "manual",
                    "added_at": saved["items"][1]["added_at"],
                },
                {
                    "episode_id": "ep-null-1",
                    "origin": "manual",
                    "added_at": None,
                },
            ],
        },
    )
    assert reordered.status_code == 200, reordered.text
    loaded = queue(client)
    assert [item["episode_id"] for item in loaded["items"]] == ["ep-null-2", "ep-null-1"]
    assert loaded["items"][1]["added_at"] == saved["items"][0]["added_at"]
