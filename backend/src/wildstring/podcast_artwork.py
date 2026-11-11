"""Authenticated fallback for public RSS artwork when clients cannot reach its host."""

import io
import os
import urllib.request
from tempfile import NamedTemporaryFile

from fastapi import HTTPException, Response
from PIL import Image, ImageOps, UnidentifiedImageError

from wildstring.library.assets import MAX_PIXELS
from wildstring.podcast_access import require_programme
from wildstring.podcasts import (
    MAX_COVER_BYTES,
    USER_AGENT,
    PodcastURLRejected,
    podcast_opener,
    validate_remote_url,
)


def jpeg(data):
    try:
        with Image.open(io.BytesIO(data)) as image:
            if (
                image.format not in {"JPEG", "PNG", "WEBP"}
                or image.width * image.height > MAX_PIXELS
            ):
                return None
            image.thumbnail((768, 768), Image.Resampling.LANCZOS)
            output = io.BytesIO()
            ImageOps.exif_transpose(image).convert("RGB").save(output, "JPEG", quality=85)
            return output.getvalue()
    except (OSError, ValueError, UnidentifiedImageError, Image.DecompressionBombError):
        return None


def cover(manager, user_id, podcast_id):
    with manager.database.connect() as db:
        require_programme(db, user_id, podcast_id)
        source = db.execute("SELECT cover_url FROM podcasts WHERE id=?", (podcast_id,)).fetchone()[
            0
        ]
    target = manager._podcast_dir(podcast_id) / "cover.jpg"
    cached = None
    if target.is_file():
        with target.open("rb") as stream:
            data = stream.read(MAX_COVER_BYTES + 1)
        if len(data) <= MAX_COVER_BYTES:
            cached = jpeg(data)
    if cached is None:
        if not source:
            raise HTTPException(404, "podcast_cover_not_found")
        try:
            address = validate_remote_url(source)
            mode, proxy = manager.get_network_policy()
            request = urllib.request.Request(address, headers={"User-Agent": USER_AGENT})
            with podcast_opener(mode, proxy, manager.allow_fake_ip).open(
                request, timeout=15
            ) as response:  # nosec B310
                data = response.read(MAX_COVER_BYTES + 1)
        except PodcastURLRejected:
            raise HTTPException(422, "invalid_podcast_cover_url") from None
        except OSError:
            raise HTTPException(502, "podcast_cover_unavailable") from None
        if len(data) > MAX_COVER_BYTES:
            raise HTTPException(413, "podcast_cover_too_large")
        cached = jpeg(data)
        if cached is None:
            raise HTTPException(502, "podcast_cover_invalid_image")
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = None
        try:
            with NamedTemporaryFile(dir=target.parent, delete=False) as stream:
                temporary = stream.name
                stream.write(cached)
            os.replace(temporary, target)
        finally:
            if temporary is not None and os.path.exists(temporary):
                os.unlink(temporary)
    return Response(
        cached,
        media_type="image/jpeg",
        headers={"Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"},
    )
