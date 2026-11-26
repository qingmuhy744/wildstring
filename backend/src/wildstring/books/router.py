"""Book library registration and authenticated catalog reads."""

import json
import time
from pathlib import Path
from typing import Annotated, Literal
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field

from wildstring.books.content import VISIBLE
from wildstring.books.content import router as content_router
from wildstring.books.metadata import router as metadata_router
from wildstring.books.pairing import router as pairing_router
from wildstring.books.progress import BOOK_PROGRESS_FIELDS, BOOK_PROGRESS_JOINS
from wildstring.books.progress import router as progress_router
from wildstring.library.catalog import normalize_source_roots
from wildstring.library.fs import registered_source_paths
from wildstring.library.import_files import HardlinkError, validate_hardlink_capability
from wildstring.library.storage import LibraryStorage, MigrationInput, overlapping
from wildstring.permissions import dependency

LIBRARY_FIELDS = "l.id, l.name, l.storage_mode, l.default_access, l.auto_pair, l.version"
BOOK_FIELDS = (
    "b.id, b.library_id, b.title, b.subtitle, b.authors_json, "
    "b.cover_path, b.has_ebook, b.has_audiobook"
)
BOOK_MEDIA_SUFFIXES = {".epub", ".txt", ".mp3", ".m4a", ".m4b", ".flac", ".ogg", ".opus"}


def public_book(row):
    item = dict(row)
    item["authors"] = json.loads(item.pop("authors_json", "[]"))
    item["has_cover"] = bool(item.pop("cover_path", None))
    item["has_ebook"] = bool(item["has_ebook"])
    item["has_audiobook"] = bool(item["has_audiobook"])
    item.pop("progress_at", None)
    for kind in ("reading_progress", "listening_progress"):
        item[kind] = json.loads(item[kind]) if item[kind] is not None else None
    return item


class BookLibraryInput(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    name: str = Field(min_length=1, max_length=100)
    source_roots: list[Annotated[str, Field(min_length=1, max_length=4096)]] = Field(
        default_factory=list, max_length=32
    )
    paused_source_roots: list[Annotated[str, Field(min_length=1, max_length=4096)]] | None = Field(
        default=None, max_length=32
    )
    managed_root: str | None = Field(default=None, min_length=1, max_length=4096)
    storage_mode: Literal["copy", "hardlink"] = "copy"
    default_access: Literal["all", "restricted"] = "restricted"
    auto_pair: bool = Field(default=True, strict=True)


class BookLibraryUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    name: str = Field(min_length=1, max_length=100)
    source_roots: list[Annotated[str, Field(min_length=1, max_length=4096)]] = Field(
        default_factory=list, max_length=32
    )
    paused_source_roots: list[Annotated[str, Field(min_length=1, max_length=4096)]] | None = Field(
        default=None, max_length=32
    )
    managed_root: str | None = Field(default=None, min_length=1, max_length=4096)
    storage_mode: Literal["copy", "hardlink"] | None = None
    default_access: Literal["all", "restricted"] | None = None
    auto_pair: bool | None = Field(default=None, strict=True)
    version: int = Field(ge=1, strict=True)


class BookLibraryGrant(BaseModel):
    model_config = ConfigDict(extra="forbid")
    granted: bool = Field(strict=True)


def _normalize_paused_roots(
    raw_paused: list[str] | None, source_roots: list[str], sources: list[Path]
) -> set[str]:
    try:
        return registered_source_paths(raw_paused or [], source_roots, sources)
    except ValueError:
        raise HTTPException(422, "library_source_invalid") from None


def _check_book_source_overlaps(
    db, catalog, storage: LibraryStorage, sources: list[Path], *, library_id: str | None = None
) -> None:
    reserved = [
        catalog.settings.data_dir.resolve(),
        *storage.reserved_roots(),
        *LibraryStorage.managed_roots(db),
        *(Path(row[0]).resolve() for row in db.execute("SELECT root FROM library_sources")),
        *(
            Path(row[0]).resolve()
            for row in db.execute(
                "SELECT root FROM book_library_sources WHERE (? IS NULL OR library_id<>?)",
                (library_id, library_id),
            )
        ),
    ]
    for source in sources:
        if any(overlapping(source, other) for other in reserved):
            raise HTTPException(422, "library_sources_overlap")


def _serialize_library(db, row, *, owner: bool) -> dict:
    item = dict(row, auto_pair=bool(row["auto_pair"]))
    if owner:
        item["sources"] = [
            dict(src)
            for src in db.execute(
                "SELECT id, root, watch_enabled FROM book_library_sources WHERE library_id=? ORDER BY id",
                (row["id"],),
            )
        ]
    else:
        item.pop("managed_root", None)
    return item


def router(
    catalog,
    auth,
    transcoding,
    *,
    podcasts=None,
    search_gate=None,
    allow_fake_ip: bool = False,
):
    database = catalog.database
    storage = LibraryStorage(catalog, book=True)
    router = APIRouter(prefix="/api/v1", tags=["books"])
    book_reader = Annotated[dict, Depends(dependency(auth, "books:read"))]

    @router.get("/book-libraries")
    def list_libraries(user: book_reader):
        is_owner = user["profile"] == "owner"
        fields = f"{LIBRARY_FIELDS}, l.managed_root" if is_owner else LIBRARY_FIELDS
        with database.connect(scoped=False) as db:
            rows = db.execute(
                f"SELECT {fields} FROM book_libraries l WHERE {VISIBLE}"  # nosec B608
                " ORDER BY l.name,l.id",
                (user["profile"], user["id"]),
            ).fetchall()
            return {"items": [_serialize_library(db, row, owner=is_owner) for row in rows]}

    @router.post(
        "/book-libraries",
        dependencies=[Depends(auth.require_owner), Depends(auth.require_client)],
        status_code=201,
    )
    def create_library(body: BookLibraryInput):
        identity = uuid4().hex
        sources = normalize_source_roots(body.source_roots)
        paused = _normalize_paused_roots(body.paused_source_roots, body.source_roots, sources)
        default_root = catalog.settings.data_dir / "books" / identity
        target = storage.destination(
            body.managed_root or default_root, sources, collection="books"
        ).path
        if body.storage_mode == "hardlink":
            try:
                validate_hardlink_capability(sources, target, BOOK_MEDIA_SUFFIXES)
            except HardlinkError as error:
                raise HTTPException(422, error.code) from error
            except OSError as error:
                raise HTTPException(422, "hardlink_not_supported") from error
        stamp = time.time()
        with database.connect(write=True) as db:
            db.execute("BEGIN IMMEDIATE")
            storage.available(db, target)
            _check_book_source_overlaps(db, catalog, storage, sources)
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
                "INSERT INTO book_library_sources(library_id,id,root,watch_enabled) VALUES (?,?,?,?)",
                [
                    (identity, uuid4().hex, str(source), int(str(source) not in paused))
                    for source in sources
                ],
            )
            row = db.execute(
                f"SELECT {LIBRARY_FIELDS}, l.managed_root FROM book_libraries l WHERE l.id=?",  # nosec B608
                (identity,),
            ).fetchone()
            return _serialize_library(db, row, owner=True)

    @router.put(
        "/book-libraries/{library_id}",
        dependencies=[Depends(auth.require_owner), Depends(auth.require_client)],
    )
    def update_library(library_id: str, body: BookLibraryUpdate):
        with database.connect(scoped=False) as db:
            old = db.execute("SELECT * FROM book_libraries WHERE id=?", (library_id,)).fetchone()
        if old is None:
            raise HTTPException(404, "book_library_not_found")
        old_root = Path(old["managed_root"]).resolve()
        if body.managed_root is not None:
            if not Path(body.managed_root).is_absolute():
                raise HTTPException(422, "library_target_invalid")
            if Path(body.managed_root) != old_root:
                raise HTTPException(409, "library_migration_required")
        if body.storage_mode is not None and body.storage_mode != old["storage_mode"]:
            raise HTTPException(409, "library_migration_required")
        sources = normalize_source_roots(body.source_roots)
        paused = _normalize_paused_roots(body.paused_source_roots, body.source_roots, sources)
        if old["storage_mode"] == "hardlink":
            try:
                validate_hardlink_capability(sources, old_root, BOOK_MEDIA_SUFFIXES)
            except HardlinkError as error:
                raise HTTPException(422, error.code) from error
            except OSError as error:
                raise HTTPException(422, "hardlink_not_supported") from error
        stamp = time.time()
        with database.connect(write=True) as db:
            db.execute("BEGIN IMMEDIATE")
            storage.check_busy(db, library_id)
            _check_book_source_overlaps(db, catalog, storage, sources, library_id=library_id)
            if not db.execute(
                """UPDATE book_libraries
                SET name=?,
                    default_access=COALESCE(?, default_access),
                    auto_pair=COALESCE(?, auto_pair),
                    version=version+1,
                    updated_at=?
                WHERE id=? AND version=?""",
                (
                    body.name,
                    body.default_access,
                    body.auto_pair,
                    stamp,
                    library_id,
                    body.version,
                ),
            ).rowcount:
                raise HTTPException(409, "library_version_conflict")
            previous = {
                r["root"]: dict(r)
                for r in db.execute(
                    "SELECT id, root, watch_enabled FROM book_library_sources WHERE library_id=?",
                    (library_id,),
                )
            }
            db.execute("DELETE FROM book_library_sources WHERE library_id=?", (library_id,))
            db.executemany(
                "INSERT INTO book_library_sources(library_id,id,root,watch_enabled) VALUES (?,?,?,?)",
                [
                    (
                        library_id,
                        previous.get(str(source), {}).get("id", uuid4().hex),
                        str(source),
                        int(str(source) not in paused)
                        if body.paused_source_roots is not None
                        else previous.get(str(source), {}).get("watch_enabled", 1),
                    )
                    for source in sources
                ],
            )
            row = db.execute(
                f"SELECT {LIBRARY_FIELDS}, l.managed_root FROM book_libraries l WHERE l.id=?",  # nosec B608
                (library_id,),
            ).fetchone()
            return _serialize_library(db, row, owner=True)

    @router.get(
        "/book-libraries/{library_id}/access",
        dependencies=[Depends(auth.require_owner)],
    )
    def list_grants(library_id: str):
        with database.connect(scoped=False) as db:
            row = db.execute(
                "SELECT default_access FROM book_libraries WHERE id=?", (library_id,)
            ).fetchone()
            if row is None:
                raise HTTPException(404, "book_library_not_found")
            users = db.execute(
                "SELECT user_id FROM book_library_access WHERE library_id=? ORDER BY user_id",
                (library_id,),
            ).fetchall()
        return {
            "library_id": library_id,
            "default_access": row["default_access"],
            "user_ids": [item[0] for item in users],
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
        q: Annotated[str | None, Query(max_length=200)] = None,
        format: Literal["ebook", "audiobook", "audio"] | None = None,
        progress_status: Literal["unread", "in_progress", "finished"] | None = None,
        limit: Annotated[int, Query(ge=1, le=100)] = 50,
        offset: Annotated[int, Query(ge=0)] = 0,
    ):
        query_text = (q or "").strip()
        like_pattern: str | None = None
        if query_text:
            escaped = (
                query_text.lower().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            )
            like_pattern = f"%{escaped}%"
        normalized_format = "audiobook" if format == "audio" else format
        where_clauses = [VISIBLE, "(? IS NULL OR l.id=?)"]
        params: list[object] = [
            user["id"],
            user["id"],
            user["profile"],
            user["id"],
            library_id,
            library_id,
        ]
        if normalized_format == "ebook":
            where_clauses.append("b.has_ebook=1")
        elif normalized_format == "audiobook":
            where_clauses.append("b.has_audiobook=1")
        if like_pattern is not None:
            where_clauses.append(
                r"""(
                    LOWER(b.title) LIKE ? ESCAPE '\'
                    OR LOWER(COALESCE(b.subtitle, '')) LIKE ? ESCAPE '\'
                    OR EXISTS (
                        SELECT 1
                        FROM json_each(CASE WHEN json_valid(b.authors_json) THEN b.authors_json ELSE '[]' END) je
                        WHERE LOWER(CAST(je.value AS TEXT)) LIKE ? ESCAPE '\'
                    )
                )"""
            )
            params.extend((like_pattern, like_pattern, like_pattern))
        cte = f"""WITH catalog AS (
            SELECT {BOOK_FIELDS}, b.sort_title, {BOOK_PROGRESS_FIELDS}
            FROM books b JOIN book_libraries l ON l.id=b.library_id
            {BOOK_PROGRESS_JOINS}
            WHERE {" AND ".join(where_clauses)}
        )"""  # nosec B608
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
            total = db.execute(
                f"{cte} SELECT COUNT(*) FROM catalog WHERE (? IS NULL OR progress_status=?)",  # nosec B608
                (*params, progress_status, progress_status),
            ).fetchone()[0]
            rows = db.execute(
                f"""{cte}
                SELECT id, library_id, title, subtitle, authors_json, cover_path,
                       has_ebook, has_audiobook, resume_kind, progress_status,
                       reading_progress, listening_progress
                FROM catalog
                WHERE (? IS NULL OR progress_status=?)
                ORDER BY progress_at DESC, sort_title, id
                LIMIT ? OFFSET ?""",  # nosec B608
                (*params, progress_status, progress_status, limit, offset),
            )
            items = [public_book(row) for row in rows]
            return {"items": items, "total": total, "has_more": offset + len(items) < total}

    @router.get("/books/{book_id}")
    def get_book(book_id: str, user: book_reader):
        with database.connect(scoped=False) as db:
            row = db.execute(
                f"""SELECT {BOOK_FIELDS}, {BOOK_PROGRESS_FIELDS}
                FROM books b JOIN book_libraries l ON l.id=b.library_id
                {BOOK_PROGRESS_JOINS}
                WHERE b.id=? AND {VISIBLE}""",  # nosec B608
                (user["id"], user["id"], book_id, user["profile"], user["id"]),
            ).fetchone()
        if row is None:
            raise HTTPException(404, "book_not_found")
        return public_book(row)

    router.include_router(content_router(database, catalog.settings, auth, transcoding))
    router.include_router(progress_router(database, auth, catalog.settings))
    router.include_router(
        metadata_router(
            database,
            catalog.settings,
            auth,
            podcasts=podcasts,
            search_gate=search_gate,
            allow_fake_ip=allow_fake_ip,
        )
    )
    router.include_router(pairing_router(database, catalog.settings, auth))
    return router
