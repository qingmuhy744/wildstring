"""Isolated filesystem settings shared by backend tests."""

from contextlib import contextmanager
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr

from wildstring.config import Settings
from wildstring.main import create_app


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    music = tmp_path / "music"
    music.mkdir()
    return Settings(
        _env_file=None,
        environment="test",
        data_dir=tmp_path / "data",
        music_dir=music,
    )


@pytest.fixture
def authenticated_client():
    @contextmanager
    def client_for(settings: Settings):
        settings.admin_password = SecretStr("test-admin-password-123")
        with TestClient(create_app(settings)) as client:
            assert (
                client.post(
                    "/api/v1/auth/login",
                    json={"username": "admin", "password": "test-admin-password-123"},
                    headers={"X-Wildstring-Client": "web"},
                ).status_code
                == 200
            )
            yield client

    return client_for
