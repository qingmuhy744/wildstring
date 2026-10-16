"""Read local tags without writing to the music file."""

import math
import re
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path
from typing import BinaryIO

from mutagen import File
from mutagen.flac import FLAC
from mutagen.mp3 import MP3
from mutagen.mp4 import MP4
from mutagen.wave import WAVE

from wildstring.library.tag_fields import TagReader

SUPPORTED_SUFFIXES = {".mp3", ".flac", ".m4a"}


@dataclass(frozen=True)
class Metadata:
    title: str
    title_source: str
    artists: list[str]
    album: str | None
    album_artists: list[str]
    track_number: int | None
    disc_number: int | None
    duration_ms: int
    format: str
    sample_rate: int | None
    channels: int | None
    has_cover: bool
    details: dict = field(default_factory=dict)


def normalize(value: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", value).casefold().split())


def number(value: str | None) -> int | None:
    match = re.match(r"^(\d+)", value or "")
    return int(match[1]) if match else None


def read_metadata(source: BinaryIO, path: Path) -> Metadata:
    audio = File(source)
    if not isinstance(audio, MP3 | FLAC | MP4 | WAVE):
        raise ValueError("Unsupported or invalid audio")
    tags = audio.tags or {}
    reader = TagReader(audio)

    def values(id3: str, vorbis: str, mp4: str) -> list[str]:
        if isinstance(audio, MP3 | WAVE):
            frame = tags.get(id3)
            raw = frame.text if frame is not None else []
        else:
            raw = tags.get(vorbis if isinstance(audio, FLAC) else mp4, [])
        return list(dict.fromkeys(text for value in raw if (text := str(value).strip())))

    def first(id3: str, vorbis: str, mp4: str) -> str | None:
        return next(iter(values(id3, vorbis, mp4)), None)

    def sequence(id3: str, vorbis: str, mp4: str) -> int | None:
        if isinstance(audio, MP4):
            pair = tags.get(mp4, [])
            return int(pair[0][0]) or None if pair else None
        return number(first(id3, vorbis, mp4))

    duration = float(audio.info.length)
    if not math.isfinite(duration) or duration <= 0:
        raise ValueError("Audio has no valid duration")
    if isinstance(audio, MP3):
        format_name, cover = "mp3", bool(audio.tags and audio.tags.getall("APIC"))
    elif isinstance(audio, WAVE):
        format_name, cover = "wav", bool(audio.tags and audio.tags.getall("APIC"))
    elif isinstance(audio, FLAC):
        format_name, cover = "flac", bool(audio.pictures)
    else:
        format_name, cover = "m4a", bool(tags.get("covr"))
    title = first("TIT2", "title", "\xa9nam")
    return Metadata(
        title=title or path.stem,
        title_source="tag" if title else "filename",
        artists=reader.artists(),
        album=first("TALB", "album", "\xa9alb"),
        album_artists=reader.artists(album=True),
        track_number=sequence("TRCK", "tracknumber", "trkn"),
        disc_number=sequence("TPOS", "discnumber", "disk"),
        duration_ms=round(duration * 1000),
        format=format_name,
        sample_rate=getattr(audio.info, "sample_rate", None),
        channels=getattr(audio.info, "channels", None),
        has_cover=cover,
        details=reader.details(),
    )
