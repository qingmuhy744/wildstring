"""Book library registration and authenticated catalog reads."""

import time
from typing import Annotated, Literal
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field

from wildstring.books.content import VISIBLE
from wildstring.books.content import router as content_router
from wildstring.books.metadata import router as metadata_router
from wildstring.books.pairing import router as pairing_router
from wildstring.books.progress import router as progress_router
from wildstring.library.catalog import normalize_source_roots
from wildstring.library.import_files import HardlinkError, validate_hardlink_capability
from wildstring.library.storage import LibraryStorage, MigrationInput, overlapping
from wildstring.permissions import dependency

LIBRARY_FIELDS = "l.id, l.name, l.storage_mode, l.auto_pair, l.version"
BOOK_FIELDS = "b.id, b.library_id, b.title, b.subtitle, b.has_ebook, b.has_audiobook"


def public_book(row):
    item = dict(row)
    item["has_ebook"] = bool(item["has_ebook"])
    item["has_audiobook"] = bool(item["has_audiobook"])
    return item


class BookLibraryInput(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    name: str = Field(min_length=1, max_length=100)
    source_roots: list[Annotated[str, Field(min_length=1, max_length=4096)]] = Field(
        default_factory=list, max_length=32
    )
    managed_root: str | None = Field(default=None, min_length=1, max_length=4096)
    storage_mode: Literal["copy", "hardlink"] = "copy"
    default_access: Literal["all", "restricted"] = "restricted"
    auto_pair: bool = Field(default=True, strict=True)


class BookLibraryGrant(BaseModel):
    model_config = ConfigDict(extra="forbid")
    granted: bool = Field(strict=True)


def router(catalog, auth, transcoding):
    database = catalog.database
    storage = LibraryStorage(catalog, book=True)
    router = APIRouter(prefix="/api/v1", tags=["books"])
    book_reader = Annotated[dict, Depends(dependency(auth, "books:read"))]

    @router.get("/book-libraries")
    def list_libraries(user: book_reader):
        with database.connect(scoped=False) as db:
            rows = db.execute(
                f"SELECT {LIBRARY_FIELDS} FROM book_libraries l WHERE {VISIBLE}"  # nosec B608
                " ORDER BY l.name,l.id",
                (user["profile"], user["id"]),
            )
            return {"items": [dict(row, auto_pair=bool(row["auto_pair"])) for row in rows]}

    @router.post(
        "/book-libraries",
        dependencies=[Depends(auth.require_owner), Depends(auth.require_client)],
        status_code=201,
    )
    def create_library(body: BookLibraryInput):
        identity = uuid4().hex
        sources = normalize_source_roots(body.source_roots)
        default_root = catalog.settings.data_dir / "books" / identity
        target = storage.destination(body.managed_root or default_root, sources, collection="books")
        if body.storage_mode == "hardlink":
            try:
                validate_hardlink_capability(
                    sources,
                    target,
                    {".epub", ".txt", ".mp3", ".m4a", ".m4b", ".flac", ".ogg", ".opus"},
                )
            except HardlinkError as error:
                raise HTTPException(422, error.code) from error
            except OSError as error:
                raise HTTPException(422, "hardlink_not_supported") from error
        reserved_roots = [catalog.settings.data_dir, *storage.reserved_roots()]
        stamp = time.time()
        with database.connect(write=True) as db:
            db.execute("BEGIN IMMEDIATE")
            storage.available(db, target)
            for source in sources:
                if any(overlapping(source, reserved) for reserved in reserved_roots):
                    raise HTTPException(422, "library_sources_overlap")
                storage.available(db, source, error="library_sources_overlap")
            try:
                target.mkdir(parents=True, exist_ok=True)
            except OSError:
                raise HTTPException(503, "library_storage_unavailable") from None
            db.execute(
                """INSERT INTO book_libraries(id,name,managed_root,storage_mode,default_access,auto_pair,created_at,updated_at)
                VALUES (?,?,?,?,?,?,?,?)""",
                (
                    identity,
                    body.name,
                    str(target),
                    body.storage_mode,
                    body.default_access,
                    body.auto_pair,
                    stamp,
                    stamp,
                ),
            )
            db.executemany(
                "INSERT INTO book_library_sources(library_id,id,root) VALUES (?,?,?)",
                [(identity, uuid4().hex, str(source)) for source in sources],
            )
        return {
            "id": identity,
            "name": body.name,
            "managed_root": str(target),
            "default_access": body.default_access,
            "auto_pair": body.auto_pair,
            "storage_mode": body.storage_mode,
            "version": 1,
        }

    @router.put(
        "/book-libraries/{library_id}/access/{user_id}",
        dependencies=[Depends(auth.require_client)],
    )
    def set_grant(
        library_id: str,
        user_id: str,
        body: BookLibraryGrant,
        owner: Annotated[dict, Depends(auth.require_owner)],
    ):
        with database.connect(write=True) as db:
            db.execute("BEGIN IMMEDIATE")
            if (
                db.execute("SELECT 1 FROM book_libraries WHERE id=?", (library_id,)).fetchone()
                is None
            ):
                raise HTTPException(404, "book_library_not_found")
            if db.execute("SELECT 1 FROM users WHERE id=?", (user_id,)).fetchone() is None:
                raise HTTPException(404, "user_not_found")
            if body.granted:
                db.execute(
                    """INSERT INTO book_library_access(library_id,user_id,granted_by,created_at)
                    VALUES (?,?,?,?) ON CONFLICT(library_id,user_id) DO NOTHING""",
                    (library_id, user_id, owner["id"], time.time()),
                )
            else:
                db.execute(
                    "DELETE FROM book_library_access WHERE library_id=? AND user_id=?",
                    (library_id, user_id),
                )
        return body

    @router.get(
        "/book-libraries/{library_id}/migrations", dependencies=[Depends(auth.require_owner)]
    )
    def migrations(library_id: str):
        return storage.listing(library_id)

    @router.post(
        "/book-libraries/{library_id}/migrations",
        dependencies=[Depends(auth.require_client)],
        status_code=202,
    )
    def migrate(
        library_id: str, body: MigrationInput, owner: Annotated[dict, Depends(auth.require_owner)]
    ):
        return storage.submit(library_id, body, owner)

    @router.post(
        "/book-libraries/{library_id}/migrations/{job_id}/retry",
        dependencies=[Depends(auth.require_client)],
        status_code=202,
    )
    def retry(library_id: str, job_id: str, owner: Annotated[dict, Depends(auth.require_owner)]):
        return storage.retry(library_id, job_id, owner)

    @router.get("/books")
    def list_books(
        user: book_reader,
        library_id: str | None = None,
        limit: Annotated[int, Query(ge=1, le=100)] = 50,
        offset: Annotated[int, Query(ge=0)] = 0,
    ):
        with database.connect(scoped=False) as db:
            if (
                library_id is not None
                and db.execute(
                    f"SELECT 1 FROM book_libraries l WHERE l.id=? AND {VISIBLE}",  # nosec B608
                    (library_id, user["profile"], user["id"]),
                ).fetchone()
                is None
            ):
                raise HTTPException(404, "book_library_not_found")
            rows = db.execute(
                f"""SELECT {BOOK_FIELDS},
                    MAX(CASE WHEN r.completed=0 THEN r.updated_at ELSE 0 END,
                        CASE WHEN a.completed=0 THEN a.updated_at ELSE 0 END) AS progress_at,
                    CASE WHEN r.completed=0 AND (a.completed IS NOT 0 OR r.updated_at>=a.updated_at)
                         THEN 'reading' WHEN a.completed=0 THEN 'listening' END AS resume_kind,
                    CASE WHEN r.completed=0 OR a.completed=0 THEN 'in_progress'
                         WHEN r.completed=1 OR a.completed=1 THEN 'finished' ELSE 'unread' END AS progress_status
                FROM books b JOIN book_libraries l ON l.id=b.library_id
                LEFT JOIN book_reading_progress r ON r.book_id=b.id AND r.user_id=?
                LEFT JOIN book_listening_progress a ON a.book_id=b.id AND a.user_id=?
                WHERE {VISIBLE} AND (? IS NULL OR l.id=?)
                ORDER BY progress_at DESC,b.sort_title,b.id LIMIT ? OFFSET ?""",  # nosec B608
                (
                    user["id"],
                    user["id"],
                    user["profile"],
                    user["id"],
                    library_id,
                    library_id,
                    limit,
                    offset,
                ),
            )
            return {"items": [public_book(row) for row in rows]}

    @router.get("/books/{book_id}")
    def get_book(book_id: str, user: book_reader):
        with database.connect(scoped=False) as db:
            row = db.execute(
                f"""SELECT {BOOK_FIELDS} FROM books b JOIN book_libraries l ON l.id=b.library_id
                WHERE b.id=? AND {VISIBLE}""",  # nosec B608
                (book_id, user["profile"], user["id"]),
            ).fetchone()
        if row is None:
            raise HTTPException(404, "book_not_found")
        return public_book(row)

    router.include_router(content_router(database, catalog.settings, auth, transcoding))
    router.include_router(progress_router(database, auth))
    router.include_router(metadata_router(database, catalog.settings, auth))
    router.include_router(pairing_router(database, catalog.settings, auth))
    return router
