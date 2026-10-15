"""Application factory and foundation health endpoints."""

import asyncio
import logging
import os
import sqlite3
from contextlib import asynccontextmanager
from importlib.metadata import version
from tempfile import TemporaryFile

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from wildstring.auth import Auth
from wildstring.config import Settings
from wildstring.database import Database
from wildstring.library.api import library_router
from wildstring.library.listening import listening_router
from wildstring.library.playlists import PlaylistStore, playlist_router
from wildstring.library.repository import LibraryRepository
from wildstring.library.transcoding import Transcoding
from wildstring.management import Management, management_router
from wildstring.site_access import HostAllowlist, SiteAccess

logger = logging.getLogger(__name__)


def create_app(settings: Settings | None = None) -> FastAPI:
    current = settings if settings is not None else Settings()
    database = Database(current.data_dir)
    auth = Auth(database, current)
    repository = LibraryRepository(database, current.library_dir)
    playlists = PlaylistStore(repository)
    management = Management(current, repository)
    access = SiteAccess(database)
    transcoding = Transcoding(repository)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        current.data_dir.mkdir(parents=True, exist_ok=True)
        current.library_dir.mkdir(parents=True, exist_ok=True)
        database.initialize()
        playlists.ensure_default()
        if (
            current.admin_password is not None
            and current.admin_password.get_secret_value()
            and not auth.configured()
        ):
            auth.set_password(current.admin_password.get_secret_value(), only_if_empty=True)
        management.start()
        transcoding.start()
        try:
            yield
        finally:
            await asyncio.to_thread(management.stop)
            await asyncio.to_thread(transcoding.stop)

    development = current.environment != "production"
    app = FastAPI(
        title="WildString API",
        version=version("wildstring-backend"),
        lifespan=lifespan,
        docs_url="/docs" if development else None,
        redoc_url=None,
        openapi_url="/openapi.json" if development else None,
    )

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok", "version": app.version}

    @app.get("/health/ready")
    def ready() -> JSONResponse:
        checks: dict[str, str] = {}
        try:
            with TemporaryFile(dir=current.data_dir) as probe:
                probe.write(b"wildstring-readiness")
                probe.flush()
            checks["data_directory"] = "ok"
        except OSError:
            logger.warning("Data directory is not writable")
            checks["data_directory"] = "unavailable"
        try:
            with os.scandir(current.library_dir) as entries:
                next(entries, None)
            checks["music_directory"] = "ok"
        except OSError:
            logger.warning("Music directory is not readable")
            checks["music_directory"] = "unavailable"
        try:
            checks["database"] = "ok" if database.check_ready() else "unavailable"
        except (sqlite3.Error, OSError):
            checks["database"] = "unavailable"
        available = all(result == "ok" for result in checks.values())
        return JSONResponse(
            {"status": "ok" if available else "unavailable", "checks": checks},
            status_code=200 if available else 503,
        )

    app.include_router(auth.router())
    app.include_router(auth.users_router())
    app.include_router(access.router(auth))
    app.state.transcoding = transcoding
    app.include_router(library_router(repository, auth, transcoding))
    app.include_router(transcoding.router(auth))
    app.include_router(listening_router(repository, auth))
    app.include_router(playlist_router(playlists, auth))
    app.include_router(management_router(management, auth))

    if current.web_dir is not None:
        app.mount("/", StaticFiles(directory=current.web_dir, html=True), name="web")

    app.add_middleware(HostAllowlist, access=access)

    return app
