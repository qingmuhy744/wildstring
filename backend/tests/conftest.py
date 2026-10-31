"""Isolated filesystem settings shared by backend tests."""

import os
from contextlib import contextmanager
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr

from wildstring.config import Settings
from wildstring.main import create_app


def pytest_configure(config: pytest.Config) -> None:
    # Never let a test app start the start-up identity backfill (it would call Apple).
    # The ``test`` environment already defaults it off; this covers Settings built without it.
    os.environ.setdefault("WILDSTRING_PODCAST_IDENTITY_AUTO_BACKFILL", "false")
    for _key in ("no_proxy", "NO_PROXY"):
        _current = os.environ.get(_key, "")
        _items = [item.strip() for item in _current.split(",") if item.strip()]
        for _host in ("127.0.0.1", "localhost"):
            if _host not in _items:
                _items.append(_host)
        os.environ[_key] = ",".join(_items)


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    music = tmp_path / "music"
    music.mkdir()
    return Settings(
        _env_file=None,
        environment="test",
        data_dir=tmp_path / "data",
        music_dir=tmp_path / "source",
        library_dir=music,
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


def restore_v7_account_layout(connection):
    """Reconstruct the actual historical layout before exercising an older migration."""
    from migration_support import pre18

    pre18(connection)
    connection.execute("DROP VIEW personal_tracks")
    for table in (
        "provider_task_reviews",
        "provider_refresh_members",
        "provider_refresh_batches",
        "metadata_suggestions",
        "provider_jobs",
        "provider_seen",
        "provider_settings",
        "provider_cache",
        "provider_limits",
        "lastfm_auth",
        "lastfm_outbox",
        "lastfm_users",
        "metadata_origins",
        "metadata_history",
        "artwork_choices",
        "track_credits",
        "people",
    ):
        connection.execute(f"DROP TABLE {table}")
    connection.execute("ALTER TABLE tracks DROP COLUMN extra")
    connection.execute("ALTER TABLE listening_sessions DROP COLUMN client_started_at")
    connection.execute("ALTER TABLE listening_sessions DROP COLUMN playback_state")
    password = connection.execute("SELECT password_hash FROM users WHERE id='admin'").fetchone()[0]
    connection.execute("DROP TABLE user_track_state")
    connection.execute("DROP INDEX one_favorites_playlist")
    connection.execute("DROP INDEX playlists_owner")
    connection.execute("DROP INDEX sessions_user_id")
    for table in ("sessions", "playlists", "listening_sessions"):
        connection.execute(f"ALTER TABLE {table} DROP COLUMN user_id")
    connection.execute(
        "CREATE UNIQUE INDEX one_favorites_playlist ON playlists(library_id) WHERE kind='favorites'"
    )
    connection.execute("DROP TABLE users")
    connection.execute(
        "CREATE TABLE admin(id INTEGER PRIMARY KEY CHECK(id=1),password_hash TEXT NOT NULL)"
    )
    if password is not None:
        connection.execute("INSERT INTO admin VALUES (1,?)", (password,))
    connection.execute("DROP TABLE track_lyrics")
    connection.execute("DROP TABLE site_access")
    connection.execute("DROP TABLE transcoding_cache")
    connection.execute("DROP TABLE transcoding_settings")
