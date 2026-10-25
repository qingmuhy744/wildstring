"""Resume bookmarks must order intent, not timestamps or the largest position."""

from concurrent.futures import ThreadPoolExecutor

import pytest

from wildstring.database import Database
from wildstring.podcast_progress import ProgressWrite, save_progress

HEADERS = {"X-Wildstring-Client": "web"}


@pytest.fixture
def episode_client(settings, authenticated_client, monkeypatch):
    monkeypatch.setattr(
        "wildstring.podcasts.fetch_and_parse_feed",
        lambda *args, **kwargs: {
            "title": "Test podcast",
            "author": "Author",
            "description": "",
            "cover_url": "",
            "episodes": [
                {
                    "guid": "sync-episode",
                    "title": "One episode",
                    "description": "",
                    "audio_url": "https://example.com/audio.mp3",
                    "duration_seconds": 3600,
                    "pub_date": "2026-10-25",
                    "cover_url": "",
                    "episode_number": 1,
                    "season_number": 1,
                }
            ],
        },
    )
    with authenticated_client(settings) as client:
        response = client.post(
            "/api/v1/podcasts",
            headers=HEADERS,
            json={
                "feed_url": "https://example.com/progress.xml",
                "auto_update": False,
                "download_policy": "none",
            },
        )
        assert response.status_code == 200, response.text
        detail = response.json()
        yield client, detail["episodes"][0]["id"], detail["podcast"]["id"]


def write(client, episode, **values):
    body = {
        "session_id": "session-device-a-1",
        "device_id": "A",
        "base_version": 0,
        "sequence": 1,
        "position_seconds": 100,
        "duration_seconds": 3600,
        "event": "play",
    }
    body.update(values)
    return client.put(f"/api/v1/podcasts/episodes/{episode}/progress", headers=HEADERS, json=body)


def read(client, episode):
    response = client.get(f"/api/v1/podcasts/episodes/{episode}/progress")
    assert response.status_code == 200
    return response.json()


def test_takeover_fences_delayed_offline_writes_and_allows_rewind(episode_client):
    client, episode, podcast = episode_client
    assert read(client, episode)["version"] == 0
    response = write(client, episode)
    assert response.json()["version"] == 1
    response = write(client, episode, sequence=2, position_seconds=1200, event="progress")
    assert response.status_code == 200
    takeover = write(
        client,
        episode,
        session_id="session-device-b-1",
        device_id="B",
        base_version=2,
        position_seconds=1100,
    ).json()
    assert takeover["version"] == 3
    stale = write(client, episode, sequence=99, position_seconds=3600, event="ended")
    assert stale.status_code == 409
    assert stale.json()["detail"]["current"]["position_seconds"] == 1100
    # Choosing an earlier position on the current device is intentional and authoritative.
    rewind = write(
        client,
        episode,
        session_id="session-device-b-1",
        device_id="B",
        base_version=2,
        sequence=2,
        position_seconds=300,
        event="seek",
    )
    assert rewind.json()["position_seconds"] == 300
    detail = client.get(f"/api/v1/podcasts/{podcast}").json()
    assert detail["episodes"][0]["position_seconds"] == 300
    assert detail["episodes"][0]["completed"] is False
    # Podcasts never produce a live music handoff or a music listening event.
    shared = client.get("/api/v1/playback/state").json()
    assert shared["track_ids"] == [] and shared["version"] == 0


def test_duplicate_and_reordered_checkpoints_are_idempotent(episode_client):
    client, episode, _ = episode_client
    write(client, episode)
    newest = write(client, episode, sequence=4, position_seconds=600, event="seek").json()
    for sequence in (1, 4, 2, 3):
        delayed = write(client, episode, sequence=sequence, position_seconds=900, event="progress")
        assert delayed.status_code == 200
        assert delayed.json() == newest
    assert read(client, episode) == newest


def test_unsent_first_checkpoint_cannot_reclaim_after_another_device(episode_client):
    client, episode, _ = episode_client
    write(client, episode, session_id="session-device-b-1", device_id="B", position_seconds=200)
    # Offline A captured revision zero. Even its first upload must not become a fresh claim.
    response = write(client, episode, sequence=30, position_seconds=1000)
    assert response.status_code == 409
    latest = read(client, episode)
    # Explicitly choosing A's local bookmark uses a new session and the inspected revision.
    accepted = write(
        client,
        episode,
        session_id="session-device-a-2",
        base_version=latest["version"],
        position_seconds=1000,
    )
    assert accepted.status_code == 200
    assert accepted.json()["position_seconds"] == 1000
    response = write(client, episode, sequence=31, position_seconds=1100)
    assert response.status_code == 409


def test_only_current_ended_event_can_complete_without_collecting_shared_audio(
    episode_client, settings
):
    client, episode, podcast = episode_client
    mutation = client.put(
        f"/api/v1/podcasts/{podcast}/follow", headers=HEADERS, json={"followed": True}
    )
    assert mutation.status_code == 200
    local = settings.podcasts_dir / "safe-audio.mp3"
    local.parent.mkdir(parents=True, exist_ok=True)
    local.write_bytes(b"test audio")
    with Database(settings.data_dir).connect(write=True) as connection:
        connection.execute(
            "UPDATE podcasts SET retention_policy='delete_after_played' WHERE id=?", (podcast,)
        )
        connection.execute(
            "UPDATE podcast_episodes SET local_path=?,download_status='downloaded' WHERE id=?",
            (str(local), episode),
        )
    write(client, episode)
    write(client, episode, session_id="session-device-b-1", device_id="B", base_version=1)
    response = write(client, episode, sequence=2, position_seconds=3600, event="ended")
    assert response.status_code == 409
    assert local.exists()
    near_end = write(
        client,
        episode,
        session_id="session-device-b-1",
        device_id="B",
        base_version=1,
        sequence=2,
        position_seconds=3599,
        event="seek",
    )
    assert not near_end.json()["completed"] and local.exists()
    ended = write(
        client,
        episode,
        session_id="session-device-b-1",
        device_id="B",
        base_version=1,
        sequence=3,
        position_seconds=3600,
        event="ended",
    )
    assert ended.json()["completed"] and local.exists()
    replay = write(
        client,
        episode,
        session_id="session-device-b-2",
        device_id="B",
        base_version=4,
        position_seconds=0,
    )
    assert replay.status_code == 200 and not replay.json()["completed"]


def test_progress_is_account_scoped_and_rejects_unversioned_clients(episode_client):
    client, episode, _ = episode_client
    write(client, episode, position_seconds=900)
    created = client.post(
        "/api/v1/manage/users",
        headers=HEADERS,
        json={
            "username": "second-listener",
            "password": "test-listener-password-123",
            "profile": "listener",
        },
    )
    assert created.status_code == 201
    client.post("/api/v1/auth/logout", headers=HEADERS)
    mutation = client.post(
        "/api/v1/auth/login",
        headers=HEADERS,
        json={"username": "second-listener", "password": "test-listener-password-123"},
    )
    assert mutation.status_code == 200
    assert read(client, episode)["version"] == 0
    response = write(client, episode, position_seconds=50)
    assert response.status_code == 200
    assert read(client, episode)["position_seconds"] == 50
    legacy = client.put(
        f"/api/v1/podcasts/episodes/{episode}/progress",
        headers=HEADERS,
        json={"position_seconds": 2000, "duration_seconds": 3600, "completed": False},
    )
    assert legacy.status_code == 422
    client.post("/api/v1/auth/logout", headers=HEADERS)
    assert client.get(f"/api/v1/podcasts/episodes/{episode}/progress").status_code == 401


def test_concurrent_claims_have_one_winner(episode_client, settings):
    from types import SimpleNamespace

    from fastapi import HTTPException

    client, episode, _ = episode_client
    manager = SimpleNamespace(database=Database(settings.data_dir))
    # Use the authenticated user's concrete ID, independent of response nesting.
    with manager.database.connect() as connection:
        user = connection.execute("SELECT id FROM users WHERE username='admin'").fetchone()[0]

    def claim(device):
        try:
            save_progress(
                manager,
                user,
                episode,
                ProgressWrite(
                    session_id=f"session-device-{device}-1",
                    device_id=device,
                    base_version=0,
                    sequence=1,
                    position_seconds=100,
                    duration_seconds=3600,
                    event="play",
                ),
            )
            return 200
        except HTTPException as error:
            return error.status_code

    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(claim, ("A", "B"))) == [200, 409]


def test_schema_33_bookmarks_survive_migration(episode_client, settings):
    client, episode, _ = episode_client
    write(client, episode, position_seconds=600)
    database = Database(settings.data_dir)
    with database.connect(write=True) as connection:
        for column in ("version", "session_id", "device_id", "sequence"):
            connection.execute(f"ALTER TABLE podcast_progress DROP COLUMN {column}")
        connection.execute("PRAGMA user_version=33")
    database.initialize()
    saved = read(client, episode)
    assert saved["position_seconds"] == 600
    assert saved["version"] == 0 and saved["session_id"] == ""
    response = write(client, episode, position_seconds=300, event="seek")
    assert response.status_code == 200
