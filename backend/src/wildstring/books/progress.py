"""Versioned reading and audiobook checkpoints, scoped to the authenticated user."""

import json
import time
from pathlib import Path
from typing import Annotated, Literal
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from wildstring.books.content import book_record
from wildstring.library.fs import open_source
from wildstring.permissions import dependency

Index = Annotated[int, Field(strict=True, ge=0)]
Color = Literal["amber", "terracotta", "sage", "stone"]


class Checkpoint(BaseModel):
    model_config = ConfigDict(extra="forbid")
    session_id: str = Field(min_length=16, max_length=128)
    device_id: str = Field(min_length=1, max_length=128)
    base_version: Index
    sequence: int = Field(strict=True, ge=1)
    intent: Literal["resume", "restart"] = "resume"
    completed: bool = Field(default=False, strict=True)


class Reading(Checkpoint):
    spine_index: Index
    block_index: Index
    char_offset: Index
    reading_mode: Literal["scroll", "paginated"] = "scroll"


class Listening(Checkpoint):
    chapter_index: Index
    chapter_position_ms: Index
    playback_rate: float = Field(default=1, ge=0.75, le=2.5, strict=True)


class Bookmark(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["ebook", "audio"]
    spine_index: Index | None = None
    block_index: Index | None = None
    char_offset: Index | None = None
    chapter_index: Index | None = None
    position_ms: Index | None = None
    excerpt: str | None = Field(default=None, max_length=2048)
    note: str | None = Field(default=None, max_length=4096)


class Annotation(BaseModel):
    model_config = ConfigDict(extra="forbid")
    spine_index: Index
    start_block_index: Index
    start_char_offset: Index
    end_block_index: Index
    end_char_offset: Index
    selected_text: str = Field(min_length=1, max_length=8192)
    note: str | None = Field(default=None, max_length=4096)
    color: Color


def router(database, auth, settings=None):
    router = APIRouter()
    read = Annotated[dict, Depends(dependency(auth, "personal:read"))]
    write = Annotated[dict, Depends(dependency(auth, "personal:write"))]
    client = [Depends(auth.require_client)]
    cache_root = settings.data_dir / "book_cache" if settings is not None else None

    def current(db, table, book_id, user_id, kind):
        row = db.execute(
            f"""SELECT * FROM {table} WHERE book_id=? AND user_id=?""",  # nosec B608
            (book_id, user_id),
        ).fetchone()
        if row is None:
            defaults = (
                {
                    "spine_index": 0,
                    "block_index": 0,
                    "char_offset": 0,
                    "reading_mode": "scroll",
                }
                if kind == "reading"
                else {
                    "chapter_index": 0,
                    "chapter_position_ms": 0,
                    "book_position_ms": 0,
                    "playback_rate": 1.0,
                }
            )
            return {"book_id": book_id, "version": 0, "sequence": 0, "completed": False, **defaults}
        value = dict(row)
        value.pop("user_id")
        value["completed"] = bool(value["completed"])
        return value

    def require_carrier(book, kind):
        if kind == "reading" and not book["has_ebook"]:
            raise HTTPException(404, "ebook_not_found")
        if kind == "listening" and not book["has_audiobook"]:
            raise HTTPException(404, "audiobook_not_found")

    def get(book_id, user, kind):
        with database.connect(scoped=False) as db:
            book = book_record(db, book_id, user)
            require_carrier(book, kind)
            return current(db, f"book_{kind}_progress", book_id, user["id"], kind)

    def validate_anchor(db, book_id, spine, block):
        return db.execute(
            "SELECT * FROM book_ebook_chapters WHERE book_id=? AND spine_index=? "
            "AND (block_count>? OR (block_count=0 AND ?=0))",
            (book_id, spine, block, block),
        ).fetchone()

    def exact_chapter_chars(
        cache_key: str | None, spine_index: int, block_index: int, char_offset: int
    ) -> int | None:
        if cache_root is None or not cache_key:
            return None
        try:
            with open_source(cache_root, Path(cache_key) / f"{spine_index}.json") as stream:
                data = json.load(stream)
            blocks = data.get("blocks", [])
            prefix = sum(int(block.get("char_len", 0)) for block in blocks[:block_index])
            return prefix + char_offset
        except (OSError, ValueError, KeyError, TypeError):
            return None

    def update(book_id, user, body, kind):
        table = f"book_{kind}_progress"
        with database.connect(write=True) as db:
            db.execute("BEGIN IMMEDIATE")
            book = book_record(db, book_id, user)
            require_carrier(book, kind)
            saved = current(db, table, book_id, user["id"], kind)
            same = (
                saved.get("session_id") == body.session_id
                and saved.get("device_id") == body.device_id
            )
            if same and body.sequence <= saved["sequence"]:
                return saved
            if not same and body.base_version != saved["version"]:
                raise HTTPException(409, {"code": "book_progress_conflict", "current": saved})
            if isinstance(body, Reading):
                chapter = validate_anchor(db, book_id, body.spine_index, body.block_index)
                if chapter is None or body.char_offset > chapter["char_count"]:
                    raise HTTPException(422, "book_anchor_invalid")
                info = db.execute(
                    "SELECT total_chars,spine_count,cache_key FROM book_ebooks WHERE book_id=?",
                    (book_id,),
                ).fetchone()
                exact = exact_chapter_chars(
                    info["cache_key"], chapter["spine_index"], body.block_index, body.char_offset
                )
                if exact is not None:
                    in_chapter = min(chapter["char_count"], exact)
                elif chapter["block_count"] > 0:
                    in_chapter = min(
                        chapter["char_count"],
                        chapter["char_count"] * body.block_index / chapter["block_count"]
                        + body.char_offset,
                    )
                else:
                    in_chapter = 0
                chars_before = chapter["start_global_char"] + in_chapter
                fields = {
                    "spine_index": body.spine_index,
                    "block_index": body.block_index,
                    "char_offset": body.char_offset,
                    "chapter_title": chapter["title"],
                    "overall_ratio": min(1.0, chars_before / max(1, info["total_chars"])),
                    "reading_mode": body.reading_mode,
                }
                last_non_empty = db.execute(
                    "SELECT spine_index, block_count FROM book_ebook_chapters "
                    "WHERE book_id=? AND block_count>0 ORDER BY spine_index DESC LIMIT 1",
                    (book_id,),
                ).fetchone()
                if last_non_empty is not None:
                    at_end = body.spine_index > last_non_empty["spine_index"] or (
                        body.spine_index == last_non_empty["spine_index"]
                        and body.block_index + 1 >= last_non_empty["block_count"]
                    )
                else:
                    at_end = body.spine_index + 1 >= info["spine_count"]
            else:
                chapter = db.execute(
                    "SELECT * FROM book_audiobook_chapters WHERE book_id=? AND chapter_index=?",
                    (book_id, body.chapter_index),
                ).fetchone()
                if chapter is None:
                    raise HTTPException(422, "book_chapter_invalid")
                duration = db.execute(
                    "SELECT total_duration_ms FROM book_audiobooks WHERE book_id=?", (book_id,)
                ).fetchone()[0]
                offset = min(body.chapter_position_ms, chapter["duration_ms"])
                position = chapter["start_book_ms"] + offset
                fields = {
                    "chapter_index": body.chapter_index,
                    "chapter_position_ms": offset,
                    "book_position_ms": position,
                    "playback_rate": body.playback_rate,
                }
                tail_ms = min(120_000, max(2_000, round(duration * 0.05))) if duration > 0 else 0
                at_end = duration - position <= tail_ms
            if same:
                completed = bool(saved["completed"] or (body.completed and at_end))
            else:
                completed = bool(
                    (body.intent == "resume" and saved["completed"]) or (body.completed and at_end)
                )
            fields.update(
                completed=completed,
                version=saved["version"] + 1,
                session_id=body.session_id,
                device_id=body.device_id,
                sequence=body.sequence,
                updated_at=time.time(),
            )
            columns = ",".join(fields)
            markers = ",".join("?" for _ in fields)
            assignments = ",".join(f"{field}=excluded.{field}" for field in fields)
            db.execute(
                f"""INSERT INTO {table}(user_id,book_id,{columns}) VALUES (?,?,{markers})
                    ON CONFLICT(user_id,book_id) DO UPDATE SET {assignments}""",  # nosec B608
                (user["id"], book_id, *fields.values()),
            )
            return {"book_id": book_id, **fields}

    @router.get("/books/{book_id}/reading-progress")
    def reading_progress(book_id: str, user: read):
        return get(book_id, user, "reading")

    @router.put("/books/{book_id}/reading-progress", dependencies=client)
    def save_reading(book_id: str, body: Reading, user: write):
        return update(book_id, user, body, "reading")

    @router.get("/books/{book_id}/listening-progress")
    def listening_progress(book_id: str, user: read):
        return get(book_id, user, "listening")

    @router.put("/books/{book_id}/listening-progress", dependencies=client)
    def save_listening(book_id: str, body: Listening, user: write):
        return update(book_id, user, body, "listening")

    def items(table, book_id, user):
        with database.connect(scoped=False) as db:
            book_record(db, book_id, user)
            rows = db.execute(
                f"SELECT * FROM {table} WHERE book_id=? AND user_id=? ORDER BY created_at,id",  # nosec B608
                (book_id, user["id"]),
            )
            return {
                "items": [{key: row[key] for key in row.keys() if key != "user_id"} for row in rows]
            }

    def save_item(table, book_id, user, body, identity=None):
        values = body.model_dump()
        with database.connect(write=True) as db:
            db.execute("BEGIN IMMEDIATE")
            book_record(db, book_id, user)
            if isinstance(body, Bookmark) and body.kind == "audio":
                chapter = db.execute(
                    """SELECT duration_ms FROM book_audiobook_chapters
                        WHERE book_id=? AND chapter_index=?""",
                    (book_id, body.chapter_index),
                ).fetchone()
                invalid = (
                    chapter is None
                    or body.position_ms is None
                    or body.position_ms > chapter[0]
                    or body.spine_index is not None
                    or body.block_index is not None
                    or body.char_offset is not None
                )
            elif isinstance(body, Bookmark):
                chapter = (
                    validate_anchor(db, book_id, body.spine_index, body.block_index)
                    if body.spine_index is not None and body.block_index is not None
                    else None
                )
                invalid = (
                    chapter is None
                    or body.char_offset is None
                    or body.char_offset > chapter["char_count"]
                    or body.chapter_index is not None
                    or body.position_ms is not None
                )
            else:
                end_chapter = validate_anchor(db, book_id, body.spine_index, body.end_block_index)
                invalid = (
                    (body.start_block_index, body.start_char_offset)
                    >= (body.end_block_index, body.end_char_offset)
                    or end_chapter is None
                    or body.end_char_offset > end_chapter["char_count"]
                )
            if invalid:
                raise HTTPException(422, "book_anchor_invalid")
            if identity is None:
                identity = uuid4().hex
                stamp = time.time()
                fields = ",".join(values)
                params = ",".join("?" for _ in values)
                db.execute(
                    f"""INSERT INTO {table}(id,user_id,book_id,created_at,updated_at,{fields})
                    VALUES (?,?,?,?,?,{params})""",  # nosec B608
                    (identity, user["id"], book_id, stamp, stamp, *values.values()),
                )
            else:
                values["updated_at"] = time.time()
                assignments = ",".join(f"{key}=?" for key in values)
                if not db.execute(
                    f"UPDATE {table} SET {assignments} WHERE id=? AND book_id=? AND user_id=?",  # nosec B608
                    (*values.values(), identity, book_id, user["id"]),
                ).rowcount:
                    raise HTTPException(404, "book_item_not_found")
        return {"id": identity, **values}

    def delete_item(table, book_id, identity, user):
        with database.connect(write=True) as db:
            db.execute("BEGIN IMMEDIATE")
            book_record(db, book_id, user)
            if not db.execute(
                f"DELETE FROM {table} WHERE id=? AND book_id=? AND user_id=?",  # nosec B608
                (identity, book_id, user["id"]),
            ).rowcount:
                raise HTTPException(404, "book_item_not_found")
        return {"id": identity}

    @router.get("/books/{book_id}/bookmarks")
    def bookmarks(book_id: str, user: read):
        return items("book_bookmarks", book_id, user)

    @router.post("/books/{book_id}/bookmarks", dependencies=client, status_code=201)
    def add_bookmark(book_id: str, user: write, body: Bookmark):
        return save_item("book_bookmarks", book_id, user, body)

    @router.put("/books/{book_id}/bookmarks/{identity}", dependencies=client)
    def edit_bookmark(book_id: str, identity: str, user: write, body: Bookmark):
        return save_item("book_bookmarks", book_id, user, body, identity)

    @router.delete("/books/{book_id}/bookmarks/{identity}", dependencies=client)
    def delete_bookmark(book_id: str, identity: str, user: write):
        return delete_item("book_bookmarks", book_id, identity, user)

    @router.get("/books/{book_id}/annotations")
    def annotations(book_id: str, user: read):
        return items("book_annotations", book_id, user)

    @router.post("/books/{book_id}/annotations", dependencies=client, status_code=201)
    def add_annotation(book_id: str, user: write, body: Annotation):
        return save_item("book_annotations", book_id, user, body)

    @router.put("/books/{book_id}/annotations/{identity}", dependencies=client)
    def edit_annotation(book_id: str, identity: str, user: write, body: Annotation):
        return save_item("book_annotations", book_id, user, body, identity)

    @router.delete("/books/{book_id}/annotations/{identity}", dependencies=client)
    def delete_annotation(book_id: str, identity: str, user: write):
        return delete_item("book_annotations", book_id, identity, user)

    return router
