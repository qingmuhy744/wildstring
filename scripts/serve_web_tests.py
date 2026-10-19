"""Serve a disposable, synthetic music library for browser integration tests."""

import io
import os
import shutil
import subprocess
from pathlib import Path
from tempfile import TemporaryDirectory

import uvicorn
from mutagen.flac import FLAC
from mutagen.id3 import APIC, TALB, TIT2, TPE1, TPE2, TPOS, TRCK, USLT
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
            if index == 1 and os.environ.get("WILDSTRING_TEST_TRANSCODING") == "1":
                lossless = path.with_suffix(".flac")
                subprocess.run(
                    [
                        shutil.which("ffmpeg"),
                        "-nostdin",
                        "-v",
                        "error",
                        "-f",
                        "lavfi",
                        "-i",
                        "sine=frequency=440:duration=25:sample_rate=96000",
                        "-ac",
                        "2",
                        "-c:a",
                        "flac",
                        str(lossless),
                    ],
                    check=True,
                    capture_output=True,
                    timeout=15,
                )
                audio = FLAC(lossless)
                audio["title"] = title
                audio["artist"] = "野弦测试"
                audio["album"] = "合成测试专辑"
                audio["lyrics"] = "[00:00]内嵌第一行\n[00:04]内嵌第二行\n[00:08]内嵌第三行"
                audio.save()
                path.unlink()
        if os.environ.get("WILDSTRING_TEST_LARGE_LIBRARY") == "1":
            for index in range(257):
                path = music / f"multipage-{index:03d}.mp3"
                shutil.copyfile(ROOT / "tests/fixtures/audio/playback.mp3", path)
                audio = MP3(path)
                audio["TIT2"] = TIT2(encoding=3, text=[f"跨页测试曲 {index + 1:03d}"])
                audio["TALB"] = TALB(encoding=3, text=["跨页连续专辑"])
                audio["TPE1"] = TPE1(encoding=3, text=["跨页测试艺人"])
                audio["TPE2"] = TPE2(encoding=3, text=["跨页测试艺人"])
                audio["TRCK"] = TRCK(encoding=3, text=[str(index + 1)])
                audio.save()
        if os.environ.get("WILDSTRING_TEST_BROWSE_LIBRARY") == "1":
            # Real scan/API fixture: each populated letter spans more than a page,
            # and Z cannot be reached from the initially loaded window.
            entries = [
                (
                    f"{prefix}歌曲 {number:03d}",
                    f"{prefix}专辑 {number:03d}",
                    f"{prefix}艺人 {number:03d}",
                    1,
                )
                for prefix in ("Alpha", "北京", "夜晚", "最后")
                for number in range(1, 61)
            ]
            entries.extend(
                (f"紧凑测试曲 {number:02d}", "紧凑测试专辑", "紧凑测试艺人", number)
                for number in range(1, 13)
            )
            entries.extend((name, name, name, 1) for name in ("123 数字", "9 数字", "🎵", "☂"))
            for index, (title, album, artist, number) in enumerate(entries):
                path = music / f"browse-{index:03d}.mp3"
                shutil.copyfile(ROOT / "tests/fixtures/audio/playback.mp3", path)
                audio = MP3(path)
                audio["TIT2"] = TIT2(encoding=3, text=[title])
                audio["TALB"] = TALB(encoding=3, text=[album])
                audio["TPE1"] = TPE1(encoding=3, text=[artist])
                audio["TPE2"] = TPE2(encoding=3, text=[artist])
                audio["TRCK"] = TRCK(encoding=3, text=[str(number)])
                audio.save()
        if os.environ.get("WILDSTRING_TEST_DISC_LIBRARY") == "1":
            for index, title in enumerate(("Zeta", "Beta", "Gamma", "Alpha", "Delta", "Echo")):
                path = music / f"disc-{index}.mp3"
                shutil.copyfile(ROOT / "tests/fixtures/audio/playback.mp3", path)
                audio = MP3(path)
                audio["TIT2"] = TIT2(encoding=3, text=[title])
                audio["TALB"] = TALB(encoding=3, text=["分碟排序专辑"])
                audio["TPE1"] = TPE1(encoding=3, text=["测试艺人"])
                audio["TPE2"] = TPE2(encoding=3, text=["测试艺人"])
                audio["TRCK"] = TRCK(encoding=3, text=[str(index % 3 + 1)])
                audio["TPOS"] = TPOS(encoding=3, text=[str(index // 3 + 1)])
                audio.save()
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
            web_dir=(
                None
                if os.environ.get("WILDSTRING_TEST_API_ONLY") == "1"
                else ROOT / "frontend/web/dist"
            ),
            admin_password=SecretStr("disposable-browser-test-password"),
            cookie_secure=False,
        )
        scan_library(settings)
        uvicorn.run(
            create_app(settings),
            host=os.environ.get("WILDSTRING_WEB_TEST_BIND", "127.0.0.1"),
            port=int(os.environ.get("WILDSTRING_WEB_TEST_PORT", "18782")),
            access_log=False,
        )


if __name__ == "__main__":
    main()
