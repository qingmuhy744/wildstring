"""Podcast inbox, play queue and new-episode delivery (contracts/podcast-queue.md)."""

import sqlite3

import pytest

from wildstring.database import SCHEMA_VERSION, Database
from wildstring.podcast_queue import distribute_new_episodes

HEADERS = {"X-Wildstring-Client": "web"}
SHOW = "show-queue"


def add_episode(database, episode_id, pub_date="2026-01-01"):
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
                pub_date,
                pub_date,
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


def queue(client):
    return client.get("/api/v1/podcasts/queue", headers=HEADERS).json()


def set_preference(client, action, auto_limit=3):
    response = client.put(
        "/api/v1/podcasts/queue/preferences",
        headers=HEADERS,
        json={
            "default_action": "queue_last",
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


def deliver(database, episode_ids, pub_dates=None):
    for index, episode_id in enumerate(episode_ids):
        pub_date = "2026-01-01" if not pub_dates else pub_dates[index]
        add_episode(database, episode_id, pub_date)
    with database.connect(write=True) as db:
        return distribute_new_episodes(db, SHOW, episode_ids)


def test_schema_49_migrates_and_backfills_baselines(context):
    client, database = context
    assert SCHEMA_VERSION >= 49
    assert follow(client).status_code == 200
    with database.connect() as db:
        tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert "podcast_inbox" not in tables
    assert {
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
    assert queue(client)["items"] == []


def test_new_episode_defaults_to_queue_tail(context):
    client, database = context
    follow(client)
    assert deliver(database, ["ep-new"]) == 1
    assert [item["episode_id"] for item in queue(client)["items"]] == ["ep-new"]
    assert queue(client)["notice"] == ""


def test_queue_last_and_queue_next_order_a_batch_by_publish_time(context):
    client, database = context
    follow(client)
    set_preference(client, "queue_last")
    deliver(
        database,
        ["ep-new", "ep-old", "ep-mid"],
        [
            "Wed, 03 Jun 2026 12:00:00 GMT",
            "Mon, 01 Jun 2026 12:00:00 GMT",
            "Tue, 02 Jun 2026 12:00:00 GMT",
        ],
    )
    assert [item["episode_id"] for item in queue(client)["items"]] == ["ep-old", "ep-mid", "ep-new"]
    set_preference(client, "queue_next")
    deliver(
        database,
        ["ep-newer", "ep-newest"],
        ["Thu, 04 Jun 2026 12:00:00 GMT", "Fri, 05 Jun 2026 12:00:00 GMT"],
    )
    items = queue(client)["items"]
    assert [item["episode_id"] for item in items] == [
        "ep-newest",
        "ep-newer",
        "ep-old",
        "ep-mid",
        "ep-new",
    ]
    assert all(item["added_at"] for item in items)


def test_ignore_delivers_nothing(context):
    client, database = context
    follow(client)
    set_preference(client, "ignore")
    assert deliver(database, ["ep-c"]) == 0
    assert queue(client)["items"] == []


def test_global_cap_refuses_auto_enqueue(context, monkeypatch):
    client, database = context
    follow(client)
    set_preference(client, "queue_last")
    monkeypatch.setattr("wildstring.podcast_queue.QUEUE_CAP", 1)
    assert deliver(database, ["ep-1"]) == 1
    assert deliver(database, ["ep-2", "ep-3"]) == 0
    body = queue(client)
    assert [item["episode_id"] for item in body["items"]] == ["ep-1"]
    assert body["notice"] == "queue_full"


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


def test_queue_write_does_not_create_follow(context):
    client, database = context
    current = queue(client)
    response = client.put(
        "/api/v1/podcasts/queue",
        headers=HEADERS,
        json={
            "version": current["version"],
            "device_id": "test",
            "items": [{"episode_id": "ep-history-1", "origin": "manual"}],
        },
    )
    assert response.status_code == 200
    assert [item["episode_id"] for item in response.json()["items"]] == ["ep-history-1"]
    with database.connect() as db:
        assert db.execute("SELECT COUNT(*) FROM podcast_follows").fetchone()[0] == 0


def test_default_auto_continue_round_trip(context):
    client, _ = context
    saved = client.put(
        "/api/v1/podcasts/queue/preferences",
        headers=HEADERS,
        json={"default_action": "queue_last", "auto_limit": 3, "auto_continue": False, "shows": {}},
    )
    assert saved.status_code == 200, saved.text
    body = saved.json()
    assert body["auto_continue"] is False
    assert body["default_action"] == "queue_last"
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
        json={"default_action": "queue_last", "auto_limit": 3, "auto_continue": False, "shows": {}},
    )
    assert cleared.status_code == 200, cleared.text
    assert cleared.json()["auto_continue"] is False
    assert cleared.json()["shows"] == {}


def test_unavailable_episode_rejected(context):
    client, _ = context
    current = queue(client)
    response = client.put(
        "/api/v1/podcasts/queue",
        headers=HEADERS,
        json={
            "version": current["version"],
            "items": [{"episode_id": "does-not-exist", "origin": "manual"}],
        },
    )
    assert response.status_code == 422


def test_queue_put_stamps_and_preserves_added_at(context):
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


def test_inbox_rows_migrate_onto_the_queue_tail(context):
    _client, database = context
    with database.connect(write=True) as db:
        owner = db.execute("SELECT id FROM users WHERE username='admin'").fetchone()[0]
        db.execute(
            """CREATE TABLE podcast_inbox (
                user_id TEXT NOT NULL, episode_id TEXT NOT NULL, podcast_id TEXT NOT NULL,
                source TEXT NOT NULL DEFAULT 'manual', added_at TEXT NOT NULL,
                PRIMARY KEY(user_id, episode_id))"""
        )
        db.execute(
            """INSERT INTO podcast_inbox(user_id, episode_id, podcast_id, source, added_at)
               VALUES (?,?,?,?,?), (?,?,?,?,?)""",
            (
                owner,
                "ep-history-1",
                SHOW,
                "rule",
                "2026-02-01T00:00:00+00:00",
                owner,
                "ep-history-2",
                SHOW,
                "manual",
                "2026-02-02T00:00:00+00:00",
            ),
        )
        db.execute(
            """INSERT INTO podcast_queue_prefs
               (user_id, podcast_id, action, auto_limit, episode_order, skip_completed, auto_continue)
               VALUES (?,?,?,?,?,?,?)""",
            (owner, SHOW, "inbox", 3, "follow", 1, 1),
        )
        db.execute("PRAGMA user_version=51")
    database.initialize()
    body = queue(_client)
    assert [item["episode_id"] for item in body["items"]] == ["ep-history-1", "ep-history-2"]
    assert [item["origin"] for item in body["items"]] == ["rule", "manual"]
    prefs = _client.get("/api/v1/podcasts/queue/preferences", headers=HEADERS).json()
    assert prefs["shows"][SHOW]["action"] == "queue_last"
    with database.connect() as db:
        tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        assert "podcast_inbox" not in tables
        assert db.execute("SELECT COUNT(*) FROM podcast_inbox_baseline").fetchone()[0] == 0


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
