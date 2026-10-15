"""Private, versioned AI settings and a bounded probe; no external provider calls."""

import json
import stat

import pytest
from fastapi.testclient import TestClient

from wildstring import ai_config
from wildstring.main import create_app

HEADERS = {"X-Wildstring-Client": "web"}
BASE = "/api/v1/manage/ai"
KEY = "unit-test-private-key"


def payload(**changes):
    return {
        "version": 1,
        "base_url": "https://model.example/v1",
        "model": "test-model",
        "timeout": 12,
        "api_key": KEY,
    } | changes


def test_secret_storage_retention_clear_and_versioning(settings, authenticated_client):
    with TestClient(create_app(settings)) as client:
        assert client.get(BASE).status_code == 401
        assert client.put(BASE, headers=HEADERS, json=payload()).status_code == 401
    with authenticated_client(settings) as client:
        assert client.get(BASE).json()["configured"] is False
        assert client.post(BASE + "/test", headers=HEADERS).status_code == 409
        assert client.put(BASE, json=payload()).status_code == 403
        saved = client.put(BASE, headers=HEADERS, json=payload())
        assert saved.status_code == 200 and saved.json()["has_api_key"]
        assert KEY not in saved.text and "api_key" not in saved.json()
        path = settings.data_dir / "ai" / ".env"
        assert stat.S_IMODE(path.stat().st_mode) == 0o600
        assert KEY in path.read_text()
        assert client.put(BASE, headers=HEADERS, json=payload()).status_code == 409
        kept = client.put(BASE, headers=HEADERS, json=payload(version=2, api_key=None))
        assert kept.json()["has_api_key"]
        assert KEY in path.read_text()
        assert KEY not in client.get(BASE).text
    with authenticated_client(settings) as client:
        current = client.get(BASE).json()
        assert current["version"] == 3 and current["model"] == "test-model"
        cleared = client.put(
            BASE, headers=HEADERS, json=payload(version=3, api_key=None, clear_api_key=True)
        )
        assert not cleared.json()["has_api_key"] and KEY not in path.read_text()


@pytest.mark.parametrize(
    "url",
    [
        "file:///etc/passwd",
        "https://user:secret@host/v1",
        "https://host/v1?key=secret",
        "https://host/v1#x",
        "https://host:invalid/v1",
        "https://host/\r\nx",
    ],
)
def test_invalid_config_does_not_echo_secret(settings, authenticated_client, url):
    with authenticated_client(settings) as client:
        response = client.put(BASE, headers=HEADERS, json=payload(base_url=url))
        assert response.status_code == 422 and KEY not in response.text
        assert client.get(BASE).json()["configured"] is False
        response = client.put(BASE, headers=HEADERS, json=[{"api_key": KEY}])
        assert response.status_code == 422 and KEY not in response.text


def test_probe_only_sends_minimal_request_and_sanitizes_failures(
    settings, authenticated_client, monkeypatch
):
    calls = []

    class Response:
        status = 200

        def read(self, amount):
            assert amount == 65537
            return b'{"choices":[{"message":{"content":"OK"}}]}'

    class Connection:
        def __init__(self, host, port, timeout):
            assert host == "model.example" and timeout == 12

        def request(self, method, path, body, headers):
            calls.append((method, path, json.loads(body), headers))

        def getresponse(self):
            return Response()

        def close(self):
            pass

    monkeypatch.setattr(ai_config.http.client, "HTTPSConnection", Connection)
    with authenticated_client(settings) as client:
        assert client.put(BASE, headers=HEADERS, json=payload()).status_code == 200
        assert client.post(BASE + "/test").status_code == 403
        response = client.post(BASE + "/test", headers=HEADERS)
        assert response.status_code == 200 and response.json()["ok"]
        assert KEY not in response.text
        method, path, body, headers = calls[0]
        assert method == "POST" and path == "/v1/chat/completions"
        assert body["messages"] == [{"role": "user", "content": "Reply OK."}]
        assert headers["Authorization"] == "Bearer " + KEY
        Response.status = 302
        failed = client.post(BASE + "/test", headers=HEADERS)
        assert failed.status_code == 502 and KEY not in failed.text
        assert len(calls) == 2  # Redirect is not followed with the credential.
        Response.status = 200
        monkeypatch.setattr(Response, "read", lambda *_: b"[]")
        assert client.post(BASE + "/test", headers=HEADERS).status_code == 502

        def unavailable(*_):
            raise OSError(KEY)

        monkeypatch.setattr(Connection, "getresponse", unavailable)
        assert KEY not in client.post(BASE + "/test", headers=HEADERS).text
