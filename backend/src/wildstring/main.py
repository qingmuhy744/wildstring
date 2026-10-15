"""Application factory and foundation health endpoints."""

import logging
import os
from contextlib import asynccontextmanager
from importlib.metadata import version
from tempfile import TemporaryFile

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from wildstring.config import Settings

logger = logging.getLogger(__name__)


def create_app(settings: Settings | None = None) -> FastAPI:
    current = settings if settings is not None else Settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        current.data_dir.mkdir(parents=True, exist_ok=True)
        yield

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
            with os.scandir(current.music_dir) as entries:
                next(entries, None)
            checks["music_directory"] = "ok"
        except OSError:
            logger.warning("Music directory is not readable")
            checks["music_directory"] = "unavailable"
        available = all(result == "ok" for result in checks.values())
        return JSONResponse(
            {"status": "ok" if available else "unavailable", "checks": checks},
            status_code=200 if available else 503,
        )

    if current.web_dir is not None:
        app.mount("/", StaticFiles(directory=current.web_dir, html=True), name="web")

    return app
