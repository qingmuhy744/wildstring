"""Read-only APIs backed by actual scanned files."""

from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import Response
from pydantic import BaseModel, Field

from wildstring.auth import Auth
from wildstring.library.assets import TrackAssets
from wildstring.library.browsing import BrowseKind
from wildstring.library.repository import LibraryRepository
from wildstring.library.sorting import AlbumSort, SortOrder, TrackSort
from wildstring.library.streaming import AudioResponse


class Track(BaseModel):
    id: str
    library_id: str = ""
    album_id: str
    path: str
    title: str
    title_source: Literal["tag", "filename", "user"]
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
    artist_credit: str = ""
    album_artist_credit: str = ""
    composers: list[str] = Field(default_factory=list)
    lyricists: list[str] = Field(default_factory=list)
    arrangers: list[str] = Field(default_factory=list)
    vocalists: list[str] = Field(default_factory=list)
    genres: list[str] = Field(default_factory=list)
    track_total: int | None = None
    disc_total: int | None = None
    release_date: str | None = None
    original_date: str | None = None
    external_ids: dict = Field(default_factory=dict)
    description: str = ""
    tags: list[str] = Field(default_factory=list)


class DiscSummary(BaseModel):
    number: int
    track_count: int
    duration_ms: int
    offset: int


class TrackPage(BaseModel):
    items: list[Track]
    discs: list[DiscSummary] = Field(default_factory=list)
    total: int
    limit: int
    offset: int


class Album(BaseModel):
    id: str
    library_id: str = ""
    title: str
    artists: list[str]
    track_count: int
    duration_ms: int
    cover_track_id: str
    added_at: str | None = None
    release_date: str | None = None


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


class BrowseGroup(BaseModel):
    key: str
    offset: int | None
    count: int


class BrowseIndex(BaseModel):
    kind: BrowseKind
    total: int
    groups: list[BrowseGroup]


class LyricWord(BaseModel):
    start_ms: int
    end_ms: int
    text: str


class LyricLine(BaseModel):
    time_ms: int | None
    text: str
    end_ms: int | None = None
    words: list[LyricWord] | None = None
    translation: str | None = None
    romanization: str | None = None


class Lyrics(BaseModel):
    kind: Literal["none", "plain", "synced"]
    source: str | None
    source_id: str | None = None
    source_url: str | None = None
    offset_ms: int | None = None
    format: str | None = None
    layers: dict[str, list[LyricLine]] | None = None
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


def library_router(repository: LibraryRepository, auth: Auth, transcoding) -> APIRouter:
    router = APIRouter(
        prefix="/api/v1", tags=["library"], dependencies=[Depends(auth.require_session)]
    )
    assets = TrackAssets(repository)

    def scoped(user: Annotated[dict, Depends(auth.require_session)]):
        return repository.for_user(user["id"])

    def require_artist(artist_id: str) -> dict:
        result = repository.artist(artist_id)
        if result is None:
            raise HTTPException(404, "artist_not_found")
        return result

    @router.get("/browse-index", response_model=BrowseIndex)
    def browse_index(
        kind: BrowseKind,
        q: Annotated[str, Query(max_length=256)] = "",
        artist_id: str | None = None,
        album_id: str | None = None,
        role: Literal["artist", "album_artist", "vocalist", "lyricist", "composer", "arranger"]
        | None = None,
    ):
        # Album members keep disc/track order, so letter offsets would be misleading.
        if album_id is not None or (kind == "artists" and artist_id is not None):
            raise HTTPException(400, "browse_index_not_supported")
        if artist_id is not None:
            require_artist(artist_id)
        return repository.browse_index(kind, q, artist_id=artist_id, role=role)

    @router.get("/artists", response_model=ArtistPage)
    def artists(
        q: Annotated[str, Query(max_length=256)] = "",
        limit: Annotated[int, Query(ge=1, le=100)] = 50,
        offset: Annotated[int, Query(ge=0)] = 0,
        role: Literal["artist", "album_artist", "vocalist", "lyricist", "composer", "arranger"]
        | None = None,
    ):
        return repository.artists(q, limit, offset, role=role)

    @router.get("/artists/{artist_id}", response_model=Artist)
    def artist(artist_id: str):
        return require_artist(artist_id)

    @router.get("/artists/{artist_id}/tracks", response_model=TrackPage)
    def artist_tracks(
        artist_id: str,
        current: Annotated[LibraryRepository, Depends(scoped)],
        q: Annotated[str, Query(max_length=256)] = "",
        album_id: str | None = None,
        limit: Annotated[int, Query(ge=1, le=200)] = 50,
        offset: Annotated[int, Query(ge=0)] = 0,
        sort: TrackSort = "title",
        order: SortOrder | None = None,
        role: Literal["artist", "album_artist", "vocalist", "lyricist", "composer", "arranger"]
        | None = None,
    ):
        require_artist(artist_id)
        return current.tracks(
            q,
            limit,
            offset,
            album_id=album_id,
            artist_id=artist_id,
            role=role,
            sort=sort,
            order=order,
        )

    @router.get("/artists/{artist_id}/albums", response_model=AlbumPage)
    def artist_albums(
        artist_id: str,
        sort: AlbumSort = "title",
        order: SortOrder | None = None,
        q: Annotated[str, Query(max_length=256)] = "",
        limit: Annotated[int, Query(ge=1, le=100)] = 50,
        offset: Annotated[int, Query(ge=0)] = 0,
        role: Literal["artist", "album_artist", "vocalist", "lyricist", "composer", "arranger"]
        | None = None,
    ):
        require_artist(artist_id)
        return repository.albums(
            q, limit, offset, artist_id=artist_id, role=role, sort=sort, order=order
        )

    @router.get("/imports", dependencies=[Depends(auth.require_permission("library:inspect"))])
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

    @router.get(
        "/tracks/{track_id}/lyrics", response_model=Lyrics, response_model_exclude_unset=True
    )
    def lyrics(track_id: str, response: Response):
        response.headers["Cache-Control"] = "private, no-store"
        return assets.lyrics(track_id)

    @router.get("/albums", response_model=AlbumPage)
    def albums(
        sort: AlbumSort = "title",
        order: SortOrder | None = None,
        q: Annotated[str, Query(max_length=256)] = "",
        limit: Annotated[int, Query(ge=1, le=100)] = 50,
        offset: Annotated[int, Query(ge=0)] = 0,
    ):
        return repository.albums(q, limit, offset, sort=sort, order=order)

    @router.get("/albums/{album_id}", response_model=Album)
    def album(album_id: str):
        result = repository.album(album_id)
        if result is None:
            raise HTTPException(404, "album_not_found")
        return result

    @router.get("/albums/{album_id}/tracks", response_model=TrackPage)
    def album_tracks(
        album_id: str,
        current: Annotated[LibraryRepository, Depends(scoped)],
        limit: Annotated[int, Query(ge=1, le=200)] = 50,
        offset: Annotated[int, Query(ge=0)] = 0,
        sort: TrackSort = "title",
        order: SortOrder | None = None,
    ):
        if repository.album(album_id) is None:
            raise HTTPException(404, "album_not_found")
        return current.tracks(limit=limit, offset=offset, album_id=album_id, sort=sort, order=order)

    @router.api_route("/tracks/{track_id}/stream", methods=["GET", "HEAD"])
    def stream(
        track_id: str,
        request: Request,
        format: Literal["aac"] | None = None,
        bitrate_kbps: int | None = None,
        start_ms: Annotated[int, Query(ge=0, le=86_400_000)] = 0,
    ):
        if format is not None or bitrate_kbps is not None or start_ms:
            plan = transcoding.plan(track_id, format, bitrate_kbps, start_ms)
            return transcoding.response(plan, request)
        source = repository.source(track_id)
        if source is None:
            raise HTTPException(404, "track_not_found")
        if source["status"] != "available":
            raise HTTPException(409, "track_unavailable")
        return AudioResponse(repository.root, source, request)

    @router.get("/tracks/{track_id}/playback")
    def playback(
        track_id: str,
        format: Literal["aac"] | None = None,
        bitrate_kbps: int | None = None,
        start_ms: Annotated[int, Query(ge=0, le=86_400_000)] = 0,
    ):
        plan = transcoding.plan(track_id, format, bitrate_kbps, start_ms)
        return plan.public(transcoding.cache_state(plan))

    @router.get("/tracks", response_model=TrackPage)
    def tracks(
        current: Annotated[LibraryRepository, Depends(scoped)],
        q: Annotated[str, Query(max_length=256)] = "",
        limit: Annotated[int, Query(ge=1, le=200)] = 50,
        offset: Annotated[int, Query(ge=0)] = 0,
        played_only: bool = False,
        sort: TrackSort = "title",
        order: SortOrder | None = None,
    ):
        return current.tracks(q, limit, offset, played_only=played_only, sort=sort, order=order)

    @router.get("/tracks/{track_id}", response_model=Track)
    def track(track_id: str, current: Annotated[LibraryRepository, Depends(scoped)]):
        result = current.track(track_id)
        if result is None:
            raise HTTPException(status_code=404, detail="track_not_found")
        return result

    @router.get("/tracks/{track_id}/file-info")
    def track_file_info(track_id: str, current: Annotated[LibraryRepository, Depends(scoped)]):
        from wildstring.library.file_reorganizer import get_track_file_info

        return get_track_file_info(current, track_id)

    @router.get(
        "/scans",
        response_model=list[ScanReport],
        dependencies=[Depends(auth.require_permission("library:inspect"))],
    )
    def scans(limit: Annotated[int, Query(ge=1, le=100)] = 20):
        return repository.scans(limit)

    @router.get(
        "/scans/{run_id}",
        response_model=ScanReport,
        dependencies=[Depends(auth.require_permission("library:inspect"))],
    )
    def scan(run_id: str):
        result = repository.scan(run_id)
        if result is None:
            raise HTTPException(status_code=404, detail="scan_not_found")
        return result

    return router
