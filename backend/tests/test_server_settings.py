"""Real database/API tests for explicit overrides and transport-bound sessions."""

from fastapi.testclient import TestClient
from pydantic import SecretStr

from wildstring.auth import COOKIE, HTTP_COOKIE, HTTPS_COOKIE
from wildstring.database import Database
from wildstring.main import create_app

HEADERS = {"X-Wildstring-Client": "web"}
PASSWORD = "fixture-password-123456"


def login(client, **kwargs):
    return client.post(
        "/api/v1/auth/login",
        json={"username": "admin", "password": PASSWORD},
        headers=HEADERS,
        **kwargs,
    )


def test_per_field_overrides_survive_restart_and_explicit_reset(settings):
    settings.admin_password = SecretStr(PASSWORD)
    settings.server_name = "环境名称"
    with TestClient(create_app(settings)) as client:
        with Database(settings.data_dir).connect() as db:
            assert db.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
        public = client.get("/api/v1/server").json()
        identity = public["instance_id"]
        assert public["name"] == "环境名称"
        assert (
            client.get("/api/v1/server", headers={"X-Wildstring-Library": "missing"}).status_code
            == 200
        )
        assert "sources" not in public
        assert client.get("/api/v1/manage/server").status_code == 401
        assert login(client).status_code == 200
        saved = client.patch("/api/v1/manage/server", json={"name": "页面名称"}, headers=HEADERS)
        assert saved.json()["sources"] == {"name": "database", "connection_policy": "default"}
        for invalid in ({"name": "  "}, {"name": False}, {"connection_policy": "insecure"}):
            assert (
                client.patch("/api/v1/manage/server", json=invalid, headers=HEADERS).status_code
                == 422
            )
    settings.server_name = "新的环境名称"
    with TestClient(create_app(settings)) as client:
        assert client.get("/api/v1/server").json()["instance_id"] == identity
        assert login(client).status_code == 200
        assert client.get("/api/v1/manage/server").json()["name"] == "页面名称"
        reset = client.patch("/api/v1/manage/server", json={"name": None}, headers=HEADERS).json()
        assert reset["name"] == "新的环境名称"
        assert reset["sources"]["name"] == "environment"


def test_independent_protocol_sessions_and_https_only_revocation(settings):
    settings.admin_password = SecretStr(PASSWORD)
    settings.connection_policy = "mixed"
    with TestClient(create_app(settings), base_url="https://testserver") as client:
        secure = login(client)
        assert secure.status_code == 200
        assert "Secure" in secure.headers["set-cookie"]
        secure_token = client.cookies[HTTPS_COOKIE]
        insecure = client.post(
            "http://testserver/api/v1/auth/login",
            json={"username": "admin", "password": PASSWORD},
            headers=HEADERS,
        )
        assert "Secure" not in insecure.headers["set-cookie"]
        insecure_token = client.cookies[HTTP_COOKIE]
        assert client.get("http://testserver/api/v1/tracks").status_code == 200
        # Renaming a cookie does not turn an HTTPS session into an HTTP one.
        client.cookies.clear()
        client.cookies.set(HTTP_COOKIE, secure_token)
        assert client.get("http://testserver/api/v1/tracks").status_code == 401
        client.cookies.clear()
        client.cookies.set(HTTPS_COOKIE, insecure_token)
        assert client.get("/api/v1/tracks").status_code == 401
        client.cookies.clear()
        client.cookies.set(HTTPS_COOKIE, secure_token)
        response = client.patch(
            "/api/v1/manage/server", json={"connection_policy": "https_only"}, headers=HEADERS
        )
        assert response.status_code == 200
        assert client.get("/api/v1/tracks").status_code == 200
        for path in ("/api/v1/auth/login", "/api/v1/tracks", "/mcp"):
            assert (
                client.post("http://testserver" + path, headers=HEADERS).json()["detail"]
                == "https_required"
            )
        assert client.get("http://testserver/health").status_code == 200
        assert client.get("http://testserver/api/v1/server").status_code == 200
        client.patch("/api/v1/manage/server", json={"connection_policy": "mixed"}, headers=HEADERS)
        client.cookies.clear()
        client.cookies.set(HTTP_COOKIE, insecure_token)
        assert client.get("http://testserver/api/v1/tracks").status_code == 401


def test_forwarded_scheme_requires_explicit_proxy_trust(settings):
    settings.admin_password = SecretStr(PASSWORD)
    settings.connection_policy = "https_only"
    forwarded = {**HEADERS, "X-Forwarded-Proto": "https"}
    with TestClient(create_app(settings)) as client:
        response = client.post(
            "/api/v1/auth/login",
            json={"username": "admin", "password": PASSWORD},
            headers=forwarded,
        )
        assert response.status_code == 403
    settings.trusted_proxies = "testclient"
    with TestClient(create_app(settings)) as client:
        response = client.post(
            "/api/v1/auth/login",
            json={"username": "admin", "password": PASSWORD},
            headers=forwarded,
        )
        assert response.status_code == 200
        assert "Secure" in response.headers["set-cookie"]


def test_upgrade_keeps_legacy_session_until_policy_selected(settings):
    settings.admin_password = SecretStr(PASSWORD)
    with TestClient(create_app(settings)) as client:
        assert login(client).status_code == 200
        with Database(settings.data_dir).connect(write=True) as db:
            db.execute("UPDATE sessions SET transport=''")
        assert client.get("/api/v1/tracks").status_code == 200
        assert (
            client.patch(
                "/api/v1/manage/server", json={"connection_policy": "mixed"}, headers=HEADERS
            ).status_code
            == 200
        )
        assert client.get("/api/v1/tracks").status_code == 401
        assert COOKIE in client.cookies
        assert login(client).status_code == 200
        assert client.get("/api/v1/tracks").status_code == 200


def test_database_failure_is_not_environment_fallback(settings):
    settings.connection_policy = "mixed"
    with TestClient(create_app(settings)) as client:
        with Database(settings.data_dir).connect(write=True) as db:
            db.execute("ALTER TABLE server_settings RENAME TO unavailable_settings")
        assert client.get("/api/v1/server").status_code == 503
        assert client.get("/health").status_code == 200


def test_database_policy_overrides_env_and_logout_keeps_other_transport(settings):
    settings.admin_password = SecretStr(PASSWORD)
    settings.connection_policy = "mixed"
    with TestClient(create_app(settings), base_url="https://testserver") as client:
        assert login(client).status_code == 200
        secure_token = client.cookies[HTTPS_COOKIE]
        assert (
            client.post(
                "http://testserver/api/v1/auth/login",
                json={"username": "admin", "password": PASSWORD},
                headers=HEADERS,
            ).status_code
            == 200
        )
        http_token = client.cookies[HTTP_COOKIE]
        assert client.post("/api/v1/auth/logout", headers=HEADERS).status_code == 204
        assert client.cookies[HTTP_COOKIE] == http_token
        assert client.get("http://testserver/api/v1/tracks").status_code == 200
        client.cookies.set(HTTPS_COOKIE, secure_token)
        assert client.get("/api/v1/tracks").status_code == 401
        assert login(client).status_code == 200
        assert (
            client.patch(
                "/api/v1/manage/server", json={"connection_policy": "mixed"}, headers=HEADERS
            ).status_code
            == 200
        )
    settings.connection_policy = "https_only"
    with TestClient(create_app(settings)) as client:
        assert client.get("/api/v1/server").json()["connection_policy"] == "mixed"
        assert login(client).status_code == 200


def test_environment_https_only_invalidates_http_sessions_on_restart(settings):
    settings.admin_password = SecretStr(PASSWORD)
    settings.connection_policy = "mixed"
    with TestClient(create_app(settings)) as client:
        assert login(client).status_code == 200
        token = client.cookies[HTTP_COOKIE]
    settings.connection_policy = "https_only"
    with TestClient(create_app(settings)) as client:
        assert login(client).status_code == 403
    settings.connection_policy = "mixed"
    with TestClient(create_app(settings)) as client:
        client.cookies.set(HTTP_COOKIE, token)
        assert client.get("/api/v1/tracks").status_code == 401


def test_malformed_environment_does_not_override_explicit_database(settings):
    settings.admin_password = SecretStr(PASSWORD)
    with TestClient(create_app(settings), base_url="https://testserver") as client:
        assert login(client).status_code == 200
        assert (
            client.patch(
                "/api/v1/manage/server",
                json={"name": "页面名称", "connection_policy": "mixed"},
                headers=HEADERS,
            ).status_code
            == 200
        )
    settings.server_name = "x" * 500
    settings.connection_policy = "obsolete-setting"
    with TestClient(create_app(settings)) as client:
        assert client.get("/api/v1/server").json()["name"] == "页面名称"
        assert client.get("/api/v1/server").json()["connection_policy"] == "mixed"
