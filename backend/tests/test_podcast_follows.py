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
    assert len(other.get("/api/v1/podcasts").json()) == 3
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
    # Queueing is deduplicated by episode; a different user's completion cannot suppress it.
    assert manager._auto_download_by_policy("east", "unplayed") == 1
