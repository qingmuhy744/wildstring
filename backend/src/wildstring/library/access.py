"""Bind one authorized library context to the full ASGI request, including streams."""

import hashlib
import json
from urllib.parse import parse_qs

from fastapi import HTTPException, Request
from starlette.responses import JSONResponse
from starlette.routing import Match

from wildstring.library.catalog import (
    LibraryContext,
    allowed_ids,
    current_library,
    object_library,
    object_source,
    references,
)


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

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or not scope["path"].startswith("/api/v1/"):
            return await self.app(scope, receive, send)
        request = Request(scope, receive)
        try:
            user = self.auth.require_session(request)
        except HTTPException:
            return await self.app(scope, receive, send)
        path = scope["path"]
        query = parse_qs(scope.get("query_string", b"").decode())
        context = LibraryContext(user["id"])
        exempt = any(
            path.startswith("/api/v1/" + p)
            for p in (
                "auth",
                "users",
                "manage/users",
                "podcasts",
                "libraries",
                "site-access",
                "settings",
            )
        )
        replay = None
        try:
            with self.catalog.database.connect() as db:
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
                    if request.headers.get("content-type", "").startswith(
                        "application/json"
                    ) and scope["method"] in {"POST", "PUT", "PATCH"}:
                        body = await request.body()
                        if len(body) > 2 * 1024 * 1024:
                            raise HTTPException(413, "request_too_large")
                        replay = body
                        try:
                            value = json.loads(body)
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
                    browsing = any(
                        path.startswith("/api/v1/" + p)
                        for p in (
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
                        )
                    )
                    if not browsing and selected is None:
                        if not visible:
                            raise HTTPException(403, "library_access_required")
                        default = self.catalog.default_id()
                        selected = default if default in visible else sorted(visible)[0]
                    context = LibraryContext(
                        user["id"], selected, source if isinstance(source, str) else "import"
                    )
                    # Keep the on-disk tree stable while copy/verification is pending.
                    if scope["method"] in {"POST", "PUT", "PATCH", "DELETE"} and (
                        path.startswith("/api/v1/manage/")
                        or path.endswith("/apply")
                        or path.endswith("/writeback")
                    ):
                        from wildstring.library.storage import busy

                        for target in libraries | ({selected} if selected else visible):
                            if busy(db, target):
                                raise HTTPException(409, "library_migration_busy")
        except HTTPException as error:
            fingerprint = hashlib.sha256(json.dumps(sorted(visible)).encode()).hexdigest()[:16]
            return await JSONResponse(
                {"detail": error.detail},
                status_code=error.status_code,
                headers={"X-Wildstring-Library-Access": fingerprint},
            )(scope, receive, send)
        token = current_library.set(context)
        fingerprint = hashlib.sha256(json.dumps(sorted(visible)).encode()).hexdigest()[:16]

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
