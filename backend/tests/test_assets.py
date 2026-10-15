"""Exercise real embedded tags, image fallback and deterministic local lyric rules."""

import hashlib
import io
import shutil
from pathlib import Path

import pytest
from mutagen.flac import FLAC, Picture
from mutagen.id3 import APIC, SYLT, USLT
from mutagen.mp3 import MP3
from mutagen.mp4 import MP4, MP4Cover
from PIL import Image

from wildstring.database import Database
from wildstring.library.assets import MAX_COVER_BYTES
from wildstring.library.lyrics import MAX_TEXT_BYTES, decode_text, parse_lyrics
from wildstring.library.repository import LibraryRepository
from wildstring.library.scanner import scan_library

FIXTURES = Path(__file__).resolve().parents[2] / "tests/fixtures/audio"


def image(color="red", size=(640, 480)):
    buffer = io.BytesIO()
    Image.new("RGB", size, color).save(buffer, format="PNG")
    return buffer.getvalue()


def audio(settings, suffix="flac"):
    path = settings.library_dir / f"測試.{suffix}"
    shutil.copyfile(FIXTURES / f"silence.{suffix}", path)
    return path


def url(settings):
    scan_library(settings)
    track = LibraryRepository(Database(settings.data_dir), settings.library_dir).tracks()["items"][
        0
    ]
    return f"/api/v1/tracks/{track['id']}"


def put_picture(path, data, kind=3):
    tags = FLAC(path)
    picture = Picture()
    picture.type = kind
    picture.mime = "image/png"
    picture.data = data
    tags.add_picture(picture)
    tags.save()


def put_lyrics(path, text):
    tags = FLAC(path)
    tags["lyrics"] = text
    tags.save()


@pytest.mark.parametrize("suffix", ["flac", "mp3", "m4a"])
def test_embedded_cover_is_a_bounded_jpeg_without_music_writes(
    settings, authenticated_client, suffix
):
    path = audio(settings, suffix)
    red = image()
    if suffix == "flac":
        put_picture(path, image("blue"), kind=4)
        put_picture(path, red)
    elif suffix == "mp3":
        tags = MP3(path)
        tags["APIC:"] = APIC(encoding=3, mime="image/png", type=3, desc="", data=red)
        tags.save()
    else:
        tags = MP4(path)
        tags["covr"] = [MP4Cover(red, imageformat=MP4Cover.FORMAT_PNG)]
        tags.save()
    (settings.library_dir / "cover.png").write_bytes(image("green"))
    endpoint = url(settings)
    before = hashlib.sha256(path.read_bytes()).hexdigest()
    with authenticated_client(settings) as client:
        response = client.get(endpoint + "/cover?size=96")
        assert response.status_code == 200
        assert response.headers["content-type"] == "image/jpeg"
        assert response.headers["x-wildstring-cover-source"] == "embedded"
        with Image.open(io.BytesIO(response.content)) as thumbnail:
            assert max(thumbnail.size) == 96
            r, g, b = thumbnail.getpixel((0, 0))
            assert r > 200 and g < 30 and b < 30
        assert client.get(endpoint + "/cover?size=96").content == response.content
        assert len(list((settings.data_dir / "covers").glob("*.jpg"))) == 1
        assert client.get(endpoint + "/cover?size=9999").status_code == 422
    assert hashlib.sha256(path.read_bytes()).hexdigest() == before


def test_directory_cover_case_priority_corruption_and_refresh(settings, authenticated_client):
    path = audio(settings)
    put_picture(path, b"invalid embedded picture")
    cover = settings.library_dir / "COVER.PNG"
    cover.write_bytes(image("red"))
    (settings.library_dir / "folder.jpg").write_bytes(image("blue"))
    endpoint = url(settings)
    with authenticated_client(settings) as client:
        first = client.get(endpoint + "/cover")
        assert first.headers["x-wildstring-cover-source"] == "directory"
        cover.write_bytes(image("green"))
        assert client.get(endpoint + "/cover").content != first.content
        # Song-specific art takes precedence over shared directory art.
        path.with_suffix(".webp").write_bytes(image("yellow"))
        specific = client.get(endpoint + "/cover").content
        path.with_suffix(".webp").unlink()
        cover.write_bytes(b"<svg><script>alert(1)</script></svg>")
        assert client.get(endpoint + "/cover").content != specific
        (settings.library_dir / "folder.jpg").unlink()
        assert client.get(endpoint + "/cover").status_code == 404


def test_sidecar_size_and_symlink_limits(settings, authenticated_client, tmp_path):
    path = audio(settings)
    endpoint = url(settings)
    outside = tmp_path / "outside.png"
    outside.write_bytes(image())
    (settings.library_dir / "cover.png").symlink_to(outside)
    path.with_suffix(".lrc").symlink_to(outside)
    (settings.library_dir / "folder.jpg").write_bytes(b"x" * (MAX_COVER_BYTES + 1))
    with authenticated_client(settings) as client:
        assert client.get(endpoint + "/cover").status_code == 404
        assert client.get(endpoint + "/lyrics").json()["kind"] == "none"
        path.with_suffix(".lrc").unlink()
        path.with_suffix(".lrc").write_bytes(b"x" * (MAX_TEXT_BYTES + 1))
        assert client.get(endpoint + "/lyrics").json()["kind"] == "none"
        path.unlink()
        assert client.get(endpoint + "/lyrics").status_code == 409


def test_sidecar_lrc_overrides_embedded_and_supports_chinese_encodings(
    settings, authenticated_client
):
    path = audio(settings)
    put_lyrics(path, "[00:01]内嵌测试")
    endpoint = url(settings)
    before = path.read_bytes()
    sidecar = path.with_suffix(".LRC")
    sidecar.write_bytes("[00:02.123]外置繁體測試".encode("gb18030"))
    with authenticated_client(settings) as client:
        response = client.get(endpoint + "/lyrics")
        assert response.json() == {
            "kind": "synced",
            "source": "sidecar_lrc",
            "lines": [{"time_ms": 2123, "text": "外置繁體測試"}],
        }
        sidecar.write_text("[00:03]更新歌词", encoding="utf-16")
        assert client.get(endpoint + "/lyrics").json()["lines"][0]["time_ms"] == 3000
        sidecar.unlink()
        assert client.get(endpoint + "/lyrics").json()["source"] == "embedded"
    assert path.read_bytes() == before


@pytest.mark.parametrize("suffix", ["flac", "mp3", "m4a"])
def test_embedded_plain_or_lrc_lyrics(settings, authenticated_client, suffix):
    path = audio(settings, suffix)
    if suffix == "flac":
        put_lyrics(path, "[00:01]第一句\n[00:02]第二句")
    elif suffix == "mp3":
        tags = MP3(path)
        tags["USLT::zho"] = USLT(encoding=3, lang="zho", desc="", text="纯文本测试\n没有时间轴")
        tags.save()
    else:
        tags = MP4(path)
        tags["\xa9lyr"] = ["纯文本测试\n没有时间轴"]
        tags.save()
    endpoint = url(settings)
    with authenticated_client(settings) as client:
        result = client.get(endpoint + "/lyrics").json()
        assert result["source"] == "embedded"
        assert result["kind"] == ("synced" if suffix == "flac" else "plain")
        if suffix != "flac":
            assert all(line["time_ms"] is None for line in result["lines"])


def test_sylt_milliseconds_and_plain_file_fallback(settings, authenticated_client):
    path = audio(settings, "mp3")
    tags = MP3(path)
    tags["SYLT::zho"] = SYLT(
        encoding=3, lang="zho", format=2, type=1, desc="", text=[("第一句", 500), ("第二句", 1000)]
    )
    tags.save()
    endpoint = url(settings)
    with authenticated_client(settings) as client:
        assert client.get(endpoint + "/lyrics").json()["lines"][0]["time_ms"] == 500
        tags.tags.delall("SYLT")
        tags.save()
        scan_library(settings)
        path.with_suffix(".txt").write_text("纯文本测试\n第二行")
        assert client.get(endpoint + "/lyrics").json()["kind"] == "plain"
        path.with_suffix(".txt").unlink()
        path.with_suffix(".lryc").write_text("[00:03]兼容扩展名")
        assert client.get(endpoint + "/lyrics").json()["source"] == "sidecar_lrc"


def test_lrc_timestamps_offsets_translation_and_invalid_text():
    result = parse_lyrics(
        "[ar:测试]\n[offset:+100]\n[00:01.2][00:03.234]重复句\n[00:01.200]译文\n[00:02.23]中间句\n[00:04]",
        "sidecar_lrc",
    )
    assert result["lines"] == [
        {"time_ms": 1100, "text": "重复句\n译文"},
        {"time_ms": 2130, "text": "中间句"},
        {"time_ms": 3134, "text": "重复句"},
        {"time_ms": 3900, "text": ""},
    ]
    assert parse_lyrics("[offset:-200]\n[00:00.1]延后", "embedded")["lines"][0]["time_ms"] == 300
    assert (
        parse_lyrics("[00:01]<00:01.2>逐字<00:01.4>标签", "embedded")["lines"][0]["text"]
        == "逐字标签"
    )
    assert parse_lyrics("[ar:测试]", "embedded")["kind"] == "none"
    assert parse_lyrics("x" * (MAX_TEXT_BYTES + 1), "embedded")["kind"] == "none"
    assert decode_text(b"\x00\xff\x00") is None
