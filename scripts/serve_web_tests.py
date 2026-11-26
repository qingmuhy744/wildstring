"""Serve a disposable, synthetic music library for browser integration tests."""

import io
import os
import shutil
import subprocess
from contextlib import contextmanager, nullcontext
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
        if (
            os.environ.get("WILDSTRING_TEST_API_ONLY") == "1"
            or os.environ.get("WILDSTRING_TEST_BOOKSHELF") == "1"
        ):
            seed_bookshelf(settings, root, picture.getvalue())
        if os.environ.get("WILDSTRING_TEST_PUBLISHERS") == "1":
            with Database(settings.data_dir).connect(write=True) as connection:
                for identifier, title, author in (
                    ("publisher-second", "同出品方节目测试", "另一种作者署名"),
                    ("publisher-unconfirmed", "未确认归属节目测试", "野弦测试"),
                ):
                    connection.execute(
                        "INSERT INTO podcasts(id,title,author,feed_url,auto_update,download_policy,created_at) "
                        "VALUES (?,?,?,?,0,'none','2026-10-25')",
                        (
                            identifier,
                            title,
                            author,
                            f"https://example.invalid/{identifier}.xml",
                        ),
                    )
        fixture = (
            google_drive(root, picture.getvalue())
            if os.environ.get("WILDSTRING_TEST_GDRIVE") == "1"
            else nullcontext()
        )
        with fixture as drive:
            app = create_app(settings)
            if drive is not None:
                accounts = app.state.remote_storage.accounts
                accounts.drive_base = accounts.oauth_base = drive.base
            uvicorn.run(
                app,
                host=os.environ.get("WILDSTRING_WEB_TEST_BIND", "127.0.0.1"),
                port=int(os.environ.get("WILDSTRING_WEB_TEST_PORT", "18782")),
                access_log=False,
            )


@contextmanager
def google_drive(root, picture):
    import sys

    sys.path.insert(0, str(ROOT / "backend/tests"))
    from gdrive_test_fixture import drive_fixture

    with drive_fixture() as drive:
        track = root / "cloud-track.mp3"
        shutil.copyfile(ROOT / "tests/fixtures/audio/playback.mp3", track)
        tags = MP3(track)
        tags["TIT2"] = TIT2(encoding=3, text=["云端测试曲"])
        tags["TALB"] = TALB(encoding=3, text=["云端测试专辑"])
        tags.save()
        drive.folder("cloud-music", "Drive Music")
        drive.file("cloud-track", "雾中旅途.mp3", "cloud-music", track.read_bytes())
        drive.folder("cloud-books", "Drive Books")
        drive.file(
            "cloud-ebook",
            "cloud.epub",
            "cloud-books",
            _minimal_epub_bytes("云端读本", "WildString Press", picture),
        )
        tags["TIT2"] = TIT2(encoding=3, text=["云端听书"])
        tags["TALB"] = TALB(encoding=3, text=["云端听书"])
        tags.save()
        drive.file("cloud-audiobook", "story.mp3", "cloud-books", track.read_bytes())
        yield drive


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


def _minimal_epub_bytes(title: str, author: str, cover: bytes) -> bytes:
    from zipfile import ZipFile

    long_paragraph = (
        "The window opened onto the quiet garden where morning light settled across cedar shelves and cotton paper. "
        * 26
    ).strip()
    buf = io.BytesIO()
    with ZipFile(buf, "w") as archive:
        archive.writestr("mimetype", "application/epub+zip")
        archive.writestr(
            "META-INF/container.xml",
            '<container><rootfiles><rootfile full-path="OEBPS/book.opf"/></rootfiles></container>',
        )
        archive.writestr("OEBPS/images/cover.png", cover)
        archive.writestr(
            "OEBPS/ch1.xhtml",
            '<html xmlns="http://www.w3.org/1999/xhtml"><body>'
            "<h1>Chapter 1 — A Window</h1>"
            f"<p>{long_paragraph}</p>"
            "</body></html>",
        )
        archive.writestr(
            "OEBPS/ch2.xhtml",
            '<html xmlns="http://www.w3.org/1999/xhtml"><body>'
            "<h1>Chapter 2 — The Door</h1>"
            "<p>A second room stood beyond the courtyard with warm analog meters.</p>"
            "</body></html>",
        )
        archive.writestr(
            "OEBPS/nav.xhtml",
            '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">'
            '<body><nav epub:type="toc"><ol>'
            '<li><a href="ch1.xhtml">Chapter 1 — A Window</a></li>'
            '<li><a href="ch2.xhtml">Chapter 2 — The Door</a></li>'
            "</ol></nav></body></html>",
        )
        archive.writestr(
            "OEBPS/book.opf",
            "<package><metadata>"
            f"<title>{title}</title>"
            f"<creator>{author}</creator>"
            '<meta name="cover" content="cover-img"/>'
            "</metadata>"
            "<manifest>"
            '<item id="cover-img" href="images/cover.png" media-type="image/png" properties="cover-image"/>'
            '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>'
            '<item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/>'
            '<item id="c2" href="ch2.xhtml" media-type="application/xhtml+xml"/>'
            "</manifest>"
            '<spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>',
        )
    return buf.getvalue()


def _paired_guide_epub_bytes(title: str, author: str, cover: bytes) -> bytes:
    from zipfile import ZipFile

    chapters = (
        (
            "ch1.xhtml",
            "第一章：阅读与听书同行",
            "欢迎体验野弦自托管书架。这段正文包含重点与批注示例，支持滚动、分页切换、句内划词高亮以及自定义颜色。",
            "在同一本书下可以随时切换电子书阅读与有声书收听；切换歌曲或播客后，底部停靠栏会保持清晰的进度与控制。"
            * 6,
        ),
        (
            "ch2.xhtml",
            "第二章：跨页排版与批注",
            "自托管书架的设计初衷，是让个人收藏的文字与声音回到同一个安静的容器里。",
            "无论是单手握持的手机，还是桌面宽屏与平板电脑，双载体书籍都可以分别保存阅读和听书进度，并在另一端进度更新时提供温和的一键对齐提示。"
            * 6,
        ),
        (
            "ch3.xhtml",
            "第三章：暖纸与声音",
            "合上书页时，最近读到的段落与听到的章节都会保留在书架详情中。",
            "继续阅读与继续收听各自保持精确锚点，不会因为章节结构差异而互相静默覆盖。" * 6,
        ),
    )
    buf = io.BytesIO()
    with ZipFile(buf, "w") as archive:
        archive.writestr("mimetype", "application/epub+zip")
        archive.writestr(
            "META-INF/container.xml",
            '<container><rootfiles><rootfile full-path="OEBPS/book.opf"/></rootfiles></container>',
        )
        archive.writestr("OEBPS/images/cover.png", cover)
        nav_items = []
        manifest_items = []
        spine_items = []
        for idx, (filename, heading, lead, body) in enumerate(chapters, start=1):
            archive.writestr(
                f"OEBPS/{filename}",
                '<html xmlns="http://www.w3.org/1999/xhtml"><body>'
                f"<h1>{heading}</h1>"
                f"<p>{lead}</p>"
                f"<p>{body}</p>"
                "</body></html>",
            )
            nav_items.append(f'<li><a href="{filename}">{heading}</a></li>')
            manifest_items.append(
                f'<item id="c{idx}" href="{filename}" media-type="application/xhtml+xml"/>'
            )
            spine_items.append(f'<itemref idref="c{idx}"/>')
        archive.writestr(
            "OEBPS/nav.xhtml",
            '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">'
            f'<body><nav epub:type="toc"><ol>{"".join(nav_items)}</ol></nav></body></html>',
        )
        archive.writestr(
            "OEBPS/book.opf",
            "<package><metadata>"
            f"<title>{title}</title>"
            f"<creator>{author}</creator>"
            '<meta name="cover" content="cover-img"/>'
            "</metadata>"
            "<manifest>"
            '<item id="cover-img" href="images/cover.png" media-type="image/png" properties="cover-image"/>'
            '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>'
            f"{''.join(manifest_items)}"
            "</manifest>"
            f"<spine>{''.join(spine_items)}</spine></package>",
        )
    return buf.getvalue()


def seed_bookshelf(settings: Settings, root: Path, picture: bytes) -> None:
    """Seed ebook-only, audiobook-only, and paired dual-carrier books for bookshelf tests."""
    import time
    from uuid import uuid4

    from wildstring.books.service import Books

    book_src = root / "books_source"
    book_managed = root / "books_managed"
    book_managed.mkdir(parents=True, exist_ok=True)
    ebook_dir = book_src / "portable-pages"
    ebook_dir.mkdir(parents=True, exist_ok=True)
    (ebook_dir / "portable-pages.epub").write_bytes(
        _minimal_epub_bytes("Portable Pages", "WildString Press", picture)
    )
    audio_dir = book_src / "rainy-stories"
    audio_dir.mkdir(parents=True, exist_ok=True)
    (audio_dir / "cover.png").write_bytes(picture)
    for chapter_no, ch_title in enumerate(("第一话：雨夜来信", "第二话：长街回声"), start=1):
        audio = audio_dir / f"0{chapter_no}.mp3"
        shutil.copyfile(ROOT / "tests/fixtures/audio/playback.mp3", audio)
        tags = MP3(audio)
        tags["TIT2"] = TIT2(encoding=3, text=[ch_title])
        tags["TALB"] = TALB(encoding=3, text=["雨夜电台故事集"])
        tags["TPE1"] = TPE1(encoding=3, text=["深夜电台"])
        tags["TPE2"] = TPE2(encoding=3, text=["深夜电台"])
        tags["TRCK"] = TRCK(encoding=3, text=[str(chapter_no)])
        tags.save()
    paired_dir = book_src / "wildstring-guide"
    paired_dir.mkdir(parents=True, exist_ok=True)
    (paired_dir / "cover.png").write_bytes(picture)
    (paired_dir / "wildstring-guide.epub").write_bytes(
        _paired_guide_epub_bytes("野弦漫游指南", "野弦编辑部", picture)
    )
    for chapter_no, ch_title in enumerate(
        ("第一章：阅读与听书同行", "第二章：跨页排版与批注"), start=1
    ):
        audio = paired_dir / f"0{chapter_no}.mp3"
        shutil.copyfile(ROOT / "tests/fixtures/audio/playback.mp3", audio)
        tags = MP3(audio)
        tags["TIT2"] = TIT2(encoding=3, text=[ch_title])
        tags["TALB"] = TALB(encoding=3, text=["野弦漫游指南"])
        tags["TPE1"] = TPE1(encoding=3, text=["野弦编辑部"])
        tags["TPE2"] = TPE2(encoding=3, text=["野弦编辑部"])
        tags["TRCK"] = TRCK(encoding=3, text=[str(chapter_no)])
        tags.save()

    database = Database(settings.data_dir)
    lib_id = uuid4().hex
    now = time.time()
    with database.connect(write=True) as connection:
        connection.execute(
            """INSERT INTO book_libraries(id,name,managed_root,storage_mode,default_access,auto_pair,created_at,updated_at)
               VALUES (?,?,?,'copy','all',0,?,?)""",
            (lib_id, "Synthetic Books", str(book_managed), now, now),
        )
        connection.execute(
            "INSERT INTO book_library_sources(library_id,id,root,watch_enabled) VALUES (?,?,?,1)",
            (lib_id, uuid4().hex, str(book_src)),
        )
        library = dict(
            connection.execute("SELECT * FROM book_libraries WHERE id=?", (lib_id,)).fetchone()
        )
    Books(database, settings).scan(library)


if __name__ == "__main__":
    main()
