"""Serve a disposable, synthetic music library for browser integration tests."""

import shutil
from pathlib import Path
from tempfile import TemporaryDirectory

import uvicorn
from mutagen.id3 import TIT2
from mutagen.mp3 import MP3
from pydantic import SecretStr

from wildstring.config import Settings
from wildstring.library.scanner import scan_library
from wildstring.main import create_app

ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    with TemporaryDirectory(prefix="wildstring-browser-") as temporary:
        root = Path(temporary)
        music = root / "music"
        music.mkdir()
        for index, title in enumerate(("晴天测试曲", "夜晚测试曲")):
            path = music / f"{index}.mp3"
            shutil.copyfile(ROOT / "tests/fixtures/audio/playback.mp3", path)
            tags = MP3(path)
            tags["TIT2"] = TIT2(encoding=3, text=[title])
            tags.save()
        settings = Settings(
            _env_file=None,
            environment="test",
            music_dir=music,
            data_dir=root / "runtime",
            web_dir=ROOT / "frontend/web/dist",
            admin_password=SecretStr("disposable-browser-test-password"),
            cookie_secure=False,
        )
        scan_library(settings)
        uvicorn.run(create_app(settings), host="127.0.0.1", port=18782, access_log=False)


if __name__ == "__main__":
    main()
