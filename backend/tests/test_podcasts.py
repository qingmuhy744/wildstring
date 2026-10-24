"""Tests for server-side podcast subscription, auto-updater, and REST API."""

from unittest.mock import MagicMock, patch

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from wildstring.config import Settings
from wildstring.database import Database
from wildstring.main import create_app
from wildstring.podcasts import (
    fetch_and_parse_feed,
    parse_duration,
    podcast_folder_name,
)

SAMPLE_RSS = b"""<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
     xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"
     xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>Audiobookshelf Daily</title>
    <link>https://example.com/podcast</link>
    <description>A test podcast for WildString</description>
    <itunes:author>WildString Team</itunes:author>
    <itunes:image href="https://example.com/cover.jpg"/>
    <item>
      <title>Episode 1: Architecture</title>
      <guid>ep-001</guid>
      <pubDate>Mon, 20 Oct 2026 12:00:00 GMT</pubDate>
      <description>Introduction to podcast architecture</description>
      <enclosure url="https://example.com/audio/ep1.mp3" length="123456" type="audio/mpeg"/>
      <itunes:duration>00:45:30</itunes:duration>
      <itunes:episode>1</itunes:episode>
      <itunes:season>1</itunes:season>
    </item>
    <item>
      <title>Episode 2: Streaming and Progress</title>
      <guid>ep-002</guid>
      <pubDate>Tue, 21 Oct 2026 12:00:00 GMT</pubDate>
      <description>Handling audio streaming and playback progress</description>
      <enclosure url="https://example.com/audio/ep2.mp3" length="654321" type="audio/mpeg"/>
      <itunes:duration>1800</itunes:duration>
      <itunes:episode>2</itunes:episode>
    </item>
  </channel>
</rss>
"""


CLIENT_HEADERS = {"X-Wildstring-Client": "web"}


def test_parse_duration():
    assert parse_duration("00:45:30") == 2730
    assert parse_duration("12:30") == 750
    assert parse_duration("1800") == 1800
    assert parse_duration(None) == 0
    assert parse_duration("invalid") == 0


def test_podcast_urls_reject_local_schemes_and_private_hosts():
    with pytest.raises(HTTPException) as local:
        fetch_and_parse_feed("file:///etc/hosts")
    assert local.value.status_code == 422

    with pytest.raises(HTTPException) as private:
        fetch_and_parse_feed("http://127.0.0.1:18780/feed.xml")
    assert private.value.status_code == 422


def test_podcast_feed_skips_unsafe_audio_url(monkeypatch):
    response = MagicMock()
    response.read.return_value = SAMPLE_RSS.replace(
        b"https://example.com/audio/ep1.mp3", b"file:///etc/passwd"
    )
    response.__enter__.return_value = response
    opener = MagicMock()
    opener.open.return_value = response
    monkeypatch.setattr("urllib.request.build_opener", lambda *_args: opener)

    parsed = fetch_and_parse_feed("https://example.com/feed.xml", proxy_mode="direct")
    assert [episode["guid"] for episode in parsed["episodes"]] == ["ep-002"]


def test_podcast_feed_response_is_bounded(monkeypatch):
    response = MagicMock()
    response.read.return_value = b"x" * (8 * 1024 * 1024 + 1)
    response.__enter__.return_value = response
    opener = MagicMock()
    opener.open.return_value = response
    monkeypatch.setattr("urllib.request.build_opener", lambda *_args: opener)

    with pytest.raises(HTTPException) as error:
        fetch_and_parse_feed("https://example.com/feed.xml", proxy_mode="direct")
    assert error.value.status_code == 413


def test_podcast_storage_folder_is_stable_and_unique():
    assert podcast_folder_name("podcast-a") != podcast_folder_name("podcast-b")
    assert podcast_folder_name("same-title-a") != podcast_folder_name("same-title-b")


def test_podcast_queue_requires_session_and_manager_scope(settings, authenticated_client):
    with authenticated_client(settings) as admin:
        response = admin.post(
            "/api/v1/manage/users",
            headers=CLIENT_HEADERS,
            json={
                "username": "podcast-listener",
                "password": "podcast-listener-password-123",
                "profile": "listener",
            },
        )
        assert response.status_code == 201

    with TestClient(create_app(settings)) as client:
        assert (
            client.get("/api/v1/podcasts/downloads/queue", headers=CLIENT_HEADERS).status_code
            == 401
        )
        assert (
            client.post(
                "/api/v1/auth/login",
                headers=CLIENT_HEADERS,
                json={
                    "username": "podcast-listener",
                    "password": "podcast-listener-password-123",
                },
            ).status_code
            == 200
        )
        assert (
            client.get("/api/v1/podcasts/downloads/queue", headers=CLIENT_HEADERS).status_code
            == 403
        )
        assert (
            client.post(
                "/api/v1/podcasts/downloads/retry-failed", headers=CLIENT_HEADERS
            ).status_code
            == 403
        )


def test_delete_after_played_removes_the_registered_local_file(
    settings: Settings, authenticated_client, monkeypatch
):
    monkeypatch.setattr(
        "wildstring.podcasts.PodcastManager.queue_download_episode",
        lambda *_args, **_kwargs: True,
    )
    mock_response = MagicMock()
    mock_response.read.return_value = SAMPLE_RSS
    mock_response.__enter__.return_value = mock_response
    mock_opener = MagicMock()
    mock_opener.open.return_value = mock_response

    with patch("urllib.request.build_opener", return_value=mock_opener):
        with authenticated_client(settings) as client:
            subscribed = client.post(
                "/api/v1/podcasts",
                headers=CLIENT_HEADERS,
                json={
                    "feed_url": "https://example.com/feed-retention.xml",
                    "auto_update": False,
                    "download_policy": "none",
                    "retention_policy": "delete_after_played",
                },
            )
            assert subscribed.status_code == 200
            detail = subscribed.json()
            podcast_id = detail["podcast"]["id"]
            episode_id = detail["episodes"][0]["id"]
            local_file = settings.podcasts_dir / podcast_folder_name(podcast_id) / "episode.mp3"
            local_file.parent.mkdir(parents=True, exist_ok=True)
            local_file.write_bytes(b"audio")

            with Database(settings.data_dir).connect(write=True) as connection:
                connection.execute(
                    "UPDATE podcast_episodes SET local_path=?,download_status='downloaded' WHERE id=?",
                    (str(local_file), episode_id),
                )

            progress = client.put(
                f"/api/v1/podcasts/episodes/{episode_id}/progress",
                headers=CLIENT_HEADERS,
                json={"position_seconds": 10, "duration_seconds": 10, "completed": True},
            )
            assert progress.status_code == 200
            assert not local_file.exists()
            with Database(settings.data_dir).connect() as connection:
                row = connection.execute(
                    "SELECT local_path,download_status FROM podcast_episodes WHERE id=?",
                    (episode_id,),
                ).fetchone()
            assert row["local_path"] is None and row["download_status"] == "none"


def test_podcast_full_lifecycle(settings: Settings, authenticated_client, monkeypatch):
    # Subscription and settings updates may auto-queue downloads. The fixture
    # URLs are deliberately synthetic, so keep this lifecycle test focused on
    # the API contract instead of leaving retrying network workers behind.
    monkeypatch.setattr(
        "wildstring.podcasts.PodcastManager.queue_download_episode",
        lambda *_args, **_kwargs: True,
    )
    mock_response = MagicMock()
    mock_response.read.return_value = SAMPLE_RSS
    mock_response.__enter__.return_value = mock_response
    mock_opener = MagicMock()
    mock_opener.open.return_value = mock_response

    with (
        patch("urllib.request.urlopen", return_value=mock_response),
        patch("urllib.request.build_opener", return_value=mock_opener),
    ):
        with authenticated_client(settings) as client:
            # 1. Initially empty list
            res = client.get("/api/v1/podcasts")
            assert res.status_code == 200
            assert res.json() == []

            # 2. Subscribe to a new podcast
            sub_res = client.post(
                "/api/v1/podcasts",
                headers=CLIENT_HEADERS,
                json={
                    "feed_url": "https://example.com/feed.xml",
                    "auto_update": True,
                    "update_interval_minutes": 60,
                },
            )
            assert sub_res.status_code == 200
            data = sub_res.json()
            podcast = data["podcast"]
            episodes = data["episodes"]

            assert podcast["title"] == "Audiobookshelf Daily"
            assert podcast["author"] == "WildString Team"
            assert podcast["cover_url"] == "https://example.com/cover.jpg"
            assert podcast["total_episodes"] == 2
            assert podcast["unplayed_episodes"] == 2
            assert len(episodes) == 2

            ep1 = next(e for e in episodes if e["guid"] == "ep-001")
            assert ep1["title"] == "Episode 1: Architecture"
            assert ep1["duration_seconds"] == 2730
            assert ep1["audio_url"] == "https://example.com/audio/ep1.mp3"
            assert ep1["completed"] is False
            assert ep1["position_seconds"] == 0

            podcast_id = podcast["id"]
            ep1_id = ep1["id"]

            # 3. Stream redirect
            stream_res = client.get(
                f"/api/v1/podcasts/episodes/{ep1_id}/stream",
                follow_redirects=False,
            )
            assert stream_res.status_code == 307
            assert stream_res.headers["location"] == "https://example.com/audio/ep1.mp3"

            # 4. Update playback progress
            prog_res = client.put(
                f"/api/v1/podcasts/episodes/{ep1_id}/progress",
                headers=CLIENT_HEADERS,
                json={
                    "position_seconds": 300,
                    "duration_seconds": 2730,
                    "completed": True,
                },
            )
            assert prog_res.status_code == 200

            # 5. Check detail reflects progress
            detail_res = client.get(f"/api/v1/podcasts/{podcast_id}")
            assert detail_res.status_code == 200
            detail = detail_res.json()
            assert detail["podcast"]["unplayed_episodes"] == 1
            updated_ep1 = next(e for e in detail["episodes"] if e["id"] == ep1_id)
            assert updated_ep1["completed"] is True
            assert updated_ep1["position_seconds"] == 300

            # 6. Refresh podcast endpoint
            refresh_res = client.post(
                f"/api/v1/podcasts/{podcast_id}/refresh",
                headers=CLIENT_HEADERS,
            )
            assert refresh_res.status_code == 200

            # 7. Refresh all endpoint
            refresh_all_res = client.post(
                "/api/v1/podcasts/refresh-all",
                headers=CLIENT_HEADERS,
            )
            assert refresh_all_res.status_code == 200

            # 7.1 Update auto-download settings
            update_settings_res = client.put(
                f"/api/v1/podcasts/{podcast_id}/settings",
                headers=CLIENT_HEADERS,
                json={
                    "auto_update": True,
                    "download_policy": "latest_5",
                    "retention_policy": "keep",
                    "slow_download": True,
                    "max_retries": 4,
                    "retry_backoff_base": 10,
                },
            )
            assert update_settings_res.status_code == 200
            assert update_settings_res.json()["podcast"]["download_policy"] == "latest_5"
            assert update_settings_res.json()["podcast"]["slow_download"] is True
            assert update_settings_res.json()["podcast"]["max_retries"] == 4
            assert update_settings_res.json()["podcast"]["retry_backoff_base"] == 10

            # 7.1.1 Trigger all episode downloads and keep the Web contract explicit
            download_all_res = client.post(
                f"/api/v1/podcasts/{podcast_id}/download-all",
                headers=CLIENT_HEADERS,
            )
            assert download_all_res.status_code == 200
            assert download_all_res.json()["queued_episodes"] == 2
            assert "message" in download_all_res.json()

            # 7.2 Check storage info
            storage_res = client.get(
                f"/api/v1/podcasts/{podcast_id}/storage",
                headers=CLIENT_HEADERS,
            )
            assert storage_res.status_code == 200
            assert "storage_path" in storage_res.json()
            assert "disk_usage_human" in storage_res.json()

            # 7.3 Trigger single episode download
            dl_res = client.post(
                f"/api/v1/podcasts/episodes/{ep1_id}/download",
                headers=CLIENT_HEADERS,
            )
            assert dl_res.status_code == 200
            assert dl_res.json()["status"] == "downloading"

            # 7.4 Clean downloads
            clean_res = client.post(
                f"/api/v1/podcasts/{podcast_id}/clean-downloads",
                headers=CLIENT_HEADERS,
            )
            assert clean_res.status_code == 200
            assert clean_res.json()["status"] == "ok"
            assert clean_res.json()["deleted_count"] == 0

            # 8. Unsubscribe / Delete
            del_res = client.delete(
                f"/api/v1/podcasts/{podcast_id}",
                headers=CLIENT_HEADERS,
            )
            assert del_res.status_code == 200
            assert del_res.json()["status"] == "deleted"

            # Check deleted
            check_res = client.get(f"/api/v1/podcasts/{podcast_id}")
            assert check_res.status_code == 404


def test_server_side_auto_update_scheduler(settings: Settings, authenticated_client, monkeypatch):
    monkeypatch.setattr(
        "wildstring.podcasts.PodcastManager.queue_download_episode",
        lambda *_args, **_kwargs: True,
    )
    mock_response = MagicMock()
    mock_response.read.return_value = SAMPLE_RSS
    mock_response.__enter__.return_value = mock_response
    mock_opener = MagicMock()
    mock_opener.open.return_value = mock_response

    with (
        patch("urllib.request.urlopen", return_value=mock_response),
        patch("urllib.request.build_opener", return_value=mock_opener),
    ):
        with authenticated_client(settings) as client:
            # 1. Subscribe podcast
            sub_res = client.post(
                "/api/v1/podcasts",
                headers=CLIENT_HEADERS,
                json={
                    "feed_url": "https://example.com/feed-auto.xml",
                    "auto_update": True,
                    "update_interval_minutes": 60,
                },
            )
            assert sub_res.status_code == 200
            podcast_id = sub_res.json()["podcast"]["id"]

            from wildstring.database import Database
            from wildstring.podcasts import PodcastManager

            db = Database(settings.data_dir)
            manager = PodcastManager(db)

            # Fast-forward last_updated_at to 2 hours ago
            with db.connect(write=True) as conn:
                conn.execute(
                    "UPDATE podcasts SET last_updated_at = '2026-01-01T00:00:00+00:00' WHERE id = ?",
                    (podcast_id,),
                )

            # Run server-side scheduler
            updated_count = manager.run_scheduled_updates()
            assert updated_count == 1

            # Running again immediately should do nothing (since last_updated_at is fresh now)
            updated_count2 = manager.run_scheduled_updates()
            assert updated_count2 == 0
