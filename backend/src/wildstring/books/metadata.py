"""Explicit public book metadata overrides."""

import json
import time
from pathlib import Path
from typing import Annotated, Literal, get_args

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field

from wildstring.books.content import book_record
from wildstring.books.providers import BookProviders, Provider
from wildstring.books.service import Books
from wildstring.diagnostics import record_event
from wildstring.library.metadata import normalize
from wildstring.library.sidecar import BOOK_ARRAY, BOOK_TEXT, export_books
from wildstring.permissions import dependency

Text = Annotated[str, Field(max_length=4096)]
BookField = Literal[
    "title",
    "subtitle",
    "authors",
    "narrators",
    "series_name",
    "series_index",
    "publisher",
    "published_year",
    "language",
    "isbn10",
    "isbn13",
    "description",
    "tags",
]
BOOK_FIELD_NAMES = frozenset(get_args(BookField))


class MetadataUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    title: str | None = Field(default=None, min_length=1, max_length=4096)
    subtitle: Text | None = None
    authors: list[Text] | None = Field(default=None, max_length=64)
    narrators: list[Text] | None = Field(default=None, max_length=64)
    series_name: Text | None = None
    series_index: float | None = Field(default=None, ge=0, le=9999)
    publisher: Text | None = None
    published_year: int | None = Field(default=None, ge=0, le=9999)
    language: Text | None = None
    isbn10: Text | None = None
    isbn13: Text | None = None
    description: Text | None = None
    tags: list[Text] | None = Field(default=None, max_length=64)
    locked_fields: list[BookField] | None = Field(default=None, max_length=32)


class ChapterTitleUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    title: str = Field(min_length=1, max_length=4096)


class BookMetadataSourcesUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    itunes: bool | None = None
    openlibrary: bool | None = None
    google_books: bool | None = None


def public_metadata(row):
    values = {key: row[key] for key in BOOK_TEXT if key != "sort_title"}
    values.update({key: json.loads(row[column]) for key, column in BOOK_ARRAY.items()})
    return values | {
        "series_index": row["series_index"],
        "published_year": row["published_year"],
        "locked_fields": json.loads(row["locked_fields_json"]),
    }


def router(
    database,
    settings,
    auth,
    *,
    podcasts=None,
    search_gate=None,
    allow_fake_ip: bool = False,
):
    router = APIRouter()
    read = Annotated[dict, Depends(dependency(auth, "books:read"))]
    edit = Annotated[dict, Depends(dependency(auth, "books:write"))]
    manage = Annotated[dict, Depends(dependency(auth, "books:manage_libraries"))]
    service = Books(database, settings)
    providers = BookProviders(
        database=database,
        network_policy=podcasts.get_network_policy if podcasts is not None else None,
        itunes_gate=search_gate,
        allow_fake_ip=allow_fake_ip,
    )
    scrape = Annotated[dict, Depends(dependency(auth, "books:scrape_metadata"))]

    @router.get("/books/metadata/sources")
    def metadata_sources(user: scrape):
        return providers.sources_state()

    @router.put("/books/metadata/sources", dependencies=[Depends(auth.require_client)])
    def update_metadata_sources(user: manage, body: BookMetadataSourcesUpdate):
        return providers.update_sources(body.model_dump(exclude_unset=True))

    @router.get("/books/{book_id}/metadata")
    def get_metadata(book_id: str, user: read):
        with database.connect(scoped=False) as db:
            return public_metadata(book_record(db, book_id, user))

    @router.get("/books/{book_id}/metadata/search")
    def search(
        book_id: str,
        user: scrape,
        provider: Provider | None = None,
        sources: Annotated[str | None, Query(max_length=256)] = None,
        q: Annotated[str | None, Query(max_length=256)] = None,
    ):
        with database.connect(scoped=False) as db:
            book = book_record(db, book_id, user)
        term = (q or "").strip() or book["title"]
        if provider is not None:
            chosen: list[Provider] = [provider]
        else:
            enabled = providers.sources_state()["items"]
            enabled_ids = [item["id"] for item in enabled]
            if sources is not None:
                requested = list(
                    dict.fromkeys(part.strip() for part in sources.split(",") if part.strip())
                )
                if not requested or any(item not in enabled_ids for item in requested):
                    raise HTTPException(422, "invalid_provider_sources")
                chosen = requested
            else:
                chosen = enabled_ids
                if not chosen:
                    return {"items": []}
        return {"items": providers.search_many(chosen, term, user["id"])}

    @router.patch("/books/{book_id}/metadata", dependencies=[Depends(auth.require_client)])
    def update(book_id: str, user: edit, body: MetadataUpdate):
        with database.connect(scoped=False) as db:
            book = book_record(db, book_id, user)
        values = body.model_dump(exclude_unset=True)
        locks = values.pop("locked_fields", None)
        if values.get("title") is None:
            values.pop("title", None)
        with service.write(book["library_id"], operation="metadata_update", book_id=book_id):
            with database.connect(write=True) as db:
                db.execute("BEGIN IMMEDIATE")
                book = book_record(db, book_id, user)
                overrides = json.loads(book["overrides_json"]) | values
                fields = dict(values)
                for key, column in BOOK_ARRAY.items():
                    if key in fields:
                        fields[column] = json.dumps(fields.pop(key) or [], ensure_ascii=False)
                if "title" in fields:
                    fields["sort_title"] = normalize(fields["title"])
                if locks is not None:
                    fields["locked_fields_json"] = json.dumps(sorted(set(locks)))
                elif values:
                    merged_locks = set(json.loads(book["locked_fields_json"])) | (
                        set(values) & BOOK_FIELD_NAMES
                    )
                    fields["locked_fields_json"] = json.dumps(sorted(merged_locks))
                fields["overrides_json"] = json.dumps(overrides, ensure_ascii=False)
                fields["updated_at"] = time.time()
                assignments = ",".join(f"{key}=?" for key in fields)
                db.execute(
                    f"UPDATE books SET {assignments} WHERE id=?",  # nosec B608
                    (*fields.values(), book_id),
                )
            export_books(database, Path(book["managed_root"]), book["library_id"], book_id)
        record_event(
            "books.metadata_update",
            task_id=book["library_id"],
            batch_id=book_id,
            user_id=user["id"],
            operation="metadata_update",
            stage="completed",
        )
        return get_metadata(book_id, user)

    @router.patch(
        "/books/{book_id}/audiobook/chapters/{chapter_index}",
        dependencies=[Depends(auth.require_client)],
    )
    def update_chapter(book_id: str, chapter_index: int, body: ChapterTitleUpdate, user: edit):
        if chapter_index < 0:
            raise HTTPException(404, "book_chapter_not_found")
        with database.connect(scoped=False) as db:
            book = book_record(db, book_id, user)
        with service.write(book["library_id"], operation="chapter_title_update", book_id=book_id):
            with database.connect(write=True) as db:
                db.execute("BEGIN IMMEDIATE")
                book = book_record(db, book_id, user)
                row = db.execute(
                    """UPDATE book_audiobook_chapters SET title=? WHERE book_id=? AND chapter_index=?
                       RETURNING chapter_index,title""",
                    (body.title, book_id, chapter_index),
                ).fetchone()
                if row is None:
                    raise HTTPException(404, "book_chapter_not_found")
            export_books(database, Path(book["managed_root"]), book["library_id"], book_id)
        return dict(row)

    return router
