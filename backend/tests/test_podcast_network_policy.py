"""Podcast outbound policy: fake-ip DNS opt-in and proxied stream failures."""

import socket
import threading
import urllib.error
from email.message import Message
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import MagicMock, patch

import pytest
from fastapi import HTTPException

from wildstring import podcasts
from wildstring.config import Settings
from wildstring.database import Database
from wildstring.podcasts import (
    PodcastManager,
    PodcastURLRejected,
    fetch_and_parse_feed,
    public_socket_addresses,
)

HEADERS = {"X-Wildstring-Client": "web"}
FAKE_IP = "198.18.0.20"
FEED_HOST = "feeds.example.test"
RSS = b"""<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Fake IP Radio</title>
<item><title>One</title><guid>fake-ip-1</guid>
<enclosure url="https://cdn.example.test/one.mp3" type="audio/mpeg"/></item>
</channel></rss>
"""


def answers(*addresses):
    def resolve(host, port, *args, **kwargs):
        return [
            (
                socket.AF_INET6 if ":" in address else socket.AF_INET,
                socket.SOCK_STREAM,
                6,
                "",
                (address, port, 0, 0) if ":" in address else (address, port),
            )
            for address in addresses
        ]

    return resolve


@pytest.mark.parametrize(
    "addresses",
    [(FAKE_IP,), ("198.19.255.254",), ("::ffff:198.18.3.4",)],
)
def test_fake_ip_answers_have_a_distinct_code_and_need_opt_in(monkeypatch, addresses):
    monkeypatch.setattr(socket, "getaddrinfo", answers(*addresses))
    with pytest.raises(PodcastURLRejected, match="remote_url_fake_ip"):
        public_socket_addresses(FEED_HOST, 443)
    assert public_socket_addresses(FEED_HOST, 443, allow_fake_ip=True)


@pytest.mark.parametrize(
    "addresses",
    [
        ("10.0.0.5",),
        ("127.0.0.1",),
        ("169.254.169.254",),
        ("100.64.0.1",),
        ("192.0.2.10",),
        ("fd00::1",),
        (FAKE_IP, "192.168.1.2"),
    ],
)
def test_fake_ip_opt_in_keeps_other_private_ranges_blocked(monkeypatch, addresses):
    monkeypatch.setattr(socket, "getaddrinfo", answers(*addresses))
    with pytest.raises(PodcastURLRejected, match="remote_url_private_host"):
        public_socket_addresses(FEED_HOST, 443, allow_fake_ip=True)


def test_literal_fake_ip_url_stays_rejected():
    with pytest.raises(HTTPException) as error:
        fetch_and_parse_feed(f"http://{FAKE_IP}/feed.xml", allow_fake_ip=True)
    assert error.value.detail == "invalid_podcast_feed_url"


@pytest.fixture
def tun_feed(monkeypatch):
    """Serve RSS on loopback and route fake-ip connects there, like a local TUN proxy."""

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.send_header("Content-Type", "application/rss+xml")
            self.send_header("Content-Length", str(len(RSS)))
            self.end_headers()
            self.wfile.write(RSS)

        def log_message(self, *args):
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    port = server.server_address[1]
    real_getaddrinfo = socket.getaddrinfo

    def resolve(host, port_, *args, **kwargs):
        if host == FEED_HOST:
            return answers(FAKE_IP)(host, port_)
        return real_getaddrinfo(host, port_, *args, **kwargs)

    class TunSocket(socket.socket):
        def connect(self, address):
            if address[0] == FAKE_IP:
                address = ("127.0.0.1", address[1])
            return super().connect(address)

    monkeypatch.setattr(socket, "getaddrinfo", resolve)
    monkeypatch.setattr(podcasts.socket, "socket", TunSocket)
    try:
        yield f"http://{FEED_HOST}:{port}/feed.xml"
    finally:
        server.shutdown()
        server.server_close()


def test_feed_fetch_reports_fake_ip_and_succeeds_after_opt_in(tun_feed):
    with pytest.raises(HTTPException) as error:
        fetch_and_parse_feed(tun_feed, proxy_mode="direct")
    assert (error.value.status_code, error.value.detail) == (422, "remote_url_fake_ip")

    parsed = fetch_and_parse_feed(tun_feed, proxy_mode="direct", allow_fake_ip=True)
    assert parsed["title"] == "Fake IP Radio"


@pytest.mark.parametrize("allowed", [False, True])
def test_subscribe_api_follows_fake_ip_setting(
    settings, authenticated_client, tun_feed, monkeypatch, allowed
):
    monkeypatch.setenv("NO_PROXY", "*")
    settings.podcast_allow_fake_ip = allowed
    with authenticated_client(settings) as client:
        response = client.post("/api/v1/podcasts", headers=HEADERS, json={"feed_url": tun_feed})
    if allowed:
        assert response.status_code == 200, response.text
        assert response.json()["podcast"]["title"] == "Fake IP Radio"
    else:
        assert response.status_code == 422
        assert response.json()["detail"] == "remote_url_fake_ip"


def test_fake_ip_setting_reads_environment(monkeypatch, tmp_path):
    monkeypatch.setenv("WILDSTRING_PODCAST_ALLOW_FAKE_IP", "true")
    current = Settings(_env_file=None, data_dir=tmp_path / "data", music_dir=tmp_path / "music")
    assert current.podcast_allow_fake_ip is True
    monkeypatch.delenv("WILDSTRING_PODCAST_ALLOW_FAKE_IP")
    current = Settings(_env_file=None, data_dir=tmp_path / "data", music_dir=tmp_path / "music")
    assert current.podcast_allow_fake_ip is False


def http_error(code, headers=None):
    message = Message()
    for key, value in (headers or {}).items():
        message[key] = value
    return urllib.error.HTTPError("https://cdn.example.test/a.mp3", code, "x", message, None)


@pytest.fixture
def manager(tmp_path):
    database = Database(tmp_path / "data")
    database.initialize()
    return PodcastManager(database, storage_dir=tmp_path / "podcasts")


@pytest.mark.parametrize(
    ("failure", "code", "detail"),
    [
        (urllib.error.URLError("timed out"), 502, "podcast_audio_upstream_failed"),
        (ConnectionResetError(), 502, "podcast_audio_upstream_failed"),
        (http_error(404), 502, "podcast_audio_upstream_failed"),
        (http_error(503), 502, "podcast_audio_upstream_failed"),
        (
            http_error(416, {"Content-Range": "bytes */100"}),
            416,
            "podcast_audio_range_not_satisfiable",
        ),
        (PodcastURLRejected("remote_url_private_host"), 422, "invalid_podcast_audio_url"),
        (PodcastURLRejected("remote_url_fake_ip"), 422, "remote_url_fake_ip"),
    ],
)
def test_proxied_stream_never_redirects_on_upstream_failure(manager, failure, code, detail):
    opener = MagicMock()
    opener.open.side_effect = failure
    with patch("wildstring.podcasts.podcast_opener", return_value=opener) as build:
        with pytest.raises(HTTPException) as error:
            manager.stream_remote_audio("https://cdn.example.test/a.mp3", "bytes=100-")
    assert (error.value.status_code, error.value.detail) == (code, detail)
    assert build.call_args.args[2] is False
    if code == 416:
        assert error.value.headers == {"Content-Range": "bytes */100"}


def test_stream_route_returns_502_for_proxy_and_keeps_legacy_redirect(
    settings, authenticated_client
):
    with authenticated_client(settings) as client:
        with Database(settings.data_dir).connect(write=True) as conn:
            conn.execute(
                "INSERT INTO podcasts (id, title, feed_url, created_at, last_updated_at) "
                "VALUES ('pod-net', 'Net', 'https://example.com/feed.xml', "
                "datetime('now'), datetime('now'))"
            )
            conn.execute(
                "INSERT INTO podcast_episodes (id, podcast_id, guid, title, audio_url, created_at) "
                "VALUES ('ep-net', 'pod-net', 'g', 'Ep', 'https://cdn.example.test/a.mp3', "
                "datetime('now'))"
            )
        opener = MagicMock()
        opener.open.side_effect = urllib.error.URLError("unreachable")
        with patch("wildstring.podcasts.podcast_opener", return_value=opener):
            proxied = client.get(
                "/api/v1/podcasts/episodes/ep-net/stream?proxy=1&network=wifi",
                follow_redirects=False,
            )
            legacy = client.get("/api/v1/podcasts/episodes/ep-net/stream", follow_redirects=False)
    assert proxied.status_code == 502
    assert proxied.json()["detail"] == "podcast_audio_upstream_failed"
    assert "location" not in proxied.headers
    assert legacy.status_code == 307
    assert legacy.headers["location"] == "https://cdn.example.test/a.mp3"
