"""Read-only APIs backed by actual scanned files."""

from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import Response
from pydantic import BaseModel

from wildstring.auth import Auth
from wildstring.library.assets import TrackAssets
from wildstring.library.repository import LibraryRepository
from wildstring.library.streaming import AudioResponse


class Track(BaseModel):
    id: str
    album_id: str
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
    loved: bool
    play_count: int
    listened_ms: int
    last_played_at: str | None
    added_at: str


class TrackPage(BaseModel):
    items: list[Track]
    total: int
    limit: int
    offset: int


class Album(BaseModel):
    id: str
    title: str
    artists: list[str]
    track_count: int
    duration_ms: int
    cover_track_id: str


class AlbumPage(BaseModel):
    items: list[Album]
    total: int
    limit: int
    offset: int


class Artist(BaseModel):
    id: str
    name: str
    track_count: int
    album_count: int
    duration_ms: int
    cover_track_id: str


class ArtistPage(BaseModel):
    items: list[Artist]
    total: int
    limit: int
    offset: int


class LyricLine(BaseModel):
    time_ms: int | None
    text: str


class Lyrics(BaseModel):
    kind: Literal["none", "plain", "synced"]
    source: Literal["sidecar_lrc", "embedded", "sidecar_text"] | None
    lines: list[LyricLine]


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
    assets = TrackAssets(repository)

    def require_artist(artist_id: str) -> dict:
        result = repository.artist(artist_id)
        if result is None:
            raise HTTPException(404, "artist_not_found")
        return result

    @router.get("/artists", response_model=ArtistPage)
    def artists(
        q: Annotated[str, Query(max_length=256)] = "",
        limit: Annotated[int, Query(ge=1, le=100)] = 50,
        offset: Annotated[int, Query(ge=0)] = 0,
    ):
        return repository.artists(q, limit, offset)

    @router.get("/artists/{artist_id}", response_model=Artist)
    def artist(artist_id: str):
        return require_artist(artist_id)

    @router.get("/artists/{artist_id}/tracks", response_model=TrackPage)
    def artist_tracks(
        artist_id: str,
        q: Annotated[str, Query(max_length=256)] = "",
        album_id: str | None = None,
        limit: Annotated[int, Query(ge=1, le=200)] = 50,
        offset: Annotated[int, Query(ge=0)] = 0,
    ):
        require_artist(artist_id)
        return repository.tracks(q, limit, offset, album_id=album_id, artist_id=artist_id)

    @router.get("/artists/{artist_id}/albums", response_model=AlbumPage)
    def artist_albums(
        artist_id: str,
        q: Annotated[str, Query(max_length=256)] = "",
        limit: Annotated[int, Query(ge=1, le=100)] = 50,
        offset: Annotated[int, Query(ge=0)] = 0,
    ):
        require_artist(artist_id)
        return repository.albums(q, limit, offset, artist_id=artist_id)

    @router.get("/imports")
    def imports(limit: Annotated[int, Query(ge=1, le=100)] = 20):
        return repository.imports(limit)

    @router.get("/tracks/{track_id}/cover")
    def cover(track_id: str, size: Annotated[int, Query(ge=64, le=768)] = 320):
        result = assets.cover(track_id, size)
        if result is None:
            raise HTTPException(404, "cover_not_found")
        data, source = result
        return Response(
            data,
            media_type="image/jpeg",
            headers={
                "Cache-Control": "private, no-store",
                "X-Content-Type-Options": "nosniff",
                "X-Wildstring-Cover-Source": source,
            },
        )

    @router.get("/tracks/{track_id}/lyrics", response_model=Lyrics)
    def lyrics(track_id: str, response: Response):
        response.headers["Cache-Control"] = "private, no-store"
        return assets.lyrics(track_id)

    @router.get("/albums", response_model=AlbumPage)
    def albums(
        q: Annotated[str, Query(max_length=256)] = "",
        limit: Annotated[int, Query(ge=1, le=100)] = 50,
        offset: Annotated[int, Query(ge=0)] = 0,
    ):
        return repository.albums(q, limit, offset)

    @router.get("/albums/{album_id}", response_model=Album)
    def album(album_id: str):
        result = repository.album(album_id)
        if result is None:
            raise HTTPException(404, "album_not_found")
        return result

    @router.get("/albums/{album_id}/tracks", response_model=TrackPage)
    def album_tracks(
        album_id: str,
        limit: Annotated[int, Query(ge=1, le=200)] = 50,
        offset: Annotated[int, Query(ge=0)] = 0,
    ):
        if repository.album(album_id) is None:
            raise HTTPException(404, "album_not_found")
        return repository.tracks(limit=limit, offset=offset, album_id=album_id)

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
        played_only: bool = False,
        sort: Literal["title", "play_count", "listened_ms", "last_played_at"] = "title",
    ):
        return repository.tracks(q, limit, offset, played_only=played_only, sort=sort)

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
