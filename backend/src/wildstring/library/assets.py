"""Read embedded art/lyrics or bounded sidecars; only derived thumbnails are written."""

import hashlib
import io
import os
import re
from contextlib import suppress
from pathlib import Path
from tempfile import NamedTemporaryFile

from fastapi import HTTPException
from mutagen import File, MutagenError
from mutagen.flac import FLAC
from mutagen.mp3 import MP3
from mutagen.mp4 import MP4
from PIL import Image, ImageOps, UnidentifiedImageError

from wildstring.library.lyrics import (
    MAX_TEXT_BYTES,
    decode_text,
    no_lyrics,
    parse_lyrics,
    synced_lines,
)
from wildstring.library.repository import LibraryRepository
from wildstring.library.scanner import fingerprint, open_source

MAX_COVER_BYTES = 8 * 1024 * 1024
MAX_PIXELS = 20_000_000
IMAGE_SUFFIXES = (".jpg", ".jpeg", ".png", ".webp")


class TrackAssets:
    def __init__(self, repository: LibraryRepository):
        self.repository = repository
        self.cache = repository.database.path.parent / "covers"

    def source(self, track_id: str) -> tuple[Path, object]:
        record = self.repository.source(track_id)
        if record is None:
            raise HTTPException(404, "track_not_found")
        if record["status"] != "available":
            raise HTTPException(409, "track_unavailable")
        relative = Path(record["path"])
        try:
            with open_source(self.repository.root, relative) as source:
                before = os.fstat(source.fileno())
                if (before.st_size, before.st_mtime_ns) != (
                    record["size_bytes"],
                    record["mtime_ns"],
                ):
                    raise HTTPException(409, "file_changed_rescan_required")
                audio = File(source)
                if fingerprint(os.fstat(source.fileno())) != fingerprint(before):
                    raise HTTPException(409, "file_changed_rescan_required")
                return relative, audio
        except (OSError, MutagenError, ValueError, TypeError, IndexError, OverflowError) as error:
            raise HTTPException(409, "asset_source_unavailable") from error

    def candidates(self, relative: Path, stems: list[str], suffixes: tuple[str, ...]):
        ranks = {
            (stem.casefold() + suffix): (index, extension)
            for index, stem in enumerate(stems)
            for extension, suffix in enumerate(suffixes)
        }
        try:
            with os.scandir(self.repository.root / relative.parent) as entries:
                names = [
                    entry.name
                    for entry in entries
                    if entry.name.casefold() in ranks and entry.is_file(follow_symlinks=False)
                ]
        except OSError:
            return
        for name in sorted(names, key=lambda item: (*ranks[item.casefold()], item)):
            yield relative.parent / name

    def read_sidecar(self, relative: Path, limit: int) -> bytes | None:
        try:
            with open_source(self.repository.root, relative) as source:
                before = os.fstat(source.fileno())
                if before.st_size > limit:
                    return None
                data = source.read(limit + 1)
                if len(data) <= limit and fingerprint(os.fstat(source.fileno())) == fingerprint(
                    before
                ):
                    return data
        except OSError:
            return None
        return None

    def thumbnail(self, data: bytes, size: int) -> bytes | None:
        if not data or len(data) > MAX_COVER_BYTES:
            return None
        size = 96 if size <= 96 else 320 if size <= 320 else 768
        key = hashlib.sha256(data).hexdigest()
        target = self.cache / f"{key}-{size}.jpg"
        try:
            if target.is_file():
                return target.read_bytes()
            with Image.open(io.BytesIO(data)) as original:
                if (
                    original.format not in {"JPEG", "PNG", "WEBP"}
                    or original.width * original.height > MAX_PIXELS
                ):
                    return None
                original.thumbnail((size, size), Image.Resampling.LANCZOS)
                image = ImageOps.exif_transpose(original).convert("RGB")
                output = io.BytesIO()
                image.save(output, format="JPEG", quality=85, optimize=True)
                result = output.getvalue()
        except (OSError, ValueError, UnidentifiedImageError, Image.DecompressionBombError):
            return None
        # Content hashes deduplicate shared album art; atomic replacement is safe across requests.
        self.cache.mkdir(parents=True, exist_ok=True)
        temporary = None
        try:
            with NamedTemporaryFile(dir=self.cache, delete=False) as stream:
                temporary = Path(stream.name)
                stream.write(result)
            temporary.replace(target)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
        return result

    def cover(
        self, track_id: str, size: int = 320, *, inherit: bool = True
    ) -> tuple[bytes, str] | None:
        with self.repository.database.connect() as connection:
            choice = connection.execute(
                "SELECT filename FROM artwork_choices WHERE track_id=?", (track_id,)
            ).fetchone()
        if choice and choice[0] and re.fullmatch("[a-f0-9]{64}", choice[0]):
            with suppress(OSError):
                data = (self.repository.database.path.parent / "artwork" / choice[0]).read_bytes()
                if result := self.thumbnail(data, size):
                    return result, "chosen"
        result = self.local_cover(track_id, size)
        if result or not inherit:
            return result
        with self.repository.database.connect() as connection:
            siblings = connection.execute(
                "SELECT id FROM tracks WHERE id<>? AND album_id=(SELECT album_id FROM tracks WHERE id=?) AND status='available' AND (has_cover=1 OR EXISTS(SELECT 1 FROM artwork_choices a WHERE a.track_id=tracks.id AND a.filename IS NOT NULL)) ORDER BY coalesce(disc_number,1),coalesce(track_number,99999),id LIMIT 20",
                (track_id, track_id),
            ).fetchall()
        for sibling in siblings:
            try:
                if result := self.cover(sibling[0], size, inherit=False):
                    return result[0], "album"
            except HTTPException:
                continue
        return None

    def local_cover(self, track_id: str, size: int = 320) -> tuple[bytes, str] | None:
        relative, audio = self.source(track_id)
        embedded = []
        if isinstance(audio, FLAC):
            embedded = sorted(audio.pictures, key=lambda picture: picture.type != 3)
        elif isinstance(audio, MP3) and audio.tags:
            embedded = sorted(audio.tags.getall("APIC"), key=lambda picture: picture.type != 3)
        elif isinstance(audio, MP4):
            for picture in (audio.tags or {}).get("covr", []):
                if result := self.thumbnail(bytes(picture), size):
                    return result, "embedded"
        for picture in embedded:
            if result := self.thumbnail(picture.data, size):
                return result, "embedded"
        for path in self.candidates(
            relative, [relative.stem, "cover", "folder", "front"], IMAGE_SUFFIXES
        ):
            data = self.read_sidecar(path, MAX_COVER_BYTES)
            if data is not None and (result := self.thumbnail(data, size)):
                return result, "directory"
        return None

    def lyrics(self, track_id: str, *, include_override: bool = True) -> dict:
        relative, audio = self.source(track_id)
        if include_override:
            with self.repository.database.connect() as connection:
                row = connection.execute(
                    "SELECT text,selected_candidate FROM track_lyrics WHERE track_id=?", (track_id,)
                ).fetchone()
                if row is not None and row["selected_candidate"]:
                    from wildstring.library.online_lyrics import selected_lyrics

                    selected = selected_lyrics(connection, row["selected_candidate"])
                    if selected is not None:
                        return selected
            if row is not None and row["text"] is not None:
                return parse_lyrics(row["text"], "user")
        for path in self.candidates(relative, [relative.stem], (".lrc", ".lryc")):
            data = self.read_sidecar(path, MAX_TEXT_BYTES)
            text = decode_text(data) if data is not None else None
            if text is not None:
                result = parse_lyrics(text, "sidecar_lrc")
                if result["kind"] != "none":
                    return result
        tags = getattr(audio, "tags", None) or {}
        texts = []
        if isinstance(audio, FLAC):
            texts = [
                value
                for key in ("syncedlyrics", "lyrics", "unsyncedlyrics", "unsynced lyrics")
                for value in tags.get(key, [])
            ]
        elif isinstance(audio, MP3) and audio.tags:
            for frame in sorted(audio.tags.getall("SYLT"), key=lambda item: item.type != 1):
                if frame.format == 2 and frame.text:
                    return synced_lines(
                        [(timestamp, text.strip()) for text, timestamp in frame.text], "embedded"
                    )
            texts = [frame.text for frame in audio.tags.getall("USLT")]
        elif isinstance(audio, MP4):
            texts = tags.get("\xa9lyr", [])
        plain = None
        for text in texts:
            result = parse_lyrics(str(text), "embedded")
            if result["kind"] == "synced":
                return result
            if result["kind"] == "plain" and plain is None:
                plain = result
        if plain is not None:
            return plain
        for path in self.candidates(relative, [relative.stem], (".txt",)):
            data = self.read_sidecar(path, MAX_TEXT_BYTES)
            text = decode_text(data) if data is not None else None
            if text is not None:
                result = parse_lyrics(text, "sidecar_text")
                if result["kind"] != "none":
                    return result
        return no_lyrics()
