"""Follows are personal; cached programme content is shared and retained safely."""

import pytest
from fastapi.testclient import TestClient
from test_podcast_publishers import seed

from wildstring.database import Database

HEADERS = {"X-Wildstring-Client": "web"}


@pytest.fixture
def followers(settings, authenticated_client):
    with authenticated_client(settings) as client:
        database = Database(settings.data_dir)
        seed(database)
        user = client.post(
            "/api/v1/manage/users",
            headers=HEADERS,
            json={
                "username": "podcast-listener",
                "password": "podcast-listener-password",
                "library_ids": [],
            },
        )
        assert user.status_code == 201
        with database.connect(write=True) as db:
            db.execute("INSERT INTO podcast_user_catalog VALUES (?,?)", (user.json()["id"], "east"))
        other = TestClient(client.app)
        assert (
            other.post(
                "/api/v1/auth/login",
                headers=HEADERS,
                json={"username": "podcast-listener", "password": "podcast-listener-password"},
            ).status_code
            == 200
        )
        try:
            yield client, other, database
        finally:
            other.close()


def following(client, value=True):
    return client.put("/api/v1/podcasts/east/follow", headers=HEADERS, json={"followed": value})


def complete(client):
    return client.put(
        "/api/v1/podcasts/episodes/ep-east/progress",
        headers=HEADERS,
        json={
            "session_id": "test-listening-session",
            "device_id": "test-device",
            "base_version": 0,
            "sequence": 1,
            "position_seconds": 3600,
            "duration_seconds": 3600,
            "event": "ended",
        },
    )


def test_follow_is_idempotent_personal_and_does_not_copy_programmes(followers):
    client, other, database = followers
    assert other.get("/api/v1/podcasts?followed=true").json() == []
    assert following(other).status_code == 200
    assert following(other).status_code == 200
    assert [p["id"] for p in other.get("/api/v1/podcasts?followed=true").json()] == ["east"]
    assert client.get("/api/v1/podcasts?followed=true").json() == []
    assert len(other.get("/api/v1/podcasts").json()) == 1
    assert len(other.get("/api/v1/podcasts/east").json()["episodes"]) == 1
    with database.connect() as db:
        assert db.execute("SELECT count(*) FROM podcasts").fetchone()[0] == 3
        assert db.execute("SELECT count(*) FROM podcast_follows").fetchone()[0] == 1
    assert (
        client.put(
            "/api/v1/podcasts/east/follow",
            headers=HEADERS,
            json={"followed": True, "user_id": "someone-else"},
        ).status_code
        == 422
    )


def test_one_listener_completing_cannot_delete_another_followers_shared_cache(followers, settings):
    client, other, database = followers
    assert following(client).status_code == 200
    assert following(other).status_code == 200
    path = settings.podcasts_dir / "shared.mp3"
    path.write_bytes(b"shared cached episode")
    with database.connect(write=True) as db:
        db.execute("UPDATE podcasts SET retention_policy='delete_after_played' WHERE id='east'")
        db.execute(
            "UPDATE podcast_episodes SET local_path=?,download_status='downloaded' WHERE id='ep-east'",
            (str(path),),
        )
    assert complete(client).status_code == 200
    assert path.exists()
    assert other.get("/api/v1/podcasts/east").json()["podcast"]["unplayed_episodes"] == 1
    assert complete(other).status_code == 200
    assert path.exists()  # Completion does not release explicit saves or collect shared audio.


def test_unfollow_preserves_bookmark_and_shared_cache(followers, settings):
    client, other, database = followers
    assert following(other).status_code == 200
    assert complete(other).status_code == 200
    path = settings.podcasts_dir / "kept.mp3"
    path.write_bytes(b"keep")
    with database.connect(write=True) as db:
        db.execute(
            "UPDATE podcast_episodes SET local_path=?,download_status='downloaded' WHERE id='ep-east'",
            (str(path),),
        )
    assert following(other, False).status_code == 200
    assert path.exists()
    assert other.get("/api/v1/podcasts/episodes/ep-east/progress").json()["completed"]
    assert not other.get("/api/v1/podcasts/east").json()["podcast"]["followed"]
    assert following(other).status_code == 200
    assert other.get("/api/v1/podcasts/episodes/ep-east/progress").json()["completed"]
    assert client.get("/api/v1/podcasts/east").status_code == 200


def test_unplayed_prefetch_uses_followers_instead_of_admin(followers, monkeypatch):
    client, other, database = followers
    assert following(other).status_code == 200
    assert complete(client).status_code == 200
    manager = client.app.state.podcasts
    queued = []
    monkeypatch.setattr(
        manager, "queue_download_episode", lambda identity: queued.append(identity) or True
    )
    with database.connect() as db:
        assert db.execute("SELECT count(*) FROM podcast_follows").fetchone()[0] == 1
    response = other.put(
        "/api/v1/podcasts/east/download-settings",
        headers=HEADERS,
        json={"version": 1, "download_policy": "unplayed"},
    )
    assert response.status_code == 200, response.text
    # The listener's personal policy ignores another user's completed progress.
    assert queued == ["ep-east"]


def test_subscription_switch_reuses_catalog_and_only_follows_the_requesting_user(
    followers, monkeypatch
):
    client, other, database = followers
    endpoint = "/api/v1/podcasts/catalog-settings"
    with database.connect() as db:
        feed = db.execute("SELECT feed_url FROM podcasts WHERE id='east'").fetchone()[0]
    monkeypatch.setattr(
        "wildstring.podcasts.fetch_and_parse_feed",
        lambda *args, **kwargs: pytest.fail("Existing feeds must not fetch again"),
    )
    assert other.get(endpoint).json()["can_add"] is False
    response_1 = other.post("/api/v1/podcasts", headers=HEADERS, json={"feed_url": feed})
    assert response_1.status_code == 403
    value = client.get(endpoint).json()
    body = {"version": value["version"], "allow_user_subscriptions": True}
    response_2 = other.put(endpoint, headers=HEADERS, json=body)
    assert response_2.status_code == 403
    response_3 = client.put(endpoint, json=body)
    assert response_3.status_code == 403
    response_4 = client.put(endpoint, headers=HEADERS, json=body)
    assert response_4.status_code == 200
    response_5 = client.put(endpoint, headers=HEADERS, json=body)
    assert response_5.status_code == 409
    assert other.get(endpoint).json()["can_add"] is True
    response_6 = other.post(
        "/api/v1/podcasts", headers=HEADERS, json={"feed_url": feed, "download_policy": "all"}
    )
    assert response_6.status_code == 403
    for _ in range(2):
        added = other.post("/api/v1/podcasts", headers=HEADERS, json={"feed_url": feed})
        assert added.status_code == 200, added.text
        assert added.json()["podcast"]["id"] == "east"
        assert added.json()["podcast"]["followed"] is True
    assert client.get("/api/v1/podcasts?followed=true").json() == []
    response_7 = other.delete("/api/v1/podcasts/east", headers=HEADERS)
    assert response_7.status_code == 403
    response_8 = other.put(
        "/api/v1/podcasts/east/settings", headers=HEADERS, json={"auto_update": False}
    )
    assert response_8.status_code == 403
    latest = client.get(endpoint).json()
    response_9 = client.put(
        endpoint,
        headers=HEADERS,
        json={"version": latest["version"], "allow_user_subscriptions": False},
    )
    assert response_9.status_code == 200
    response_10 = other.post("/api/v1/podcasts", headers=HEADERS, json={"feed_url": feed})
    assert response_10.status_code == 403
    assert [p["id"] for p in other.get("/api/v1/podcasts?followed=true").json()] == ["east"]
