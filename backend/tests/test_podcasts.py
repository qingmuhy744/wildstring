"""Tests for server-side podcast subscription, auto-updater, and REST API."""

from unittest.mock import MagicMock, patch

from wildstring.config import Settings
from wildstring.podcasts import parse_duration

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


def test_podcast_full_lifecycle(settings: Settings, authenticated_client):
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
                },
            )
            assert update_settings_res.status_code == 200
            assert update_settings_res.json()["podcast"]["download_policy"] == "latest_5"

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


def test_server_side_auto_update_scheduler(settings: Settings, authenticated_client):
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
