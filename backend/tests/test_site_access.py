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


def test_mcp_responses_are_not_cacheable_even_if_host_is_denied(settings, authenticated_client):
    with authenticated_client(settings) as client:
        for path in ("/mcp", "/mcp/"):
            response = client.post(path, json={}, follow_redirects=False)
            assert response.headers["cache-control"] == "no-store"
        policy = {"enabled": True, "hosts": ["testserver"], "version": 1}
        assert client.put(ENDPOINT, headers=HEADERS, json=policy).status_code == 200
        denied = client.get("/mcp", headers={"Host": "disallowed.example"})
        assert denied.status_code == 400
        assert denied.headers["cache-control"] == "no-store"


def test_unscoped_connection_guards_and_single_connection_library_access(settings, monkeypatch):
    from contextvars import ContextVar

    from fastapi.testclient import TestClient
    from pydantic import SecretStr

    from wildstring.library import scope as scope_module
    from wildstring.library.scanner import scan_library
    from wildstring.main import create_app

    scan_library(settings)
    database = Database(settings.data_dir)
    with pytest.raises(ValueError, match="scoped=False requires a read-only connection"):
        with database.connect(write=True, scoped=False):
            pass
    with pytest.raises(ValueError, match="scoped=False requires a read-only connection"):
        with database.connect(create=True, scoped=False):
            pass

    scope_calls = []
    original_configure_scope = scope_module.configure_scope

    def tracked_configure(connection, user_id):
        scope_calls.append(user_id)
        return original_configure_scope(connection, user_id)

    monkeypatch.setattr(scope_module, "configure_scope", tracked_configure)
    with database.connect(scoped=False) as connection:
        assert connection.execute("SELECT 1").fetchone()[0] == 1
    assert scope_calls == []

    # Isolate request-path DB calls from lifespan background worker threads.
    in_http_request: ContextVar[bool] = ContextVar("in_http_request", default=False)
    app = create_app(settings)

    class TrackedHttpApp:
        def __init__(self, inner):
            self.inner = inner

        async def __call__(self, scope, receive, send):
            token = in_http_request.set(scope.get("type") == "http")
            try:
                return await self.inner(scope, receive, send)
            finally:
                in_http_request.reset(token)

    settings.admin_password = SecretStr("test-admin-password-123")
    with TestClient(TrackedHttpApp(app)) as client:
        assert (
            client.post(
                "/api/v1/auth/login",
                json={"username": "admin", "password": "test-admin-password-123"},
                headers=HEADERS,
            ).status_code
            == 200
        )
        calls = []
        original_connect = Database.connect

        def tracked_connect(self, *, write=False, create=False, scoped=True):
            if in_http_request.get():
                calls.append((write, create, scoped))
            return original_connect(self, write=write, create=create, scoped=scoped)

        monkeypatch.setattr(Database, "connect", tracked_connect)
        assert client.get("/api/v1/auth/status").status_code == 200
        # 1: HostAllowlist / SiteAccess.read (scoped=False)
        # 2: ConnectionSecurity / ServerSettings.read (scoped=False)
        # 3: LibraryAccess single merged session + context check (scoped=False)
        # 4: auth_status route ServerSettings.public -> ServerSettings.read (scoped=False)
        # 5: auth_status route Auth.configured (scoped=False)
        assert calls == [(False, False, False)] * 5

        # Authenticated oversized JSON POST returns 413 with fingerprint using scoped=False.
        oversized = b'{"name":"' + b"a" * (2 * 1024 * 1024 + 32) + b'"}'
        calls.clear()
        rejected = client.post(
            "/api/v1/playlists",
            headers={**HEADERS, "Content-Type": "application/json"},
            content=oversized,
        )
        assert rejected.status_code == 413
        assert "X-Wildstring-Library-Access" in rejected.headers
        assert calls and all(scoped is False for _, _, scoped in calls)

        # Invalid session cookie still passes through to public auth routes.
        client.cookies.clear()
        client.cookies.set("wildstring_session", "invalid-token")
        status_response = client.get("/api/v1/auth/status")
        assert status_response.status_code == 200
        assert status_response.json()["authenticated"] is False

        # Unauthenticated oversized JSON body is rejected by downstream auth without
        # triggering LibraryAccess._visible_for or buffering 2 MB in middleware.
        calls.clear()
        response = client.post(
            "/api/v1/playlists",
            headers={**HEADERS, "Content-Type": "application/json"},
            content=oversized,
        )
        assert response.status_code == 401
        assert "X-Wildstring-Library-Access" not in response.headers
        assert calls and all(scoped is False for _, _, scoped in calls)
