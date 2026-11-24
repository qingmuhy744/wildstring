"""Move one carrier and its personal references between books in the same library."""

import time
from contextlib import suppress
from pathlib import Path
from typing import Annotated, Literal
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from wildstring.books.content import book_record
from wildstring.books.service import Books
from wildstring.library.import_files import copy_exclusive, link_exclusive
from wildstring.library.scanner import open_source
from wildstring.library.sidecar import export_books, read_asset, write_asset
from wildstring.permissions import dependency


class PairInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    other_book_id: str = Field(min_length=1, max_length=128)


class SplitInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    carrier: Literal["ebook", "audiobook"] = "audiobook"


def move_carrier(db, root, source, target, carrier, published, retired):
    table = "book_ebooks" if carrier == "ebook" else "book_audiobook_files"
    rows = db.execute(
        f"SELECT managed_path,link_mode,sha256 FROM {table} WHERE book_id=?",  # nosec B608
        (source,),
    ).fetchall()
    for row in rows:
        old = Path(row["managed_path"])
        destination = Path(target) / old.name
        publish = link_exclusive if row["link_mode"] == "hardlink" else copy_exclusive
        with open_source(root, old) as stream:
            publish(stream, root, destination, row["sha256"])
        published.append(root / destination)
        retired.append(root / old)
        db.execute(
            f"UPDATE {table} SET managed_path=? WHERE book_id=? AND managed_path=?",  # nosec B608
            (destination.as_posix(), source, old.as_posix()),
        )
    if carrier == "ebook":
        tables = ("book_ebooks", "book_ebook_chapters", "book_reading_progress", "book_annotations")
    else:
        tables = (
            "book_audiobooks",
            "book_audiobook_files",
            "book_audiobook_chapters",
            "book_listening_progress",
        )
    for table in tables:
        db.execute(f"UPDATE {table} SET book_id=? WHERE book_id=?", (target, source))  # nosec B608
    db.execute(
        "UPDATE book_bookmarks SET book_id=? WHERE book_id=? AND kind=?",
        (target, source, "ebook" if carrier == "ebook" else "audio"),
    )


def router(database, settings, auth):
    router = APIRouter()
    service = Books(database, settings)
    manage = Annotated[dict, Depends(dependency(auth, "books:manage_libraries"))]
    client = [Depends(auth.require_client)]

    @router.post("/books/{book_id}/pair", dependencies=client)
    def pair(book_id: str, body: PairInput, user: manage):
        with database.connect(scoped=False) as db:
            first = book_record(db, book_id, user)
        root = Path(first["managed_root"])
        published, retired = [], []
        with service.write(first["library_id"]):
            try:
                with database.connect(write=True) as db:
                    db.execute("BEGIN IMMEDIATE")
                    db.execute("PRAGMA defer_foreign_keys=ON")
                    first = book_record(db, book_id, user)
                    other = book_record(db, body.other_book_id, user)
                    carriers = (first["has_ebook"], first["has_audiobook"])
                    counterpart = (other["has_ebook"], other["has_audiobook"])
                    if (
                        first["library_id"] != other["library_id"]
                        or carriers not in {(1, 0), (0, 1)}
                        or counterpart != carriers[::-1]
                    ):
                        raise HTTPException(409, "book_pair_invalid")
                    carrier = "ebook" if other["has_ebook"] else "audiobook"
                    move_carrier(db, root, other["id"], book_id, carrier, published, retired)
                    db.execute(
                        "UPDATE books SET has_ebook=1,has_audiobook=1,updated_at=? WHERE id=?",
                        (time.time(), book_id),
                    )
                    db.execute("DELETE FROM books WHERE id=?", (other["id"],))
            except FileExistsError as error:
                for path in published:
                    path.unlink(missing_ok=True)
                raise HTTPException(409, "book_file_conflict") from error
            except Exception:
                for path in published:
                    path.unlink(missing_ok=True)
                raise
            for path in retired:
                with suppress(OSError):
                    path.unlink()
            export_books(database, root, first["library_id"], book_id)
        return {"id": book_id}

    @router.post("/books/{book_id}/split", dependencies=client, status_code=201)
    def split(book_id: str, body: SplitInput, user: manage):
        with database.connect(scoped=False) as db:
            first = book_record(db, book_id, user)
        root = Path(first["managed_root"])
        published, retired = [], []
        new_id = uuid4().hex
        with service.write(first["library_id"]):
            try:
                with database.connect(write=True) as db:
                    db.execute("BEGIN IMMEDIATE")
                    db.execute("PRAGMA defer_foreign_keys=ON")
                    first = book_record(db, book_id, user)
                    if not (first["has_ebook"] and first["has_audiobook"]):
                        raise HTTPException(409, "book_split_invalid")
                    new_ebook = body.carrier == "ebook"
                    stamp = time.time()
                    db.execute(
                        """INSERT INTO books(id,library_id,managed_dir,title,sort_title,subtitle,authors_json,
                            narrators_json,series_name,series_index,publisher,published_year,language,isbn10,isbn13,
                            description,tags_json,has_ebook,has_audiobook,pair_key,overrides_json,locked_fields_json,
                            created_at,updated_at)
                           SELECT ?,library_id,?,title,sort_title,subtitle,authors_json,narrators_json,
                            series_name,series_index,publisher,published_year,language,isbn10,isbn13,description,
                            tags_json,?,?,NULL,overrides_json,locked_fields_json,?,? FROM books WHERE id=?""",
                        (new_id, new_id, new_ebook, not new_ebook, stamp, stamp, book_id),
                    )
                    move_carrier(db, root, book_id, new_id, body.carrier, published, retired)
                    if first["cover_path"] and (
                        cover := read_asset(root, Path(first["cover_path"]), 8 * 1024 * 1024)
                    ):
                        relative = Path(new_id) / "cover.jpg"
                        write_asset(root, relative, cover)
                        published.append(root / relative)
                        db.execute(
                            "UPDATE books SET cover_path=?,cover_hash=? WHERE id=?",
                            (relative.as_posix(), first["cover_hash"], new_id),
                        )
                    db.execute(
                        "UPDATE books SET has_ebook=?,has_audiobook=?,pair_key=NULL,updated_at=? WHERE id=?",
                        (not new_ebook, new_ebook, stamp, book_id),
                    )
            except Exception:
                for path in published:
                    path.unlink(missing_ok=True)
                raise
            for path in retired:
                with suppress(OSError):
                    path.unlink()
            export_books(database, root, first["library_id"], book_id)
            export_books(database, root, first["library_id"], new_id)
        return {"id": new_id, "original_id": book_id}

    return router
