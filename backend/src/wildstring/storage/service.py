"""Shared cloud-library bindings and their owner-only management API."""

import sqlite3
import time
from contextlib import suppress
from pathlib import Path
from typing import Annotated, Literal
from uuid import uuid4

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, ConfigDict, Field, SecretStr, ValidationError
from starlette.responses import Response

from wildstring.books.ebooks import MAX_EBOOK_BYTES
from wildstring.mcp_oauth import server_origin
from wildstring.storage.accounts import CALLBACK, Accounts, drive_http_error
from wildstring.storage.cache import RemoteCache, RemoteResponse
from wildstring.storage.gdrive import DriveError
from wildstring.storage.sync import RemoteEbook, Sync

Collection = Literal["music", "books"]
CACHE_MAX_MB = 2048


class AccountInput(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    name: str = Field(min_length=1, max_length=100)
    client_id: str = Field(min_length=1, max_length=512)
    client_secret: SecretStr = Field(min_length=1, max_length=512)
    scope_mode: Literal["drive_file", "drive_readonly"]


class AccountAction(BaseModel):
    account_id: str = Field(pattern=r"^[a-f0-9]{32}$")


class Finish(BaseModel):
    state: str = Field(min_length=1, max_length=100)
    code: str | None = Field(default=None, min_length=1, max_length=2048)


class BindingInput(AccountAction):
    name: str = Field(min_length=1, max_length=100)
    collection: Collection
    folder_id: str | None = Field(default=None, pattern=r"^[A-Za-z0-9_-]{1,256}$")
    cache_max_mb: int = Field(default=CACHE_MAX_MB, ge=0, le=1_048_576, strict=True)
    default_access: bool = False
    auto_pair: bool = True


class LibraryAction(BaseModel):
    collection: Collection
    library_id: str = Field(pattern=r"^[a-f0-9]{32}$")


class CacheInput(LibraryAction):
    cache_max_mb: int = Field(ge=0, le=1_048_576, strict=True)


# Google opens this document cross-site. The same-origin POST made from the
# resulting document has the original SameSite=Strict cookie.
CALLBACK_HTML = """<!doctype html>
<html lang="en"><meta charset="utf-8"><title>WildString · Google Drive</title>
<p role="status">Google Drive</p>
<noscript>Enable JavaScript, then reconnect from WildString.</noscript>
<script src="./callback.js" defer></script></html>
"""
CALLBACK_JS = """const query = new URLSearchParams(location.search);
history.replaceState(null, '', './callback');
async function finish() {
    let result = 'failed';
    try {
        const response = await fetch('./finish', {
            method: 'POST',
            headers: {'Content-Type': 'application/json', 'X-Wildstring-Client': 'web'},
            body: JSON.stringify({state: query.get('state'), code: query.get('code')}),
        });
        if (response.ok) {
            result = 'connected';
        } else {
            const payload = await response.json().catch(() => null);
            if (
                payload &&
                typeof payload.detail === 'string' &&
                /^remote_storage_[a-z0-9_]{1,64}$/.test(payload.detail)
            ) {
                result = payload.detail;
            }
        }
    } finally {
        sessionStorage.setItem('wildstring-drive-callback', result);
        location.replace('../../../');
    }
}
void finish();
"""


class RemoteStorage:
    def __init__(self, database, settings, providers, **endpoint_overrides):
        self.db, self.settings = database, settings
        self.accounts = Accounts(database, providers, **endpoint_overrides)
        self.cache = RemoteCache(database)
        self.sync = Sync(database, settings)

    @staticmethod
    def lookup(db, collection, identity):
        return db.execute(
            """SELECT l.*, a.scope_mode, a.status AS account_status, a.last_error,
                 (SELECT COALESCE(SUM(c.size_bytes),0) FROM remote_media_cache c
                  WHERE c.collection=l.collection AND c.library_id=l.library_id) AS cache_used_bytes
               FROM library_remote_storage l JOIN remote_storage_accounts a ON a.id=l.account_id
               WHERE l.collection=? AND l.library_id=?""",
            (collection, identity),
        ).fetchone()

    @staticmethod
    def binding_public(row):
        return {
            key: row[key]
            for key in (
                "collection",
                "library_id",
                "account_id",
                "root_folder_id",
                "root_folder_name",
                "last_synced_at",
                "cache_max_mb",
                "cache_used_bytes",
                "scope_mode",
                "account_status",
                "last_error",
                "version",
            )
        }

    def binding(self, collection, identity):
        with self.db.connect(scoped=False) as db:
            row = self.lookup(db, collection, identity)
        return dict(row) if row else None

    def create_library(self, body):
        name = body.name.strip()
        if not name:
            raise HTTPException(422, "remote_storage_library_name_required")
        drive = self.accounts.drive(body.account_id)
        if body.folder_id:
            folder = drive.folder(body.folder_id)
        elif drive.account["scope_mode"] == "drive_file":
            folder = drive.create_folder(name)
        else:
            raise HTTPException(422, "remote_storage_folder_required")
        identity = uuid4().hex
        collection = body.collection
        root = (
            self.settings.data_dir / ("libraries" if collection == "music" else "books") / identity
        ).resolve()
        with self.db.connect(scoped=False) as db:
            bound = {
                row[0]
                for row in db.execute(
                    "SELECT root_folder_id FROM library_remote_storage WHERE account_id=? AND collection=?",
                    (body.account_id, collection),
                )
            }
        # A file can only belong to one library of each collection for this account.
        if bound:
            if folder["id"] in bound:
                raise HTTPException(409, "remote_storage_folder_already_bound")
            visited = {folder["id"]}
            parents = [p for p in folder.get("parents", []) if p and p != "root"]
            while parents:
                if bound.intersection(parents):
                    raise HTTPException(409, "remote_storage_folder_already_bound")
                next_parents = []
                for parent in parents:
                    if parent in visited:
                        continue
                    visited.add(parent)
                    try:
                        ancestor_folder = drive.folder(parent)
                    except DriveError as error:
                        # Under drive.file (or shared subtrees), My Drive root or external
                        # parent folders are intentionally unreadable; stop climbing there.
                        if error.code in {
                            "remote_storage_file_not_found",
                            "remote_storage_forbidden",
                            "remote_storage_folder_invalid",
                        }:
                            continue
                        raise
                    for ancestor in ancestor_folder.get("parents", []):
                        if ancestor and ancestor != "root" and ancestor not in visited:
                            next_parents.append(ancestor)
                parents = next_parents
            if bound.intersection(drive.list_tree(folder["id"])):
                raise HTTPException(409, "remote_storage_folder_already_bound")
        root.mkdir(parents=True)
        try:
            with self.db.connect(write=True) as db:
                db.execute("BEGIN IMMEDIATE")
                if collection == "music":
                    db.execute(
                        """INSERT INTO libraries(id,root,name,default_access,storage_backend)
                           VALUES (?,?,?,?,'gdrive')""",
                        (identity, str(root), name, body.default_access),
                    )
                    db.execute(
                        "INSERT INTO library_preferences(library_id,name) VALUES (?,?)",
                        (identity, name),
                    )
                    db.execute("UPDATE library_access_versions SET version=version+1")
                else:
                    stamp = time.time()
                    db.execute(
                        """INSERT INTO book_libraries(id,name,managed_root,default_access,auto_pair,
                           created_at,updated_at,storage_backend) VALUES (?,?,?,?,?,?,?,'gdrive')""",
                        (
                            identity,
                            name,
                            str(root),
                            "all" if body.default_access else "restricted",
                            body.auto_pair,
                            stamp,
                            stamp,
                        ),
                    )
                db.execute(
                    """INSERT INTO library_remote_storage
                       (collection,library_id,account_id,root_folder_id,root_folder_name,cache_max_mb)
                       VALUES (?,?,?,?,?,?)""",
                    (
                        collection,
                        identity,
                        body.account_id,
                        folder["id"],
                        folder["name"],
                        body.cache_max_mb,
                    ),
                )
        except sqlite3.IntegrityError:
            with suppress(OSError):
                root.rmdir()
            raise HTTPException(409, "remote_storage_folder_already_bound") from None
        return {
            "id": identity,
            "storage_backend": "gdrive",
            "remote": self.binding_public(self.binding(collection, identity)),
        }

    def operate(self, account_id, operation):
        try:
            result = operation()
        except DriveError as error:
            self.accounts.record_failure(account_id, error)
            raise drive_http_error(error) from None
        self.accounts.change_status(self.accounts.account(account_id))
        return result

    def synchronize(self, collection, identity, *, full=False, on_start=None):
        binding = self.binding(collection, identity)
        if binding is None:
            raise HTTPException(404, "remote_storage_library_not_found")
        with self.db.connect(scoped=False) as db:
            library = db.execute(
                "SELECT * FROM libraries WHERE id=?"
                if collection == "music"
                else "SELECT * FROM book_libraries WHERE id=?",
                (identity,),
            ).fetchone()
        return self.operate(
            binding["account_id"],
            lambda: self.sync.run(
                self.accounts.drive(binding["account_id"]),
                binding,
                library,
                full=full,
                on_start=on_start,
            ),
        )

    def upload_book(self, binding, file, library, filename, book_id):
        account = binding["account_id"]

        def upload():
            drive = self.accounts.drive(account)
            drive.writable()
            source = file.file
            source.seek(0, 2)
            size = source.tell()
            source.seek(0)
            if size <= 0:
                raise HTTPException(422, "unsupported_ebook_format")
            if size > MAX_EBOOK_BYTES:
                raise HTTPException(413, "file_too_large")
            # The spool already contains the validated multipart payload. The parser
            # uses its descriptor, then the same stream feeds the resumable upload.
            return self.sync.books.ebook(
                library,
                source,
                filename,
                "managed_only",
                book_id=book_id,
                remote=RemoteEbook(drive, binding, Path(Path(filename).name), size=size),
            )

        return self.operate(account, upload)

    def response(self, kind, identity, format_name, request, *, library_id, headers=None):
        row = self.cache.ref(kind, identity, library_id=library_id)
        if row is None or not row["available"]:
            raise HTTPException(404, "remote_storage_file_not_found")
        return RemoteResponse(self.accounts, self.cache, row, format_name, request, headers)

    def router(self, auth):
        router = APIRouter(prefix="/api/v1/remote-storage", tags=["remote-storage"])
        owner = [Depends(auth.require_owner)]
        write = [*owner, Depends(auth.require_client)]

        @router.get("/accounts", dependencies=owner)
        def drive_accounts():
            return {"items": self.accounts.listing()}

        @router.post("/accounts", dependencies=write, status_code=201)
        def create_drive_account(body: Annotated[object, Body()]):
            try:
                account = AccountInput.model_validate(body)
            except ValidationError:
                raise HTTPException(422, "remote_storage_credentials_invalid") from None
            return self.accounts.create(account)

        @router.post("/authorize", dependencies=write)
        def authorize_drive(body: AccountAction, request: Request):
            return self.accounts.begin(
                body.account_id, auth.session_token(request), server_origin(request) + CALLBACK
            )

        @router.get("/callback", response_class=HTMLResponse)
        def google_drive_callback():
            return HTMLResponse(
                CALLBACK_HTML,
                headers={
                    "Content-Security-Policy": "default-src 'none'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
                },
            )

        @router.get("/callback.js", response_class=Response)
        def google_drive_callback_script():
            return Response(
                CALLBACK_JS,
                media_type="text/javascript",
                headers={"X-Content-Type-Options": "nosniff"},
            )

        @router.post("/finish", dependencies=write)
        def finish_drive_authorization(body: Annotated[object, Body()], request: Request):
            try:
                result = Finish.model_validate(body)
            except ValidationError:
                raise HTTPException(400, "remote_storage_oauth_state_invalid") from None
            try:
                return self.accounts.finish(
                    result, auth.session_token(request), server_origin(request) + CALLBACK
                )
            except DriveError as error:
                raise drive_http_error(error) from None

        @router.post("/test", dependencies=write)
        def test_drive_connection(body: AccountAction):
            self.operate(
                body.account_id,
                lambda: self.accounts.drive(body.account_id).json(
                    "/drive/v3/about",
                    {"fields": "user(permissionId)"},
                ),
            )
            return self.accounts.public(self.accounts.account(body.account_id))

        @router.post("/revoke", dependencies=write)
        def revoke_drive_connection(body: AccountAction):
            try:
                return self.accounts.revoke(body.account_id)
            except DriveError as error:
                raise drive_http_error(error) from None

        @router.post("/libraries", dependencies=write, status_code=201)
        def create_drive_library(body: BindingInput):
            return self.operate(body.account_id, lambda: self.create_library(body))

        @router.post("/sync", dependencies=write)
        def sync_drive_library(body: LibraryAction):
            return self.synchronize(body.collection, body.library_id)

        @router.post("/cache", dependencies=write)
        def update_drive_cache(body: CacheInput):
            if self.binding(body.collection, body.library_id) is None:
                raise HTTPException(404, "remote_storage_library_not_found")
            self.cache.configure((body.collection, body.library_id), limit=body.cache_max_mb)
            return self.binding_public(self.binding(body.collection, body.library_id))

        @router.post("/cache/clear", dependencies=write)
        def clear_drive_cache(body: LibraryAction):
            if self.binding(body.collection, body.library_id) is None:
                raise HTTPException(404, "remote_storage_library_not_found")
            self.cache.configure((body.collection, body.library_id), clear=True)
            return self.binding_public(self.binding(body.collection, body.library_id))

        return router
