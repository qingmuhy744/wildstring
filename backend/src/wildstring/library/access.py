"""Bind one authorized library context to the full ASGI request, including streams."""

import hashlib
import json
from urllib.parse import parse_qs

import anyio
from fastapi import HTTPException, Request
from starlette.responses import JSONResponse
from starlette.routing import Match

from wildstring.library.scope import (
    LibraryContext,
    allowed_ids,
    current_library,
    object_library,
    object_source,
    references,
)

MAX_JSON_BODY_BYTES = 2 * 1024 * 1024
EXEMPT_PREFIXES = (
    "auth",
    "server",
    "manage/server",
    "users",
    "manage/users",
    "podcasts",
    "libraries",
    "site-access",
    "manage/access",
    "settings",
)
BROWSING_PREFIXES = (
    "tracks",
    "albums",
    "artists",
    "browse-index",
    "playlists",
    "favorites",
    "listening",
    "playback",
    "recommendations",
    "agent",
    "ai",
)


def _outside_music_scope(path: str) -> bool:
    if any(path.startswith("/api/v1/" + prefix) for prefix in EXEMPT_PREFIXES):
        return True
    return path.removeprefix("/api/v1/").partition("/")[0] in {"books", "book-libraries"}


class LibraryAccess:
    def __init__(self, app, *, auth, catalog, router):
        self.app, self.auth, self.catalog, self.router = app, auth, catalog, router
        # FastAPI's included routers match branches without exposing path parameters.
        # Use their effective leaf routes so prefixes and parameter converters remain exact.
        self.routes = [
            leaf
            for route in router.routes
            for leaf in (
                route.effective_route_contexts()
                if hasattr(route, "effective_route_contexts")
                else (route,)
            )
        ]

    def _resolve_context_with_db(
        self, db, scope, request: Request, user: dict, body_bytes: bytes | None
    ):
        path = scope["path"]
        query = parse_qs(scope.get("query_string", b"").decode())
        context = LibraryContext(user["id"])
        exempt = _outside_music_scope(path)
        visible: set[str] = set()
        try:
            visible = allowed_ids(db, user["id"])
            if not exempt:
                selection = query.get(
                    "library_id", [request.headers.get("x-wildstring-library", "all")]
                )[0]
                if selection != "all" and selection not in visible:
                    raise HTTPException(404, "library_not_found")
                selected = None if selection == "all" else selection
                source = query.get("source_id", ["import"])[0]
                targets = []
                parameters = {}
                for route in self.routes:
                    match, child = route.matches(scope)
                    if match == Match.FULL:
                        parameters = child.get("path_params", {})
                        break
                for key in ("track_id", "album_id"):
                    if key in parameters:
                        targets.append(("id" if key == "track_id" else key, parameters[key]))
                for key in (
                    "identity",
                    "task_id",
                    "draft_id",
                    "item_id",
                    "suggestion_id",
                    "batch_id",
                ):
                    if isinstance(parameters.get(key), str):
                        target = object_library(db, parameters[key])
                        if target:
                            if target not in visible:
                                raise HTTPException(404, "library_not_found")
                            selected = target
                            source = object_source(db, parameters[key]) or source
                if "job_id" in parameters:
                    row = db.execute(
                        "SELECT library_id FROM admin_jobs WHERE id=?", (parameters["job_id"],)
                    ).fetchone()
                    if row:
                        if row[0] not in visible:
                            raise HTTPException(404, "task_not_found")
                        selected = row[0]
                for key in ("track_id", "album_id"):
                    if key in query:
                        targets.append(("id" if key == "track_id" else key, query[key][0]))
                if body_bytes is not None:
                    try:
                        value = json.loads(body_bytes)
                    except (ValueError, UnicodeError):
                        value = None
                    if isinstance(value, dict):
                        source = value.get("source_id", source)
                        body_targets, objects = references(value)
                        targets.extend(body_targets)
                        for identity in objects:
                            target = object_library(db, identity)
                            if target:
                                if target not in visible:
                                    raise HTTPException(404, "library_not_found")
                                selected = target
                                source = object_source(db, identity) or source
                libraries = set()
                for field, identity in targets:
                    # field is selected only from the two fixed column literals above.
                    row = db.execute(
                        "SELECT library_id FROM tracks WHERE id=? LIMIT 1"
                        if field == "id"
                        else "SELECT library_id FROM tracks WHERE album_id=? LIMIT 1",
                        (identity,),
                    ).fetchone()
                    if row:
                        if row[0] not in visible:
                            raise HTTPException(
                                404, "track_not_found" if field == "id" else "album_not_found"
                            )
                        libraries.add(row[0])
                if len(libraries) == 1 and not path.startswith("/api/v1/playlists"):
                    selected = next(iter(libraries))
                explicit_all = selection == "all" and (
                    "library_id" in query or "x-wildstring-library" in request.headers
                )
                scoped_write = any(
                    path.startswith("/api/v1/manage/" + part)
                    for part in ("library", "jobs", "intake")
                )
                if (
                    explicit_all
                    and len(visible) > 1
                    and selected is None
                    and scoped_write
                    and scope["method"] in {"POST", "PUT", "PATCH", "DELETE"}
                ):
                    raise HTTPException(422, "library_selection_required")
                browsing = any(path.startswith("/api/v1/" + p) for p in BROWSING_PREFIXES)
                if not browsing and selected is None:
                    if not visible:
                        raise HTTPException(403, "library_access_required")
                    default_row = db.execute(
                        "SELECT id FROM libraries WHERE is_default=1 AND enabled=1 LIMIT 1"
                    ).fetchone()
                    default = default_row[0] if default_row else None
                    selected = default if default in visible else sorted(visible)[0]
                context = LibraryContext(
                    user["id"], selected, source if isinstance(source, str) else "import"
                )
                # Keep the on-disk tree stable while copy/verification is pending.
                if scope["method"] in {"POST", "PUT", "PATCH", "DELETE"} and (
                    path.startswith("/api/v1/manage/")
                    or path.endswith("/apply")
                    or path.endswith("/accept")
                    or path.endswith("/writeback")
                ):
                    from wildstring.library.storage import busy

                    for target in libraries | ({selected} if selected else visible):
                        if busy(db, target):
                            raise HTTPException(409, "library_migration_busy")
        except HTTPException as error:
            fingerprint = hashlib.sha256(json.dumps(sorted(visible)).encode()).hexdigest()[:16]
            return None, fingerprint, error
        fingerprint = hashlib.sha256(json.dumps(sorted(visible)).encode()).hexdigest()[:16]
        return context, fingerprint, None

    def _resolve_context(self, scope, request: Request, user: dict, body_bytes: bytes | None):
        with self.catalog.database.connect(scoped=False) as db:
            return self._resolve_context_with_db(db, scope, request, user, body_bytes)

    def _authenticate_and_resolve(self, scope, request: Request):
        with self.catalog.database.connect(scoped=False) as db:
            try:
                user = self.auth._require_session_with_connection(request, connection=db)
            except HTTPException:
                return None, None, "", None
            context, fingerprint, error = self._resolve_context_with_db(
                db, scope, request, user, None
            )
            return user, context, fingerprint, error

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or not scope["path"].startswith("/api/v1/"):
            return await self.app(scope, receive, send)
        request = Request(scope, receive)
        token_value = self.auth.session_token(request)
        if not token_value or len(token_value) > 128:
            return await self.app(scope, receive, send)
        path = scope["path"]
        exempt = _outside_music_scope(path)
        replay = None
        needs_body_buffer = (
            not exempt
            and request.headers.get("content-type", "").startswith("application/json")
            and scope["method"] in {"POST", "PUT", "PATCH"}
        )
        if needs_body_buffer:
            try:
                user = await anyio.to_thread.run_sync(self.auth.require_session, request)
            except HTTPException:
                return await self.app(scope, receive, send)
            buffer = bytearray()
            async for chunk in request.stream():
                if len(buffer) + len(chunk) > MAX_JSON_BODY_BYTES:
                    visible = await anyio.to_thread.run_sync(self._visible_for, user["id"])
                    fingerprint = hashlib.sha256(json.dumps(sorted(visible)).encode()).hexdigest()[
                        :16
                    ]
                    return await JSONResponse(
                        {"detail": "request_too_large"},
                        status_code=413,
                        headers={"X-Wildstring-Library-Access": fingerprint},
                    )(scope, receive, send)
                buffer.extend(chunk)
            replay = bytes(buffer)
            context, fingerprint, error = await anyio.to_thread.run_sync(
                self._resolve_context, scope, request, user, replay
            )
        else:
            user, context, fingerprint, error = await anyio.to_thread.run_sync(
                self._authenticate_and_resolve, scope, request
            )
            if user is None:
                return await self.app(scope, receive, send)
        if error is not None:
            return await JSONResponse(
                {"detail": error.detail},
                status_code=error.status_code,
                headers={"X-Wildstring-Library-Access": fingerprint},
            )(scope, receive, send)
        token = current_library.set(context)

        async def send_scoped(message):
            if message["type"] == "http.response.start":
                message["headers"] = [
                    *message.get("headers", []),
                    (b"x-wildstring-library-access", fingerprint.encode()),
                ]
            await send(message)

        used = False

        async def replay_receive():
            nonlocal used
            if not used:
                used = True
                return {"type": "http.request", "body": replay, "more_body": False}
            return await receive()

        try:
            return await self.app(
                scope, replay_receive if replay is not None else receive, send_scoped
            )
        finally:
            current_library.reset(token)

    def _visible_for(self, user_id: str) -> set[str]:
        with self.catalog.database.connect(scoped=False) as db:
            return allowed_ids(db, user_id)
