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


def test_stopping_inside_the_tail_marks_the_episode_listened(episode_client):
    client, episode, _ = episode_client
    write(client, episode)
    # One hour: 5% is 180s, so the cap is 2 minutes. The second before that stays unplayed.
    before_tail = write(client, episode, sequence=2, position_seconds=3479, event="pause").json()
    assert before_tail["completed"] is False
    while_playing = write(
        client, episode, sequence=3, position_seconds=3500, event="progress"
    ).json()
    assert while_playing["completed"] is False
    seek_into_tail = write(client, episode, sequence=4, position_seconds=3500, event="seek").json()
    assert seek_into_tail["completed"] is False
    paused = write(client, episode, sequence=5, position_seconds=3480, event="pause").json()
    assert paused["completed"] is True and paused["position_seconds"] == 3480
    # Continuing past the bookmark clears the flag until playback stops in the tail again.
    resumed = write(client, episode, sequence=6, position_seconds=3490, event="progress").json()
    assert resumed["completed"] is False
    stopped = write(client, episode, sequence=7, position_seconds=3500, event="stop").json()
    assert stopped["completed"] is True


def test_completion_tail_caps_long_episodes_and_spares_short_ones(episode_client):
    client, episode, _ = episode_client
    write(client, episode, duration_seconds=10800, position_seconds=0)
    # Three hours: 5% is 9 minutes, so only the last 2 minutes count.
    early = write(
        client,
        episode,
        sequence=2,
        duration_seconds=10800,
        position_seconds=10500,
        event="pause",
    ).json()
    assert early["completed"] is False
    capped = write(
        client,
        episode,
        sequence=3,
        duration_seconds=10800,
        position_seconds=10680,
        event="ended",
    ).json()
    assert capped["completed"] is True

    replay = write(
        client,
        episode,
        session_id="session-device-a-2",
        base_version=capped["version"],
        duration_seconds=600,
        position_seconds=0,
        event="play",
    ).json()
    assert replay["completed"] is False
    # Ten minutes: the floor is 30 seconds, which is 95%.
    almost = write(
        client,
        episode,
        session_id="session-device-a-2",
        base_version=capped["version"],
        sequence=2,
        duration_seconds=600,
        position_seconds=569,
        event="pause",
    ).json()
    assert almost["completed"] is False
    ten_minutes = write(
        client,
        episode,
        session_id="session-device-a-2",
        base_version=capped["version"],
        sequence=3,
        duration_seconds=600,
        position_seconds=570,
        event="pause",
    ).json()
    assert ten_minutes["completed"] is True

    short = write(
        client,
        episode,
        session_id="session-device-a-3",
        base_version=ten_minutes["version"],
        duration_seconds=20,
        position_seconds=19,
        event="pause",
    ).json()
    assert short["completed"] is False
    finished = write(
        client,
        episode,
        session_id="session-device-a-3",
        base_version=ten_minutes["version"],
        sequence=2,
        duration_seconds=20,
        position_seconds=20,
        event="ended",
    ).json()
    assert finished["completed"] is True


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


def test_progress_is_account_scoped_and_rejects_unversioned_clients(episode_client, settings):
    client, episode, podcast_id = episode_client
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
    from wildstring.database import Database

    with Database(settings.data_dir).connect(write=True) as db:
        db.execute(
            "INSERT INTO podcast_user_catalog VALUES (?,?)", (created.json()["id"], podcast_id)
        )
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


@pytest.mark.parametrize("intent", ["resume", "restart", None])
def test_completion_intent_persists_across_session_events(episode_client, intent):
    client, episode, _ = episode_client
    completed = write(client, episode, position_seconds=3600, event="ended").json()
    fields = {"intent": intent} if intent else {}
    # Each write carries intent, including seeks and repeated play events.
    for sequence, event in enumerate(["play", "progress", "seek", "pause", "stop", "play"], 1):
        result = write(
            client,
            episode,
            session_id="new-listening-session",
            base_version=completed["version"],
            sequence=sequence,
            position_seconds=(sequence - 1) * 100,
            event=event,
            **fields,
        )
        assert result.status_code == 200, result.text
        assert result.json()["completed"] is (intent == "resume")


@pytest.mark.parametrize("intent", ["resume", "restart"])
@pytest.mark.parametrize("event,position", [("pause", 3480), ("stop", 3480), ("ended", 3600)])
def test_intent_still_allows_natural_completion(episode_client, intent, event, position):
    client, episode, _ = episode_client
    result = write(client, episode, intent=intent, position_seconds=position, event=event)
    assert result.status_code == 200
    assert result.json()["completed"] is True


def test_intent_does_not_bypass_version_or_sequence(episode_client):
    client, episode, _ = episode_client
    completed = write(client, episode, intent="resume", event="ended", position_seconds=3600).json()
    duplicate = write(client, episode, intent="restart", position_seconds=0)
    assert duplicate.json() == completed
    conflict = write(client, episode, session_id="stale-listening-session", intent="restart")
    assert conflict.status_code == 409
    current = conflict.json()["detail"]["current"]
    assert current == completed
    assert current["device_id"] == "A"
    assert current["updated_at"]


def test_resume_mode_defaults_validation_and_account_isolation(episode_client):
    client, _, _ = episode_client
    url = "/api/v1/podcasts/resume-mode"
    assert client.get(url).json() == {"resume_mode": "auto"}
    for mode in ("ask", "restart", "auto", "ask"):
        result = client.put(url, headers=HEADERS, json={"resume_mode": mode})
        assert result.status_code == 200, result.text
        assert client.get(url).json() == {"resume_mode": mode}
    for body in ({"resume_mode": "invalid"}, {}, {"resume_mode": "auto", "initialize": True}):
        assert client.put(url, headers=HEADERS, json=body).status_code == 422
    assert client.get(url).json() == {"resume_mode": "ask"}
    created = client.post(
        "/api/v1/manage/users",
        headers=HEADERS,
        json={
            "username": "resume-listener",
            "password": "test-listener-password-123",
            "profile": "listener",
        },
    )
    assert created.status_code == 201
    client.post("/api/v1/auth/logout", headers=HEADERS)
    assert client.get(url).status_code == 401
    assert client.put(url, headers=HEADERS, json={"resume_mode": "restart"}).status_code == 401
    assert (
        client.post(
            "/api/v1/auth/login",
            headers=HEADERS,
            json={"username": "resume-listener", "password": "test-listener-password-123"},
        ).status_code
        == 200
    )
    assert client.get(url).json() == {"resume_mode": "auto"}
    assert client.put(url, headers=HEADERS, json={"resume_mode": "restart"}).status_code == 200
    assert client.get(url).json() == {"resume_mode": "restart"}


def test_resume_preference_schema52_upgrade_preserves_bookmarks(episode_client, settings):
    client, episode, _ = episode_client
    saved = write(client, episode, position_seconds=600).json()
    database = Database(settings.data_dir)
    with database.connect(write=True) as connection:
        connection.execute("DROP TABLE podcast_resume_prefs")
        connection.execute("PRAGMA user_version=52")
    database.initialize()
    assert read(client, episode) == saved
    assert client.get("/api/v1/podcasts/resume-mode").json() == {"resume_mode": "auto"}
    # Re-initialization must preserve a changed preference.
    client.put("/api/v1/podcasts/resume-mode", headers=HEADERS, json={"resume_mode": "ask"})
    database.initialize()
    assert client.get("/api/v1/podcasts/resume-mode").json() == {"resume_mode": "ask"}
