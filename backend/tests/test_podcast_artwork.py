"""Podcast cover fallback reuses the authenticated catalogue and outbound policy."""

import io
from unittest.mock import MagicMock

import pytest
from PIL import Image

from wildstring import podcast_artwork
from wildstring.podcasts import MAX_COVER_BYTES, PodcastURLRejected

HEADERS = {"X-Wildstring-Client": "web"}
PATH = "/api/v1/podcasts/artwork-fixture/cover"


def picture():
    output = io.BytesIO()
    Image.new("RGB", (64, 64), "#8f5b39").save(output, "PNG")
    return output.getvalue()


@pytest.fixture
def artwork(settings, authenticated_client):
    with authenticated_client(settings) as client:
        manager = client.app.state.podcasts
        with manager.database.connect(write=True) as db:
            db.execute(
                "INSERT INTO podcasts(id,title,feed_url,cover_url,auto_update,created_at) VALUES ('artwork-fixture','封面测试','https://feeds.example.test/rss','https://images.example.test/cover.png',0,'2026-11-11')"
            )
        yield client, manager


def test_cover_fetches_with_server_policy_then_uses_local_cache(artwork, monkeypatch):
    client, manager = artwork
    manager.get_network_policy = lambda: ("direct", "")
    response = MagicMock()
    response.__enter__.return_value = response
    response.read.return_value = picture()
    opener = MagicMock()
    opener.open.return_value = response
    factory = MagicMock(return_value=opener)
    monkeypatch.setattr(podcast_artwork, "podcast_opener", factory)
    first = client.get(PATH)
    assert first.status_code == 200
    assert first.headers["content-type"] == "image/jpeg"
    assert first.headers["cache-control"] == "private, no-store"
    assert first.headers["x-content-type-options"] == "nosniff"
    with Image.open(io.BytesIO(first.content)) as image:
        assert image.format == "JPEG" and image.size == (64, 64)
    assert client.get(PATH).status_code == 200
    factory.assert_called_once_with("direct", "", manager.allow_fake_ip)
    request = opener.open.call_args.args[0]
    assert request.full_url == "https://images.example.test/cover.png"
    assert request.get_header("Cookie") is None
    assert request.get_header("Authorization") is None
    assert (manager._podcast_dir("artwork-fixture") / "cover.jpg").is_file()


def test_cover_reuses_artwork_saved_with_a_download(artwork, monkeypatch):
    client, manager = artwork
    target = manager._podcast_dir("artwork-fixture") / "cover.jpg"
    target.parent.mkdir(parents=True)
    target.write_bytes(picture())
    factory = MagicMock(side_effect=AssertionError("cached cover must not contact the source"))
    monkeypatch.setattr(podcast_artwork, "podcast_opener", factory)
    assert client.get(PATH).status_code == 200
    factory.assert_not_called()


@pytest.mark.parametrize(
    ("payload", "expected"),
    [(b"not an image", 502), (b"x" * (MAX_COVER_BYTES + 1), 413)],
)
def test_cover_rejects_invalid_and_oversized_images(artwork, monkeypatch, payload, expected):
    client, manager = artwork
    response = MagicMock()
    response.__enter__.return_value = response
    response.read.return_value = payload
    opener = MagicMock()
    opener.open.return_value = response
    monkeypatch.setattr(podcast_artwork, "podcast_opener", lambda *_args: opener)
    assert client.get(PATH).status_code == expected
    assert not (manager._podcast_dir("artwork-fixture") / "cover.jpg").exists()


@pytest.mark.parametrize(
    ("failure", "expected"),
    [(PodcastURLRejected("remote_url_private_host"), 422), (OSError("source failed"), 502)],
)
def test_cover_preserves_outbound_rejections_and_reports_unavailability(
    artwork, monkeypatch, failure, expected
):
    client, _ = artwork
    opener = MagicMock()
    opener.open.side_effect = failure
    monkeypatch.setattr(podcast_artwork, "podcast_opener", lambda *_args: opener)
    assert client.get(PATH).status_code == expected
    opener.open.assert_called_once()


def test_cover_requires_session_and_catalogue_access(artwork, monkeypatch):
    client, manager = artwork
    factory = MagicMock(side_effect=AssertionError("denied requests must not fetch images"))
    monkeypatch.setattr(podcast_artwork, "podcast_opener", factory)
    account = client.post(
        "/api/v1/manage/users",
        headers=HEADERS,
        json={
            "username": "cover-listener",
            "password": "synthetic-password-123",
            "profile": "listener",
        },
    )
    assert account.status_code == 201
    client.cookies.clear()
    assert client.get(PATH).status_code == 401
    assert (
        client.post(
            "/api/v1/auth/login",
            headers=HEADERS,
            json={"username": "cover-listener", "password": "synthetic-password-123"},
        ).status_code
        == 200
    )
    assert client.get(PATH).status_code == 404
    with manager.database.connect(write=True) as db:
        db.execute(
            "INSERT INTO podcast_user_catalog(user_id,podcast_id) VALUES (?, 'artwork-fixture')",
            (account.json()["id"],),
        )
        db.execute("UPDATE podcasts SET cover_url='' WHERE id='artwork-fixture'")
    assert client.get(PATH).status_code == 404
    factory.assert_not_called()
