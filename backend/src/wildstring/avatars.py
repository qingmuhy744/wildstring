"""Private, normalized account pictures, independent of music and library metadata."""

import hashlib
import io
import os
from tempfile import NamedTemporaryFile

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import FileResponse
from PIL import Image, ImageOps, UnidentifiedImageError
from starlette.concurrency import run_in_threadpool

MAX_BYTES = 5 * 1024 * 1024
MAX_PIXELS = 25_000_000


def normalize(data):
    try:
        with Image.open(io.BytesIO(data)) as source:
            if (
                source.format not in {"JPEG", "PNG", "WEBP"}
                or source.width * source.height > MAX_PIXELS
            ):
                raise ValueError
            oriented = ImageOps.exif_transpose(source)
            picture = ImageOps.fit(oriented.convert("RGBA"), (256, 256), Image.Resampling.LANCZOS)
            clean = Image.new("RGB", picture.size, "white")
            clean.paste(picture, mask=picture.getchannel("A"))
            output = io.BytesIO()
            clean.save(output, format="JPEG", quality=90)
            return output.getvalue()
    except (UnidentifiedImageError, Image.DecompressionBombError, OSError, ValueError):
        raise HTTPException(422, "invalid_avatar") from None


def router(auth):
    routes = APIRouter(prefix="/avatar")
    session = Depends(auth.require_session)
    directory = auth.settings.data_dir / "avatars"

    def path(user):
        return directory / (hashlib.sha256(user["id"].encode()).hexdigest() + ".jpg")

    def info(user):
        target = path(user)
        return {
            "version": hashlib.sha256(target.read_bytes()).hexdigest() if target.is_file() else None
        }

    @routes.get("/info")
    def details(response: Response, user=session):
        response.headers["Cache-Control"] = "no-store"
        return info(user)

    @routes.get("")
    def picture(user=session):
        target = path(user)
        if not target.is_file():
            raise HTTPException(404, "avatar_not_found")
        return FileResponse(
            target,
            media_type="image/jpeg",
            headers={"Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"},
        )

    @routes.post("", dependencies=[Depends(auth.require_client)])
    async def upload(request: Request, response: Response, user=session):
        data = bytearray()
        async for chunk in request.stream():
            if len(data) + len(chunk) > MAX_BYTES:
                raise HTTPException(413, "avatar_too_large")
            data.extend(chunk)
        encoded = await run_in_threadpool(normalize, bytes(data))
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        with NamedTemporaryFile(dir=directory, suffix=".tmp", delete=False) as ready:
            pending = ready.name
            try:
                ready.write(encoded)
                ready.flush()
                os.replace(pending, path(user))
            finally:
                if os.path.exists(pending):
                    os.unlink(pending)
        response.headers["Cache-Control"] = "no-store"
        return info(user)

    @routes.delete("", status_code=204, dependencies=[Depends(auth.require_client)])
    def remove(user=session):
        path(user).unlink(missing_ok=True)
        return Response(status_code=204, headers={"Cache-Control": "no-store"})

    return routes
