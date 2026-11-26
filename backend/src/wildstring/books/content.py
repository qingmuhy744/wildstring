"""Book media routes, sharing the same authorization as catalog reads."""

import hashlib
import json
import os
import re
import time
from pathlib import Path
from typing import Annotated, Literal
from urllib.parse import quote
from uuid import uuid4

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Request, UploadFile

from wildstring.books.ebooks import (
    IMAGE_SUFFIXES,
    MAX_EBOOK_BYTES,
    MAX_IMAGE_BYTES,
    normalized_image,
    validate_upload,
)
from wildstring.books.service import EBOOK_SUFFIXES, Books
from wildstring.http_cache import private_image_response
from wildstring.library.fs import open_source
from wildstring.library.sidecar import export_books, write_asset
from wildstring.library.streaming import AudioResponse
from wildstring.library.upload import save_upload_to_temp
from wildstring.permissions import dependency

VISIBLE = """(
    ? = 'owner' OR l.default_access = 'all' OR EXISTS (
        SELECT 1 FROM book_library_access a WHERE a.user_id=? AND a.library_id=l.id
    )
)"""


def book_record(db, identity, user):
    row = db.execute(
        f"""SELECT b.*, l.managed_root FROM books b JOIN book_libraries l ON l.id=b.library_id
        WHERE b.id=? AND {VISIBLE}""",  # nosec B608
        (identity, user["profile"], user["id"]),
    ).fetchone()
    if row is None:
        raise HTTPException(404, "book_not_found")
    return row


def library_record(db, identity, user):
    row = db.execute(
        f"SELECT l.* FROM book_libraries l WHERE l.id=? AND {VISIBLE}",  # nosec B608
        (identity, user["profile"], user["id"]),
    ).fetchone()
    if row is None:
        raise HTTPException(404, "book_library_not_found")
    return row


def ebook_record(db, identity):
    row = db.execute("SELECT * FROM book_ebooks WHERE book_id=?", (identity,)).fetchone()
    if row is None:
        raise HTTPException(404, "ebook_not_found")
    return row


def router(database, settings, auth, transcoding):
    router = APIRouter()
    service = Books(database, settings)
    read = Annotated[dict, Depends(dependency(auth, "books:read"))]
    upload = Annotated[dict, Depends(dependency(auth, "books:upload_ebook"))]
    edit = Annotated[dict, Depends(dependency(auth, "books:write"))]
    manage = Annotated[dict, Depends(dependency(auth, "books:manage_libraries"))]
    client = [Depends(auth.require_client)]
    temporary = settings.data_dir / "book_upload"

    def load_chapter(ebook, number):
        index = next((i for i in range(ebook["spine_count"]) if i == number), None)
        if index is None:
            raise HTTPException(404, "book_chapter_not_found")
        try:
            with open_source(
                service.cache_root, Path(ebook["cache_key"]) / f"{index}.json"
            ) as stream:
                return json.load(stream)
        except OSError as error:
            raise HTTPException(404, "book_chapter_not_found") from error

    def store_ebook(file, library, book_id=None):
        filename = file.filename or ""
        raw_suffix = validate_upload(filename, file.content_type or "", file.file.read(4096))
        suffix = next((ext for ext in sorted(EBOOK_SUFFIXES) if ext == raw_suffix), None)
        if suffix is None:
            raise HTTPException(422, "unsupported_ebook_format")
        file.file.seek(0)
        with service.write(library["id"]):
            if book_id is not None:
                with database.connect(scoped=False) as db:
                    existing = db.execute(
                        "SELECT has_ebook FROM books WHERE id=?", (book_id,)
                    ).fetchone()
                    if existing is None:
                        raise HTTPException(404, "book_not_found")
                    if existing["has_ebook"]:
                        raise HTTPException(409, "book_ebook_already_attached")
            path, _, _ = save_upload_to_temp(file, temporary, MAX_EBOOK_BYTES)
            try:
                with path.open("rb") as stream:
                    stored_id = service.ebook(
                        library, stream, filename, "managed_only", book_id=book_id
                    )
                export_books(database, Path(library["managed_root"]), library["id"], stored_id)
                return stored_id
            finally:
                path.unlink(missing_ok=True)

    @router.post("/book-libraries/{library_id}/scan", dependencies=client)
    def scan(library_id: str, user: manage):
        with database.connect(scoped=False) as db:
            library = library_record(db, library_id, user)
        return service.scan(library)

    @router.post("/book-libraries/{library_id}/export-sidecars", dependencies=client)
    def export_sidecars(library_id: str, user: manage):
        with database.connect(scoped=False) as db:
            library = library_record(db, library_id, user)
        with service.write(library["id"]):
            return {
                "sidecars_written": export_books(
                    database, Path(library["managed_root"]), library["id"]
                )
            }

    @router.get("/book-libraries/{library_id}/scans")
    def scans(library_id: str, user: manage):
        with database.connect(scoped=False) as db:
            library_record(db, library_id, user)
            rows = db.execute(
                "SELECT * FROM book_scan_jobs WHERE library_id=? ORDER BY started_at DESC LIMIT 20",
                (library_id,),
            )
            return {"items": [dict(row) for row in rows]}

    def default_upload_library(db_user):
        with database.connect(scoped=False) as db:
            existing = db.execute(
                f"SELECT l.* FROM book_libraries l WHERE {VISIBLE} AND l.storage_mode='copy'"  # nosec B608
                " ORDER BY l.created_at,l.id LIMIT 1",
                (db_user["profile"], db_user["id"]),
            ).fetchone()
        if existing is not None:
            return existing
        if db_user["profile"] != "owner":
            raise HTTPException(403, "book_upload_library_required")
        with database.connect(write=True) as db:
            db.execute("BEGIN IMMEDIATE")
            existing = db.execute(
                f"SELECT l.* FROM book_libraries l WHERE {VISIBLE} AND l.storage_mode='copy'"  # nosec B608
                " ORDER BY l.created_at,l.id LIMIT 1",
                (db_user["profile"], db_user["id"]),
            ).fetchone()
            if existing is not None:
                return existing
            identity = uuid4().hex
            target = (settings.data_dir / "books" / identity).resolve()
            try:
                target.mkdir(parents=True, exist_ok=True)
            except OSError:
                raise HTTPException(503, "library_storage_unavailable") from None
            stamp = time.time()
            db.execute(
                """INSERT INTO book_libraries(id,name,managed_root,storage_mode,default_access,auto_pair,created_at,updated_at)
                VALUES (?,?,?,?,?,?,?,?)""",
                (identity, "默认书库", str(target), "copy", "restricted", 1, stamp, stamp),
            )
            return db.execute("SELECT * FROM book_libraries WHERE id=?", (identity,)).fetchone()

    @router.post("/books/upload", dependencies=client, status_code=201)
    def upload_ebook(
        user: upload,
        file: Annotated[UploadFile, File()],
        library_id: Annotated[str | None, Form()] = None,
    ):
        requested_id = (library_id or "").strip()
        if requested_id:
            with database.connect(scoped=False) as db:
                library = library_record(db, requested_id, user)
        else:
            library = default_upload_library(user)
        return {"id": store_ebook(file, library)}

    @router.post("/books/{book_id}/ebook", dependencies=client, status_code=201)
    def attach_ebook(book_id: str, user: upload, file: Annotated[UploadFile, File()]):
        with database.connect(scoped=False) as db:
            book = book_record(db, book_id, user)
            library = library_record(db, book["library_id"], user)
            if book["has_ebook"]:
                raise HTTPException(409, "book_ebook_already_attached")
        return {"id": store_ebook(file, library, book["id"])}

    @router.get("/books/{book_id}/ebook/manifest")
    def manifest(book_id: str, user: read):
        with database.connect(scoped=False) as db:
            book_record(db, book_id, user)
            ebook = ebook_record(db, book_id)
            chapters = db.execute(
                """SELECT spine_index,title,level,block_count,char_count,start_global_char
                FROM book_ebook_chapters WHERE book_id=? ORDER BY spine_index""",
                (book_id,),
            )
            return {
                "book_id": book_id,
                "format": ebook["format"],
                "sha256": ebook["sha256"],
                "total_chars": ebook["total_chars"],
                "chapters": [dict(row) for row in chapters],
            }

    @router.get("/books/{book_id}/ebook/chapters/{spine_index}")
    def chapter(book_id: str, spine_index: int, user: read):
        with database.connect(scoped=False) as db:
            book_record(db, book_id, user)
            ebook = ebook_record(db, book_id)
        data = load_chapter(ebook, spine_index)
        return {"spine_index": spine_index, "title": data["title"], "blocks": data["blocks"]}

    @router.get("/books/{book_id}/ebook/search")
    def search(book_id: str, user: read, q: Annotated[str, Query(min_length=1, max_length=200)]):
        with database.connect(scoped=False) as db:
            book_record(db, book_id, user)
            ebook = ebook_record(db, book_id)
        pattern = re.compile(re.escape(q), re.IGNORECASE)
        matches = []
        for spine in range(ebook["spine_count"]):
            for block in load_chapter(ebook, spine)["blocks"]:
                text = block["text"]
                for result in pattern.finditer(text):
                    matches.append(
                        {
                            "spine_index": spine,
                            "block_index": block["block_index"],
                            "char_offset": result.start(),
                            "excerpt": text[max(0, result.start() - 35) : result.end() + 55],
                        }
                    )
                    if len(matches) == 50:
                        return {"items": matches}
        return {"items": matches}

    @router.get("/books/{book_id}/ebook/assets/{asset_path}")
    def asset(book_id: str, asset_path: str, user: read, request: Request):
        with database.connect(scoped=False) as db:
            book_record(db, book_id, user)
            ebook = ebook_record(db, book_id)
        stem, dot, ext = asset_path.partition(".")
        if (
            dot != "."
            or ext != "jpg"
            or not stem.isascii()
            or not stem.isdigit()
            or len(stem) > 6
            or str(int(stem)) != stem
        ):
            raise HTTPException(404, "book_asset_not_found")
        target_name = f"{int(stem)}.jpg"
        cache_dir = service.cache_root / ebook["cache_key"]
        try:
            matched = next(
                (entry.name for entry in os.scandir(cache_dir) if entry.name == target_name),
                None,
            )
            if matched is None:
                raise HTTPException(404, "book_asset_not_found")
            with open_source(service.cache_root, Path(ebook["cache_key"]) / matched) as stream:
                return private_image_response(request, stream.read())
        except OSError as error:
            raise HTTPException(404, "book_asset_not_found") from error

    @router.get("/books/{book_id}/ebook/download")
    @router.head("/books/{book_id}/ebook/download")
    def download(book_id: str, user: read, request: Request):
        with database.connect(scoped=False) as db:
            book = book_record(db, book_id, user)
            ebook = ebook_record(db, book_id)
        filename = quote(f"{book['title']}.{ebook['format']}", safe="")
        return AudioResponse(
            Path(book["managed_root"]),
            {
                "path": ebook["managed_path"],
                "size_bytes": ebook["file_size"],
                "format": ebook["format"],
            },
            request,
            {"Content-Disposition": f"attachment; filename*=UTF-8''{filename}"},
        )

    @router.get("/books/{book_id}/audiobook")
    def audiobook(book_id: str, user: read):
        with database.connect(scoped=False) as db:
            book_record(db, book_id, user)
            audio = db.execute(
                "SELECT total_duration_ms FROM book_audiobooks WHERE book_id=?", (book_id,)
            ).fetchone()
            if audio is None:
                raise HTTPException(404, "audiobook_not_found")
            chapters = db.execute(
                """SELECT chapter_index,file_index,title,start_file_ms,end_file_ms,start_book_ms,
                duration_ms FROM book_audiobook_chapters WHERE book_id=? ORDER BY chapter_index""",
                (book_id,),
            )
            return {"total_duration_ms": audio[0], "chapters": [dict(row) for row in chapters]}

    @router.get("/books/{book_id}/audiobook/files/{file_index}/stream")
    @router.head("/books/{book_id}/audiobook/files/{file_index}/stream")
    def audio(
        book_id: str,
        file_index: int,
        user: read,
        request: Request,
        format: Literal["aac"] | None = None,
        bitrate_kbps: int = 192,
        start_ms: Annotated[int, Query(ge=0)] = 0,
    ):
        with database.connect(scoped=False) as db:
            book = book_record(db, book_id, user)
            file = db.execute(
                "SELECT * FROM book_audiobook_files WHERE book_id=? AND file_index=?",
                (book_id, file_index),
            ).fetchone()
        if file is None:
            raise HTTPException(404, "audio_not_found")
        root = Path(book["managed_root"])
        if format == "aac":
            plan = transcoding.book_plan(book_id, file_index, root, file, bitrate_kbps, start_ms)
            return transcoding.response(plan, request)
        return AudioResponse(
            root,
            {
                "path": file["managed_path"],
                "size_bytes": file["file_size"],
                "format": file["codec"],
            },
            request,
        )

    @router.post("/books/{book_id}/cover", dependencies=client)
    def cover_upload(book_id: str, user: edit, file: Annotated[UploadFile, File()]):
        with database.connect(scoped=False) as db:
            book = book_record(db, book_id, user)
        data = file.file.read(MAX_IMAGE_BYTES + 1)
        if len(data) > MAX_IMAGE_BYTES:
            raise HTTPException(413, "cover_too_large")
        suffix = validate_upload(file.filename or "", file.content_type or "", data)
        if suffix not in IMAGE_SUFFIXES:
            raise HTTPException(422, "book_image_invalid")
        try:
            jpeg = normalized_image(data)
        except (OSError, ValueError) as error:
            raise HTTPException(422, "book_image_invalid") from error
        relative = Path(book["managed_dir"]) / "cover.jpg"
        target_book_id = book["id"]
        with service.write(book["library_id"]):
            write_asset(Path(book["managed_root"]), relative, jpeg)
            with database.connect(write=True) as db:
                db.execute(
                    "UPDATE books SET cover_path=?,cover_hash=?,updated_at=? WHERE id=?",
                    (
                        relative.as_posix(),
                        hashlib.sha256(jpeg).hexdigest(),
                        time.time(),
                        target_book_id,
                    ),
                )
            export_books(database, Path(book["managed_root"]), book["library_id"], target_book_id)
        return {"id": target_book_id}

    @router.get("/books/{book_id}/cover")
    def cover(book_id: str, user: read, request: Request):
        with database.connect(scoped=False) as db:
            book = book_record(db, book_id, user)
        if book["cover_path"]:
            try:
                with open_source(Path(book["managed_root"]), Path(book["cover_path"])) as stream:
                    return private_image_response(request, stream.read())
            except OSError as error:
                raise HTTPException(404, "book_cover_not_found") from error
        raise HTTPException(404, "book_cover_not_found")

    return router
