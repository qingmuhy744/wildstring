"""Host restriction is persistent, defaults off and can be recovered only via storage after lockout."""

import pytest

from wildstring.database import Database
from wildstring.site_access import normalize_host

HEADERS = {"X-Wildstring-Client": "web"}
ENDPOINT = "/api/v1/manage/access"


def test_default_off_and_exact_hosts_ignore_forwarded_headers(settings, authenticated_client):
    with authenticated_client(settings) as client:
        assert client.get("/api/v1/tracks", headers={"Host": "anything.example"}).status_code == 200
        record = client.get(ENDPOINT).json()
        assert not record["enabled"] and record["hosts"] == []
        body = {
            "enabled": True,
            "hosts": ["testserver", "MUSIC.Example.", "192.168.10.65", "::1"],
            "version": record["version"],
        }
        assert client.put(ENDPOINT, json=body).status_code == 403
        assert client.put(ENDPOINT, headers=HEADERS, json=body).status_code == 200
        for host in ("music.example", "MUSIC.EXAMPLE:443", "192.168.10.65:18780", "[::1]:18780"):
            assert client.get("/api/v1/tracks", headers={"Host": host}).status_code == 200, host
        for host in (
            "evil.example",
            "music.example.evil",
            "evilmusic.example",
            "music.example:invalid",
            "music.example:0",
            "user@music.example",
            "music.example/path",
            "[::1]evil",
            "music.example?",
        ):
            response = client.get(
                "/api/v1/tracks", headers={"Host": host, "X-Forwarded-Host": "music.example"}
            )
            assert response.status_code == 400, host
        assert (
            client.get(
                "/api/v1/auth/status", headers=[("Host", "music.example"), ("Host", "evil.example")]
            ).status_code
            == 400
        )
        assert client.get("/", headers={"Host": "evil.example"}).status_code == 400
        assert client.put(ENDPOINT, headers=HEADERS, json=body).status_code == 409
    with authenticated_client(settings) as client:
        assert client.get("/api/v1/tracks", headers={"Host": "evil.example"}).status_code == 400


def test_lockout_does_not_exempt_admin_or_auth_and_db_recovers(settings, authenticated_client):
    with authenticated_client(settings) as client:
        body = {
            "enabled": True,
            "hosts": ["music.example"],
            "version": client.get(ENDPOINT).json()["version"],
        }
        assert client.put(ENDPOINT, headers=HEADERS, json=body).status_code == 200
        for path in ("/", "/api/v1/auth/status", ENDPOINT):
            assert client.get(path).status_code == 400
        assert (
            client.put(
                ENDPOINT, headers=HEADERS, json={"enabled": False, "hosts": [], "version": 2}
            ).status_code
            == 400
        )
        assert client.get("/health/ready").status_code == 200
        with Database(settings.data_dir).connect(write=True) as connection:
            connection.execute("UPDATE site_access SET enabled=0,version=version+1 WHERE id=1")
        assert client.get("/api/v1/tracks").status_code == 200
        assert client.get(ENDPOINT).json()["enabled"] is False


@pytest.mark.parametrize(
    "hosts",
    [
        [],
        ["https://music.example"],
        ["music.example:443"],
        ["*.example"],
        ["user@music.example"],
        ["music.example/path"],
        ["bad host"],
    ],
)
def test_reject_invalid_allowlist(settings, authenticated_client, hosts):
    with authenticated_client(settings) as client:
        assert (
            client.put(
                ENDPOINT, headers=HEADERS, json={"enabled": True, "hosts": hosts, "version": 1}
            ).status_code
            == 422
        )
        assert client.get(ENDPOINT).json()["enabled"] is False


def test_idna_and_exact_ip_normalization():
    assert normalize_host("音乐.example") == "xn--fjq180p.example"
    assert normalize_host("2001:0db8::1") == "2001:db8::1"
