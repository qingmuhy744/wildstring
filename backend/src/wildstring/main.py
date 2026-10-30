"""Application factory and foundation health endpoints."""

import asyncio
import logging
import os
import sqlite3
from contextlib import asynccontextmanager
from tempfile import TemporaryFile

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.routing import Route

from wildstring import get_app_version
from wildstring.agent_platform import AgentPlatform
from wildstring.auth import Auth
from wildstring.catalog_gaps import catalog_gaps_router
from wildstring.config import Settings
from wildstring.database import Database
from wildstring.diagnostics import Diagnostics, RequestTrace, diagnostics_router, install_logging
from wildstring.library.access import LibraryAccess
from wildstring.library.api import library_router
from wildstring.library.catalog import LibraryCatalog
from wildstring.library.listening import listening_router
from wildstring.library.playlists import PlaylistStore, playlist_router
from wildstring.library.repository import LibraryRepository
from wildstring.library.transcoding import Transcoding
from wildstring.management import Management, management_router
from wildstring.mcp_http import HTTPMCP
from wildstring.mobile_experience import experience_router
from wildstring.podcasts import PodcastManager, podcast_router
from wildstring.providers import Providers
from wildstring.request_privacy import CallbackPrivacy, install_callback_filter
from wildstring.site_access import HostAllowlist, SiteAccess

logger = logging.getLogger(__name__)


def create_app(settings: Settings | None = None) -> FastAPI:
    install_callback_filter()
    current = settings if settings is not None else Settings()
    database = Database(current.data_dir)
    auth = Auth(database, current)
    repository = LibraryRepository(database, current.library_dir)
    catalog = LibraryCatalog(database, current)
    playlists = PlaylistStore(repository)
    management = Management(current, repository)
    access = SiteAccess(database)
    transcoding = Transcoding(repository)
    providers = Providers(repository)
    diagnostics = Diagnostics(current.data_dir)
    diagnostics.database = database
    diagnostics.repository = repository
    platform = AgentPlatform(repository, auth)
    platform.diagnostics = diagnostics
    platform.providers = providers
    platform.management = management
    providers.diagnostics = diagnostics
    management.diagnostics = diagnostics
    providers.platform = platform
    management.platform = platform
    podcasts = PodcastManager(
        database,
        providers=providers,
        storage_dir=current.podcasts_dir,
    )
    mcp = HTTPMCP(platform)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        current.data_dir.mkdir(parents=True, exist_ok=True)
        current.podcasts_dir.mkdir(parents=True, exist_ok=True)
        database.initialize()
        catalog.initialize()
        repository.root.mkdir(parents=True, exist_ok=True)
        diagnostics.start()
        install_logging()
        playlists.ensure_default()
        if (
            current.admin_password is not None
            and current.admin_password.get_secret_value()
            and not auth.configured()
        ):
            auth.set_password(current.admin_password.get_secret_value(), only_if_empty=True)
        management.start()
        transcoding.start()
        providers.start()
        platform.start()
        podcasts.start()
        try:
            async with mcp.run():
                yield
        finally:
            await asyncio.to_thread(podcasts.stop)
            await asyncio.to_thread(platform.stop)
            await asyncio.to_thread(providers.stop)
            await asyncio.to_thread(management.stop)
            await asyncio.to_thread(transcoding.stop)
            await asyncio.to_thread(diagnostics.stop)

    development = current.environment != "production"
    app = FastAPI(
        title="WildString API",
        version=get_app_version(),
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
            with os.scandir(repository.root) as entries:
                next(entries, None)
            checks["music_directory"] = "ok"
        except (OSError, sqlite3.Error):
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
    app.state.library_catalog = catalog
    app.state.podcasts = podcasts
    app.state.management = management
    app.include_router(catalog.router(auth))
    app.state.providers = providers
    app.state.diagnostics = diagnostics
    app.state.agent_platform = platform
    app.include_router(platform.router())
    app.router.routes.append(Route("/mcp", endpoint=mcp, methods=["GET", "POST", "DELETE"]))
    app.include_router(providers.router(auth))
    app.include_router(providers.sources.router(auth))
    app.include_router(providers.sources.scans.router(auth))
    app.include_router(providers.loudness.router(auth))
    app.include_router(library_router(repository, auth, transcoding))
    app.include_router(transcoding.router(auth))
    app.include_router(listening_router(repository, auth, providers))
    app.include_router(playlist_router(playlists, auth))
    app.include_router(management_router(management, auth, providers))
    app.include_router(experience_router(repository, auth, providers, platform))
    app.include_router(podcasts.resources.router(auth))
    app.include_router(
        podcast_router(podcasts, auth, search_regions=current.podcast_search_regions)
    )
    app.include_router(catalog_gaps_router(database, auth))

    app.include_router(diagnostics_router(diagnostics, auth, database))

    if current.web_dir is not None:
        app.mount("/", StaticFiles(directory=current.web_dir, html=True), name="web")

    app.add_middleware(LibraryAccess, auth=auth, catalog=catalog, router=app.router)
    app.add_middleware(HostAllowlist, access=access)
    app.add_middleware(CallbackPrivacy)
    app.add_middleware(RequestTrace, diagnostics=diagnostics)

    return app
