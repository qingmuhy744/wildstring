"""Read-only APIs backed by actual scanned files."""

from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel

from wildstring.auth import Auth
from wildstring.library.repository import LibraryRepository
from wildstring.library.streaming import AudioResponse


class Track(BaseModel):
    id: str
    path: str
    title: str
    title_source: Literal["tag", "filename"]
    artists: list[str]
    album: str | None
    album_artists: list[str]
    track_number: int | None
    disc_number: int | None
    duration_ms: int
    format: Literal["mp3", "flac", "m4a"]
    sample_rate: int | None
    channels: int | None
    has_cover: bool
    size_bytes: int
    status: Literal["available", "missing", "unreadable"]


class TrackPage(BaseModel):
    items: list[Track]
    total: int
    limit: int
    offset: int


class ScanError(BaseModel):
    path: str
    code: str


class ScanReport(BaseModel):
    id: str
    status: Literal["running", "completed", "completed_with_errors", "failed", "interrupted"]
    started_at: str
    finished_at: str | None
    counts: dict[str, int]
    errors: list[ScanError]


def library_router(repository: LibraryRepository, auth: Auth) -> APIRouter:
    router = APIRouter(
        prefix="/api/v1", tags=["library"], dependencies=[Depends(auth.require_session)]
    )

    @router.api_route("/tracks/{track_id}/stream", methods=["GET", "HEAD"])
    def stream(track_id: str, request: Request):
        source = repository.source(track_id)
        if source is None:
            raise HTTPException(404, "track_not_found")
        if source["status"] != "available":
            raise HTTPException(409, "track_unavailable")
        return AudioResponse(repository.root, source, request)

    @router.get("/tracks", response_model=TrackPage)
    def tracks(
        q: Annotated[str, Query(max_length=256)] = "",
        limit: Annotated[int, Query(ge=1, le=200)] = 50,
        offset: Annotated[int, Query(ge=0)] = 0,
    ):
        return repository.tracks(q, limit, offset)

    @router.get("/tracks/{track_id}", response_model=Track)
    def track(track_id: str):
        result = repository.track(track_id)
        if result is None:
            raise HTTPException(status_code=404, detail="track_not_found")
        return result

    @router.get("/scans", response_model=list[ScanReport])
    def scans(limit: Annotated[int, Query(ge=1, le=100)] = 20):
        return repository.scans(limit)

    @router.get("/scans/{run_id}", response_model=ScanReport)
    def scan(run_id: str):
        result = repository.scan(run_id)
        if result is None:
            raise HTTPException(status_code=404, detail="scan_not_found")
        return result

    return router
