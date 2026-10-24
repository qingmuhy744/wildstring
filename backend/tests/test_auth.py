"""Authentication, revocation and migration are exercised against a real SQLite database."""

import sqlite3
import time

import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr

from wildstring.auth import COOKIE, Auth, password_hash, token_hash
from wildstring.database import SCHEMA, SCHEMA_VERSION, Database
from wildstring.main import create_app

PASSWORD = "fixture-admin-password"
CLIENT = {"X-Wildstring-Client": "web"}


def login(client, password=PASSWORD):
    return client.post(
        "/api/v1/auth/login", json={"username": "admin", "password": password}, headers=CLIENT
    )


def test_no_default_admin_or_unauthenticated_library_access(settings):
    with TestClient(create_app(settings)) as client:
        status_data = client.get("/api/v1/auth/status").json()
        assert status_data["configured"] is False
        assert status_data["authenticated"] is False
        assert "version" in status_data
        for path in ("tracks", "scans", "tracks/not-a-track/stream"):
            assert client.get(f"/api/v1/{path}").status_code == 401
        assert login(client).status_code == 503
        assert client.get("/health/ready").status_code == 200


def test_persistent_sessions_logout_and_csrf_header(settings):
    settings.admin_password = SecretStr(PASSWORD)
    app = create_app(settings)
    with TestClient(app) as client:
        assert (
            client.post(
                "/api/v1/auth/login", json={"username": "admin", "password": PASSWORD}
            ).status_code
            == 403
        )
        response = login(client)
        assert response.status_code == 200
        cookie = response.headers["set-cookie"].lower()
        assert "httponly" in cookie and "samesite=strict" in cookie
        token = client.cookies[COOKIE]
        assert token not in response.text
        database = Database(settings.data_dir)
        with database.connect() as connection:
            assert connection.execute("SELECT token_hash FROM sessions").fetchone()[
                0
            ] == token_hash(token)
            assert (
                PASSWORD
                not in connection.execute(
                    "SELECT password_hash FROM users WHERE id='admin'"
                ).fetchone()[0]
            )
        assert client.get("/api/v1/tracks").status_code == 200
        assert client.post("/api/v1/auth/logout").status_code == 403
    with TestClient(create_app(settings)) as client:
        client.cookies.set(COOKIE, token)
        assert client.get("/api/v1/tracks").status_code == 200
        assert client.post("/api/v1/auth/logout", headers=CLIENT).status_code == 204
        client.cookies.set(COOKIE, token)
        assert client.get("/api/v1/tracks").status_code == 401


def test_expiration_reset_and_bootstrap_does_not_overwrite(settings):
    settings.admin_password = SecretStr(PASSWORD)
    with TestClient(create_app(settings)) as client:
        assert login(client).status_code == 200
        database = Database(settings.data_dir)
        with database.connect(write=True) as connection:
            connection.execute("UPDATE sessions SET expires_at = ?", (int(time.time()) - 1,))
        assert client.get("/api/v1/tracks").status_code == 401
        assert login(client).status_code == 200
        Auth(database, settings).set_password("a-new-admin-password")
        assert client.get("/api/v1/tracks").status_code == 401
    with TestClient(create_app(settings)) as client:
        assert login(client).status_code == 401
        assert login(client, "a-new-admin-password").status_code == 200


@pytest.mark.parametrize("client_header", ["android", "ios"])
def test_mobile_session_keeps_normal_authentication_and_client_validation(settings, client_header):
    settings.admin_password = SecretStr(PASSWORD)
    mobile = {"X-Wildstring-Client": client_header}
    with TestClient(create_app(settings)) as client:
        assert client.get("/api/v1/tracks").status_code == 401
        assert (
            client.post(
                "/api/v1/auth/login",
                json={"username": "admin", "password": PASSWORD},
                headers={"X-Wildstring-Client": "unknown"},
            ).status_code
            == 403
        )
        assert (
            client.post(
                "/api/v1/auth/login",
                json={"username": "admin", "password": PASSWORD},
                headers=mobile,
            ).status_code
            == 200
        )
        assert client.get("/api/v1/tracks").status_code == 200
        assert client.post("/api/v1/auth/logout").status_code == 403
        assert client.post("/api/v1/auth/logout", headers=mobile).status_code == 204
        assert client.get("/api/v1/tracks").status_code == 401


def test_wrong_password_throttling(settings):
    settings.admin_password = SecretStr(PASSWORD)
    with TestClient(create_app(settings)) as client:
        for _ in range(5):
            assert login(client, "incorrect-password").status_code == 401
        assert login(client).status_code == 429
        database = Database(settings.data_dir)
        with database.connect(write=True) as connection:
            connection.execute("UPDATE login_guard SET blocked_until = ?", (int(time.time()) - 1,))
        assert login(client).status_code == 200


def test_cookie_secure_and_short_password_rejected(settings):
    settings.admin_password = SecretStr(PASSWORD)
    settings.cookie_secure = True
    with TestClient(create_app(settings), base_url="https://testserver") as client:
        response = login(client)
        assert "; Secure" in response.headers["set-cookie"]
        assert client.get("/api/v1/tracks").status_code == 200
    with pytest.raises(ValueError):
        password_hash("short")
    assert password_hash(PASSWORD) != password_hash(PASSWORD)


def test_v1_database_migrates_without_losing_library(settings):
    settings.data_dir.mkdir()
    database = Database(settings.data_dir)
    with sqlite3.connect(database.path) as connection:
        connection.executescript(SCHEMA)
        connection.execute("INSERT INTO libraries VALUES ('existing', '/old-library')")
    database.initialize()
    database.initialize()
    with database.connect() as connection:
        assert connection.execute("SELECT id FROM libraries").fetchone()[0] == "existing"
        assert connection.execute("PRAGMA user_version").fetchone()[0] == SCHEMA_VERSION
    assert database.check_ready()
