"""Account interface language: storage, API, migration and Accept-Language resolution."""

import sqlite3

import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr

from wildstring.agent_ai import SYSTEM_PROMPT
from wildstring.database import SCHEMA_VERSION, Database
from wildstring.main import create_app
from wildstring.user_language_schema import resolve_language

PASSWORD = "fixture-admin-password"
CLIENT = {"X-Wildstring-Client": "web"}


def login(client):
    response = client.post(
        "/api/v1/auth/login", json={"username": "admin", "password": PASSWORD}, headers=CLIENT
    )
    assert response.status_code == 200
    return response.json()


@pytest.mark.parametrize(
    ("preference", "header", "expected"),
    [
        ("zh", "en-US,en;q=0.9", "zh"),
        ("en", "zh-CN,zh;q=0.9", "en"),
        ("auto", "zh-CN,zh;q=0.9,en;q=0.8", "zh"),
        ("auto", "zh-Hant-TW", "zh"),
        ("auto", "en-GB", "en"),
        ("auto", "fr-FR,fr;q=0.9", "en"),
        ("auto", "fr-FR,zh;q=0.5", "zh"),
        ("auto", "en;q=0.4,zh;q=0.8", "zh"),
        ("auto", "zh;q=0,en", "en"),
        ("auto", "", "en"),
        (None, None, "en"),
        ("auto", "*", "en"),
        ("auto", "zh;q=abc", "en"),
    ],
)
def test_resolve_language(preference, header, expected):
    assert resolve_language(preference, header) == expected


def test_language_preference_round_trip_and_status(settings):
    settings.admin_password = SecretStr(PASSWORD)
    with TestClient(create_app(settings)) as client:
        anonymous = client.get("/api/v1/auth/status", headers={"Accept-Language": "zh-CN"})
        assert anonymous.json()["language"] == "zh"
        assert (
            client.get("/api/v1/auth/status", headers={"Accept-Language": "de"}).json()["language"]
            == "en"
        )

        user = login(client)
        assert user["language"] == "auto"
        status = client.get("/api/v1/auth/status", headers={"Accept-Language": "zh-CN"}).json()
        assert status["user"]["language"] == "auto" and status["language"] == "zh"

        updated = client.put("/api/v1/auth/preferences", json={"language": "en"}, headers=CLIENT)
        assert updated.status_code == 200
        assert updated.json()["language"] == "en"
        # The preference must not bump the optimistic profile version.
        assert updated.json()["version"] == user["version"]
        status = client.get("/api/v1/auth/status", headers={"Accept-Language": "zh-CN"}).json()
        assert status["user"]["language"] == "en" and status["language"] == "en"

        for body in ({"language": "fr"}, {"language": "zh", "extra": 1}, {}):
            response = client.put("/api/v1/auth/preferences", json=body, headers=CLIENT)
            assert response.status_code == 422
            assert response.json()["detail"] == "invalid_account_input"
        assert client.put("/api/v1/auth/preferences", json={"language": "zh"}).status_code == 403

        # The profile form keeps working with the same version afterwards.
        profile = client.put(
            "/api/v1/auth/profile",
            json={"version": user["version"], "username": "admin", "display_name": "管理员"},
            headers=CLIENT,
        )
        assert profile.status_code == 200 and profile.json()["language"] == "en"
        listed = client.get("/api/v1/manage/users").json()["items"]
        assert listed[0]["language"] == "en"


def test_language_preference_requires_session(settings):
    settings.admin_password = SecretStr(PASSWORD)
    with TestClient(create_app(settings)) as client:
        response = client.put("/api/v1/auth/preferences", json={"language": "en"}, headers=CLIENT)
        assert response.status_code == 401


def test_schema_43_adds_language_to_existing_users(settings):
    database = Database(settings.data_dir)
    database.initialize()
    with sqlite3.connect(database.path) as connection:
        connection.execute("ALTER TABLE users DROP COLUMN language")
        connection.execute("PRAGMA user_version = 42")
    database.initialize()
    with database.connect() as connection:
        assert connection.execute("PRAGMA user_version").fetchone()[0] == SCHEMA_VERSION == 43
        assert connection.execute("SELECT language FROM users WHERE id='admin'").fetchone()[0] == (
            "auto"
        )
    with database.connect(write=True) as connection, pytest.raises(sqlite3.IntegrityError):
        connection.execute("UPDATE users SET language='fr' WHERE id='admin'")


def test_assistant_answers_in_the_question_language():
    assert "提问所用的语言回答" in SYSTEM_PROMPT
    assert "不要按界面语言切换" in SYSTEM_PROMPT
