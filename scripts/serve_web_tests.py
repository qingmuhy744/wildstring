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
from wildstring.database import Database
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
        web = root / "web"
        if os.environ.get("WILDSTRING_TEST_API_ONLY") != "1":
            # Keep this server's assets stable while another independent check rebuilds dist.
            shutil.copytree(ROOT / "frontend/web/dist", web)
        settings = Settings(
            _env_file=None,
            environment="test",
            music_dir=root / "source",
            library_dir=music,
            data_dir=root / "runtime",
            web_dir=(None if os.environ.get("WILDSTRING_TEST_API_ONLY") == "1" else web),
            admin_password=SecretStr("disposable-browser-test-password"),
            cookie_secure=False,
        )
        scan_library(settings)
        if os.environ.get("WILDSTRING_TEST_LIBRARIES") == "1":
            from wildstring.library.catalog import LibraryCatalog, LibraryInput

            extra_source = root / "classical-source"
            extra_source.mkdir()
            catalog = LibraryCatalog(Database(settings.data_dir), settings)
            catalog.initialize()
            second = catalog.save(LibraryInput(name="古典测试库", source_roots=[str(extra_source)]))
            second_root = Path(second["managed_root"])
            path = second_root / "classical.mp3"
            shutil.copyfile(ROOT / "tests/fixtures/audio/playback.mp3", path)
            tags = MP3(path)
            tags["TIT2"] = TIT2(encoding=3, text=["跨库测试曲"])
            tags["TALB"] = TALB(encoding=3, text=["跨库测试专辑"])
            tags.save()
            scan_library(settings.model_copy(update={"library_dir": second_root}))
        if os.environ.get("WILDSTRING_TEST_PODCAST") == "1":
            seed_podcast(settings, picture.getvalue())
        if os.environ.get("WILDSTRING_TEST_PUBLISHERS") == "1":
            with Database(settings.data_dir).connect(write=True) as connection:
                for identifier, title, author in (
                    ("publisher-second", "同出品方节目测试", "另一种作者署名"),
                    ("publisher-unconfirmed", "未确认归属节目测试", "野弦测试"),
                ):
                    connection.execute(
                        "INSERT INTO podcasts(id,title,author,feed_url,auto_update,download_policy,created_at) "
                        "VALUES (?,?,?,?,0,'none','2026-10-25')",
                        (identifier, title, author, f"https://example.invalid/{identifier}.xml"),
                    )
        uvicorn.run(
            create_app(settings),
            host=os.environ.get("WILDSTRING_WEB_TEST_BIND", "127.0.0.1"),
            port=int(os.environ.get("WILDSTRING_WEB_TEST_PORT", "18782")),
            access_log=False,
        )


def seed_podcast(settings: Settings, picture: bytes) -> None:
    """Local audio and inline art keep the podcast UI regression fully offline."""
    import base64

    settings.podcasts_dir.mkdir(parents=True, exist_ok=True)
    database = Database(settings.data_dir)
    with database.connect(write=True) as connection:
        connection.execute(
            "INSERT INTO podcasts (id,title,author,feed_url,cover_url,auto_update,"
            "download_policy,created_at) VALUES (?,?,?,?,?,0,'none',?)",
            (
                "radio-test",
                "午后广播测试",
                "野弦测试",
                "https://example.invalid/radio-test.xml",
                "data:image/png;base64," + base64.b64encode(picture).decode(),
                "2026-01-01T00:00:00Z",
            ),
        )
        for number in range(1, 7):
            audio = settings.podcasts_dir / f"radio-{number}.mp3"
            shutil.copyfile(ROOT / "tests/fixtures/audio/playback.mp3", audio)
            connection.execute(
                "INSERT INTO podcast_episodes (id,podcast_id,guid,title,description,"
                "audio_url,duration_seconds,pub_date,episode_number,created_at,"
                "local_path,download_status) VALUES (?,'radio-test',?,?,?, ?,25,?,?,?,?,'downloaded')",
                (
                    f"radio-{number}",
                    f"radio-{number}",
                    f"第 {number} 集：给午后的一封声音来信",
                    "<p>在旧收音机的刻度之间，留一点时间听故事。</p>"
                    "<h3>本期话题</h3><p>[00:05] 从声音到记忆</p>" * 12,
                    "https://example.invalid/audio.mp3",
                    f"2026-01-{number:02d}T00:00:00Z",
                    number,
                    "2026-01-01T00:00:00Z",
                    str(audio),
                ),
            )
        connection.execute(
            "INSERT INTO podcast_episodes (id,podcast_id,guid,title,description,"
            "audio_url,duration_seconds,pub_date,created_at,download_status) "
            "VALUES ('radio-online','radio-test','radio-online',"
            "'在线单集：还没有下载','可在全部单集中找到',"
            "'https://example.invalid/not-downloaded.mp3',25,"
            "'2025-12-31T00:00:00Z','2025-12-31T00:00:00Z','none')"
        )


if __name__ == "__main__":
    main()
