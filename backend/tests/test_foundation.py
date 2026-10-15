"""Check deployment behavior without external services or music files."""

import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from wildstring.config import Settings
from wildstring.main import create_app


def test_startup_and_readiness_do_not_modify_music(settings: Settings):
    original = settings.library_dir / "track.txt"
    original.write_bytes(b"fixture, not an audio file")
    with TestClient(create_app(settings)) as client:
        assert client.get("/health").json()["status"] == "ok"
        response = client.get("/health/ready")
        assert response.status_code == 200
        assert response.json()["checks"] == {
            "data_directory": "ok",
            "music_directory": "ok",
            "database": "ok",
        }
        assert (settings.data_dir / "wildstring.sqlite3").is_file()
        assert not list(settings.data_dir.glob("tmp*"))
    assert original.read_bytes() == b"fixture, not an audio file"
    assert list(settings.library_dir.iterdir()) == [original]


def test_missing_music_is_unready_but_process_is_alive(settings: Settings):
    with TestClient(create_app(settings)) as client:
        settings.library_dir.rmdir()
        assert client.get("/health").status_code == 200
        response = client.get("/health/ready")
        assert response.status_code == 503
        assert response.json()["checks"]["music_directory"] == "unavailable"
        assert not settings.library_dir.exists()
        assert str(settings.library_dir) not in response.text


def test_lost_data_mount_is_reported(settings: Settings):
    with TestClient(create_app(settings)) as client:
        settings.data_dir.rename(settings.data_dir.with_name("unmounted-data"))
        response = client.get("/health/ready")
        assert response.status_code == 503
        assert response.json()["checks"]["data_directory"] == "unavailable"
        time.sleep(1.1)
        assert not settings.data_dir.exists()


def test_worker_does_not_recreate_missing_database(settings: Settings):
    with TestClient(create_app(settings)) as client:
        database = settings.data_dir / "wildstring.sqlite3"
        database.rename(database.with_suffix(".unmounted"))
        time.sleep(1.1)
        assert client.get("/health/ready").status_code == 503
        assert not database.exists()


def test_production_does_not_expose_development_docs(settings: Settings):
    settings.environment = "production"
    with TestClient(create_app(settings)) as client:
        assert client.get("/docs").status_code == 404
        assert client.get("/openapi.json").status_code == 404
        assert client.get("/health/ready").status_code == 200


def test_packaged_web_does_not_shadow_health_endpoints(settings: Settings, tmp_path: Path):
    web = tmp_path / "web"
    web.mkdir()
    (web / "index.html").write_text("<html><body>WildString</body></html>")
    settings.web_dir = web
    with TestClient(create_app(settings)) as client:
        assert "WildString" in client.get("/").text
        assert client.get("/health/ready").json()["status"] == "ok"


@pytest.mark.parametrize("port", [0, 65536])
def test_invalid_port_is_rejected(port: int):
    with pytest.raises(ValidationError):
        Settings(_env_file=None, port=port)


def test_runtime_cannot_be_inside_the_music_directory(tmp_path: Path):
    with pytest.raises(ValidationError, match="outside"):
        Settings(_env_file=None, music_dir=tmp_path, data_dir=tmp_path / "runtime")


def test_missing_database_is_reported(settings: Settings):
    with TestClient(create_app(settings)) as client:
        (settings.data_dir / "wildstring.sqlite3").unlink()
        response = client.get("/health/ready")
        assert response.status_code == 503
        assert response.json()["checks"]["database"] == "unavailable"
