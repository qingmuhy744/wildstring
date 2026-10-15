"""Isolated filesystem settings shared by backend tests."""

from pathlib import Path

import pytest

from wildstring.config import Settings


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
