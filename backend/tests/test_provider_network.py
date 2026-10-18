"""Server-side diagnostics use the real proxy path without exposing or saving secrets."""

import io
import json
import logging
import socket
import ssl
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlsplit

import pytest
from test_personal_library import music
from test_providers import HEADERS, enable

from wildstring.library.scanner import scan_library
from wildstring.provider_network import network_error
from wildstring.providers import ACOUSTID, FM, ProviderError, acoustid_failure, lastfm_failure
from wildstring.request_privacy import RedactLastfmCallback


def test_network_draft_uses_all_fixed_services_without_saving(
    settings, authenticated_client, monkeypatch
):
    with authenticated_client(settings) as client:
        providers = client.app.state.providers
        providers.stop()
        enable(client, api_key="a" * 32, api_secret="b" * 32, acoustid_api_key="fixture-key")
        before = providers.settings(), providers.credentials.read_bytes()
        calls = []

        class Response:
            status = 200

            def __init__(self, payload):
                self.payload = payload

            def __enter__(self):
                return self

            def __exit__(self, *_):
                pass

            def read(self, limit):
                return self.payload[:limit]

        def build(handler, _redirect):
            class Opener:
                def open(self, request, timeout):
                    calls.append((request, timeout, handler.proxies))
                    host = urlsplit(request.full_url).hostname
                    if host == "coverartarchive.org":
                        if request.full_url.endswith(".jpg"):
                            from PIL import Image

                            stream = io.BytesIO()
                            Image.new("RGB", (8, 8)).save(stream, format="JPEG")
                            return Response(stream.getvalue())
                        return Response(
                            json.dumps(
                                {
                                    "images": [
                                        {
                                            "front": True,
                                            "image": "https://coverartarchive.org/release/76df3287-6cda-33eb-8e9a-044b5e15ffdd/829521842.jpg",
                                        }
                                    ]
                                }
                            ).encode()
                        )
                    if host == "api.acoustid.org":
                        return Response(b'{"status":"ok","results":[]}')
                    if host == "musicbrainz.org":
                        return Response(b'{"id":"bfcc6d75-a6a5-4bc6-8282-47aec8531818"}')
                    return Response(b'{"artist":{}}')

            return Opener()

        monkeypatch.setattr("wildstring.providers.build_opener", build)
        monkeypatch.setattr("wildstring.outbound.proxy_bypass", lambda _host: False)
        proxy = "http://private-user:private-password@127.0.0.1:7890"
        response = client.post(
            "/api/v1/manage/providers/network-test",
            headers=HEADERS,
            json={"proxy_mode": "custom", "proxy_url": proxy},
        )
        assert response.status_code == 200, response.text
        assert "no-store" in response.headers["cache-control"]
        assert len(calls) == 5
        assert all(
            timeout == 15 and proxies == {"http": proxy, "https": proxy}
            for _, timeout, proxies in calls
        )
        assert {item["provider"] for item in response.json()["items"]} == {
            "musicbrainz",
            "lastfm",
            "caa",
            "acoustid",
        }
        assert all(
            item["status"] == "ok" and item["via_proxy"] for item in response.json()["items"]
        )
        assert all(item["elapsed_ms"] >= 0 for item in response.json()["items"])
        assert "private-password" not in response.text and "a" * 32 not in response.text
        assert before == (providers.settings(), providers.credentials.read_bytes())
        assert (
            client.post(
                "/api/v1/manage/providers/network-test", json={"proxy_mode": "direct"}
            ).status_code
            == 403
        )
        for value in (
            "private-password",
            ["private-password"],
            {"proxy_mode": "custom", "proxy_url": "file:///private-password"},
            {"proxy_mode": "direct", "target": "http://localhost/private-password"},
        ):
            result = client.post(
                "/api/v1/manage/providers/network-test", headers=HEADERS, json=value
            )
            assert result.status_code == 422 and "private-password" not in result.text
        providers.network_test_lock.acquire()
        try:
            assert (
                client.post(
                    "/api/v1/manage/providers/network-test",
                    headers=HEADERS,
                    json={"proxy_mode": "direct"},
                ).status_code
                == 409
            )
        finally:
            providers.network_test_lock.release()
        client.post("/api/v1/auth/logout", headers=HEADERS)
        assert (
            client.post(
                "/api/v1/manage/providers/network-test",
                headers=HEADERS,
                json={"proxy_mode": "direct"},
            ).status_code
            == 401
        )


@pytest.mark.parametrize(
    ("error", "code"),
    [
        (URLError(ssl.SSLEOFError("private-password")), "tls_eof"),
        (ssl.SSLError("private-password"), "tls_error"),
        (URLError(socket.gaierror("private-password")), "dns_error"),
        (TimeoutError("private-password"), "timeout"),
        (URLError(ConnectionRefusedError("private-password")), "connection_refused"),
        (URLError(ConnectionResetError("private-password")), "connection_reset"),
        (URLError("Tunnel connection failed: 407 private-password"), "proxy_auth_required"),
        (URLError("private-password"), "network_unavailable"),
    ],
)
def test_network_errors_are_safe_codes(error, code):
    assert network_error(error) == code


@pytest.mark.parametrize("http_status", [200, 400])
def test_acoustid_rejection_keeps_safe_code_and_never_retries_invalid_key(
    settings, authenticated_client, monkeypatch, http_status
):
    with authenticated_client(settings) as client:
        providers = client.app.state.providers
        providers.stop()
        providers.exit.clear()
        enable(client, acoustid_api_key="synthetic-app-key", proxy_mode="direct")
        calls = []
        raw = b'{"status":"error","error":{"code":4,"message":"private-key-and-fingerprint"}}'

        class Response(io.BytesIO):
            status = 200

        class Opener:
            def open(self, request, **_):
                calls.append(request)
                if http_status == 400:
                    raise HTTPError(request.full_url, 400, "private-key", {}, io.BytesIO(raw))
                return Response(raw)

        monkeypatch.setattr("wildstring.providers.build_opener", lambda *_: Opener())
        with pytest.raises(ProviderError, match="^acoustid_error_4$") as caught:
            providers.request(ACOUSTID, {"duration": 12, "fingerprint": "synthetic-fingerprint"})
        assert len(calls) == 1
        assert caught.value.transient is False
        assert caught.value.http_status == (400 if http_status == 400 else None)
        assert "private" not in str(caught.value)


@pytest.mark.parametrize(
    "code,transient", [(4, False), (5, True), (13, True), (14, True), (17, False)]
)
def test_acoustid_transient_codes_follow_upstream_meaning(code, transient):
    assert acoustid_failure({"error": {"code": code}}).transient is transient
    assert str(acoustid_failure({"error": {"code": "private-key"}})) == "acoustid_rejected"


def test_network_errors_and_missing_credentials_are_independent(
    settings, authenticated_client, monkeypatch
):
    def build(*_):
        class Opener:
            def open(self, *_args, **_kwargs):
                raise URLError(ssl.SSLEOFError("private-password"))

        return Opener()

    monkeypatch.setattr("wildstring.providers.build_opener", build)
    with authenticated_client(settings) as client:
        providers = client.app.state.providers
        providers.stop()
        response = client.post(
            "/api/v1/manage/providers/network-test", headers=HEADERS, json={"proxy_mode": "direct"}
        )
        assert response.status_code == 200 and "private-password" not in response.text
        items = {item["provider"]: item for item in response.json()["items"]}
        assert items["musicbrainz"]["code"] == items["caa"]["code"] == "tls_eof"
        assert items["lastfm"]["status"] == items["acoustid"]["status"] == "unconfigured"


def test_non_2xx_lastfm_keeps_numeric_error_and_callback_privacy(
    settings, authenticated_client, monkeypatch, caplog
):
    with authenticated_client(settings) as client:
        providers = client.app.state.providers
        providers.stop()
        providers.exit.clear()
        enable(
            client,
            api_key="a" * 32,
            api_secret="b" * 32,
            public_url="https://music.example.com",
            proxy_mode="direct",
        )

        class Opener:
            def open(self, request, **_):
                raise HTTPError(
                    request.full_url,
                    403,
                    "private-password",
                    {},
                    io.BytesIO(b'{"error":13,"message":"private-password"}'),
                )

        monkeypatch.setattr("wildstring.providers.build_opener", lambda *_: Opener())
        with pytest.raises(ProviderError, match="^lastfm_error_13$"):
            providers.request(
                FM, {"method": "auth.getSession", "token": "private-token"}, signed=True
            )
        response = client.post("/api/v1/lastfm/authorize", headers=HEADERS)
        assert "no-store" in response.headers["cache-control"]
        callback = parse_qs(urlsplit(response.json()["url"]).query)["cb"][0]
        state = parse_qs(urlsplit(callback).query)["state"][0]
        with caplog.at_level(logging.WARNING, logger="wildstring.providers"):
            result = client.get(
                "/api/v1/lastfm/callback", params={"state": state, "token": "private-token"}
            )
        assert result.status_code == 502
        assert "Last.fm authorization failed: lastfm_error_13" in caplog.text
        assert "private-password" not in caplog.text
        for callback_response in (
            result,
            client.get(
                "/api/v1/lastfm/callback", params={"state": state, "token": "private-token"}
            ),
        ):
            assert callback_response.headers["cache-control"] == "no-store"
            assert callback_response.headers["referrer-policy"] == "no-referrer"
        assert any(
            isinstance(f, RedactLastfmCallback) for f in logging.getLogger("uvicorn.access").filters
        )
        redirect = client.get(
            "/api/v1/lastfm/callback/?state=private-state&token=private-token",
            follow_redirects=False,
        )
        # A mounted Web catch-all returns 404 instead of the router's slash redirect.
        assert redirect.status_code in {307, 404}
        assert "no-store" in redirect.headers["cache-control"]
        assert redirect.headers["referrer-policy"] == "no-referrer"
        record = logging.LogRecord(
            "uvicorn.access",
            logging.INFO,
            "",
            0,
            "%s %s %s %s %s",
            (
                "client",
                "GET",
                "/api/v1/lastfm/callback/?state=private-state&token=private-token",
                "1.1",
                307,
            ),
            None,
        )
        RedactLastfmCallback().filter(record)
        assert (
            "private-state" not in record.getMessage()
            and "private-token" not in record.getMessage()
        )


@pytest.mark.parametrize("key", ["not-a-hex-session-key-0123456789Z_", "g" * 32, "s" * 64])
def test_lastfm_session_is_opaque_not_a_hex_signature(settings, authenticated_client, key):
    with authenticated_client(settings) as client:
        providers = client.app.state.providers
        providers.stop()
        enable(
            client, api_key="a" * 32, api_secret="b" * 32, public_url="https://music.example.com"
        )
        providers.request = lambda *_args, **_kwargs: {"session": {"key": key, "name": "listener"}}
        url = client.post("/api/v1/lastfm/authorize", headers=HEADERS).json()["url"]
        callback = parse_qs(urlsplit(url).query)["cb"][0]
        state = parse_qs(urlsplit(callback).query)["state"][0]
        result = client.get(
            "/api/v1/lastfm/callback", params={"state": state, "token": "one-use-token"}
        )
        assert result.status_code == 200
        assert key not in result.text
        status = client.get("/api/v1/lastfm").json()
        assert status["connected"] and not status["scrobble"] and not status["now_playing"]
        assert key not in json.dumps(status)


@pytest.mark.parametrize(
    "session",
    [
        None,
        [],
        {"key": "", "name": "listener"},
        {"key": "s" * 257, "name": "listener"},
        {"key": "s\nsecret", "name": "listener"},
        {"key": "s secret", "name": "listener"},
        {"key": "valid-key", "name": ""},
    ],
)
def test_invalid_lastfm_session_still_cannot_bind(settings, authenticated_client, session):
    with authenticated_client(settings) as client:
        providers = client.app.state.providers
        providers.stop()
        enable(
            client, api_key="a" * 32, api_secret="b" * 32, public_url="https://music.example.com"
        )
        providers.request = lambda *_args, **_kwargs: {"session": session}
        url = client.post("/api/v1/lastfm/authorize", headers=HEADERS).json()["url"]
        state = parse_qs(urlsplit(parse_qs(urlsplit(url).query)["cb"][0]).query)["state"][0]
        result = client.get(
            "/api/v1/lastfm/callback", params={"state": state, "token": "one-use-token"}
        )
        assert result.status_code == 502
        assert not client.get("/api/v1/lastfm").json()["connected"]


@pytest.mark.parametrize(
    "message,expected", [("Track not found", "no_match"), ("Invalid parameters", "failed")]
)
def test_missing_lastfm_track_is_a_result_not_a_network_failure(
    settings, authenticated_client, message, expected
):
    music(settings, "合成无匹配.flac", ["合成艺人"], ["合成艺人"])
    scan_library(settings)
    with authenticated_client(settings) as client:
        providers = client.app.state.providers
        providers.stop()
        enable(client, musicbrainz=False, api_key="a" * 32, api_secret="b" * 32)

        def missing(*_args, **_kwargs):
            raise lastfm_failure({"error": 6, "message": message}, "track.getInfo")

        providers.cached = missing
        track = client.get("/api/v1/tracks").json()["items"][0]
        providers.enqueue([track["id"]])
        providers.step()
        job = client.get("/api/v1/manage/providers/jobs").json()["items"][0]
        assert job["status"] == expected
        assert json.loads(job["warnings"]) == ([] if expected == "no_match" else ["lastfm_error_6"])
