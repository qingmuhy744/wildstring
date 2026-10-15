"""Serve a disposable, synthetic music library for browser integration tests."""

import io
import os
import shutil
from pathlib import Path
from tempfile import TemporaryDirectory

import uvicorn
from mutagen.id3 import APIC, TALB, TIT2, TPE1, TPE2, TRCK, USLT
from mutagen.mp3 import MP3
from PIL import Image
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
        picture = io.BytesIO()
        Image.new("RGB", (640, 640), "#8f5b39").save(picture, format="PNG")
        (music / "COVER.PNG").write_bytes(picture.getvalue())
        for index, title in enumerate(("晴天测试曲", "夜晚测试曲")):
            path = music / f"{index}.mp3"
            shutil.copyfile(ROOT / "tests/fixtures/audio/playback.mp3", path)
            tags = MP3(path)
            tags["TIT2"] = TIT2(encoding=3, text=[title])
            tags["TALB"] = TALB(encoding=3, text=["合成测试专辑"])
            tags["TPE1"] = TPE1(
                encoding=3,
                text=["野弦测试", "客席测试"] if index == 0 else ["野弦测试"],
            )
            tags["TPE2"] = TPE2(encoding=3, text=["野弦测试"])
            tags["TRCK"] = TRCK(encoding=3, text=[str(index + 1)])
            tags["USLT::zho"] = USLT(
                encoding=3,
                lang="zho",
                desc="",
                text="[00:00]内嵌第一行\n[00:04]内嵌第二行\n[00:08]内嵌第三行",
            )
            if index == 0:
                tags["APIC:"] = APIC(
                    encoding=3,
                    mime="image/png",
                    type=3,
                    desc="",
                    data=picture.getvalue(),
                )
                path.with_suffix(".lrc").write_text(
                    "[00:00]侧车第一行\n[00:03]侧车第二行\n[00:06]侧车第三行\n[00:09]侧车第四行"
                )
            tags.save()
        source = root / "source"
        source.mkdir()
        (source / "broken.flac").write_bytes(b"Not a valid music file")
        for project in ("desktop", "mobile"):
            pending = source / f"待整理-{project}.mp3"
            shutil.copyfile(ROOT / "tests/fixtures/audio/playback.mp3", pending)
            audio = MP3(pending)
            audio.delete()
        settings = Settings(
            _env_file=None,
            environment="test",
            music_dir=root / "source",
            library_dir=music,
            data_dir=root / "runtime",
            web_dir=ROOT / "frontend/web/dist",
            admin_password=SecretStr("disposable-browser-test-password"),
            cookie_secure=False,
        )
        scan_library(settings)
        uvicorn.run(
            create_app(settings),
            host="127.0.0.1",
            port=int(os.environ.get("WILDSTRING_WEB_TEST_PORT", "18782")),
            access_log=False,
        )


if __name__ == "__main__":
    main()
