"""Persistent manual, smart and built-in favorites playlists."""

import json
from typing import Annotated, Literal
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field, model_validator

from wildstring.library.artists import configure_artist_queries
from wildstring.library.metadata import normalize
from wildstring.library.repository import LibraryRepository, now
from wildstring.library.smart_playlists import SORT, SmartDefinition, compile_rules


class PlaylistCreate(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    name: str = Field(min_length=1, max_length=100)
    kind: Literal["manual", "smart"] = "manual"
    definition: SmartDefinition | None = None

    @model_validator(mode="after")
    def matching_kind(self):
        if (self.kind == "smart") != (self.definition is not None):
            raise ValueError("Only smart playlists have a definition")
        return self


class PlaylistUpdate(PlaylistCreate):
    version: int = Field(ge=1, strict=True)


class PlaylistTracks(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: int = Field(ge=1, strict=True)
    track_ids: list[str] = Field(min_length=1, max_length=5000)


class PlaylistStore:
    def __init__(self, library: LibraryRepository):
        self.library = library
        self.database = library.database
        self.user_id = library.database.user_id

    def ensure_default(self):
        library_id = self.library.library_id(create=True)
        with self.database.connect(write=True) as connection:
            connection.execute(
                """INSERT OR IGNORE INTO playlists
                (id, library_id, name, kind, created_at, updated_at, user_id) VALUES (?, ?, '♥ 我喜欢', 'favorites', ?, ?, ?)""",
                (
                    "favorites-"
                    + library_id
                    + ("" if self.user_id == "admin" else "-" + self.user_id),
                    library_id,
                    now(),
                    now(),
                    self.user_id,
                ),
            )

    def _record(self, connection, playlist_id, version=None, editable=False):
        row = connection.execute(
            "SELECT * FROM playlists WHERE id = ? AND library_id = ? AND user_id = ?",
            (playlist_id, self.library.library_id(), self.user_id),
        ).fetchone()
        if row is None:
            raise HTTPException(404, "playlist_not_found")
        result = dict(row)
        if editable and result["kind"] == "favorites":
            raise HTTPException(409, "favorites_playlist_readonly")
        if version is not None and result["version"] != version:
            raise HTTPException(409, "playlist_version_conflict")
        return result

    def _selection(self, record, q=""):
        where = "t.library_id = :library_id AND t.status = 'available'"
        parameters = {"library_id": self.library.library_id(), "playlist_id": record["id"]}
        cap = 2_147_483_647
        if record["kind"] == "manual":
            where += " AND t.id IN (SELECT track_id FROM playlist_tracks WHERE playlist_id = :playlist_id)"
            order = "(SELECT position FROM playlist_tracks WHERE playlist_id = :playlist_id AND track_id = t.id)"
        elif record["kind"] == "favorites":
            where += " AND t.loved = 1"
            order = "t.loved_at DESC, t.id"
        else:
            definition = SmartDefinition.model_validate_json(record["definition"])
            condition, values = compile_rules(
                {"all": definition.all} if definition.all is not None else {"any": definition.any}
            )
            where += " AND " + condition
            parameters.update(values)
            column = SORT[definition.sort]
            direction = "DESC" if definition.order == "desc" else "ASC"
            order = f"{column} {direction}, t.id"
            cap = definition.limit
        # Search narrows the already limited playlist rather than selecting a new smart result.
        query = normalize(q).replace("\\", "\\\\").replace("%", r"\%").replace("_", r"\_")
        parameters.update(cap=cap, query=query, pattern=f"%{query}%")
        # Both fragments are generated above from fixed literals or validated rule whitelists.
        selection = "".join(
            ("SELECT t.* FROM personal_tracks t WHERE ", where, " ORDER BY ", order, " LIMIT :cap")
        )
        return selection, parameters

    def _public(self, connection, record):
        selection, parameters = self._selection(record)
        # selection is built exclusively by _selection; all user values are SQL parameters.
        summary = connection.execute(
            "".join(
                (
                    "SELECT count(*) AS track_count, COALESCE(sum(duration_ms), 0) AS duration_ms, "
                    "COALESCE(min(CASE WHEN has_cover THEN id END), min(id)) AS cover_track_id FROM (",
                    selection,
                    ")",
                )
            ),
            parameters,
        ).fetchone()
        result = {
            key: value for key, value in record.items() if key not in {"library_id", "user_id"}
        }
        result.update(dict(summary))
        result["definition"] = json.loads(record["definition"]) if record["definition"] else None
        return result

    def get(self, playlist_id):
        with self.database.connect() as connection:
            configure_artist_queries(connection)
            return self._public(connection, self._record(connection, playlist_id))

    def listing(self, q="", limit=50, offset=0):
        query = normalize(q).replace("\\", "\\\\").replace("%", r"\%").replace("_", r"\_")
        parameters = (self.library.library_id(), self.user_id, query, f"%{query}%")
        with self.database.connect() as connection:
            configure_artist_queries(connection)
            total = connection.execute(
                "SELECT count(*) FROM playlists WHERE library_id = ? AND user_id = ? AND (? = '' OR normalized(name) LIKE ? ESCAPE '\\')",
                parameters,
            ).fetchone()[0]
            rows = connection.execute(
                "SELECT * FROM playlists WHERE library_id = ? AND user_id = ? AND (? = '' OR normalized(name) LIKE ? ESCAPE '\\') ORDER BY kind = 'favorites' DESC, updated_at DESC, id LIMIT ? OFFSET ?",
                (*parameters, limit, offset),
            ).fetchall()
            items = [self._public(connection, dict(row)) for row in rows]
        return {"items": items, "total": total, "limit": limit, "offset": offset}

    def tracks(self, playlist_id, q="", limit=50, offset=0):
        with self.database.connect() as connection:
            configure_artist_queries(connection)
            record = self._record(connection, playlist_id)
            selection, parameters = self._selection(record, q)
            filtered = "".join(
                (
                    "SELECT * FROM (",
                    selection,
                    ") WHERE :query = '' OR search_text LIKE :pattern ESCAPE '\\'",
                )
            )
            total = connection.execute(
                "".join(("SELECT count(*) FROM (", filtered, ")")), parameters
            ).fetchone()[0]
            rows = connection.execute(
                filtered + " LIMIT :page_limit OFFSET :offset",
                {**parameters, "page_limit": limit, "offset": offset},
            ).fetchall()
        return {
            "items": [self.library.public_track(dict(row)) for row in rows],
            "total": total,
            "limit": limit,
            "offset": offset,
        }

    def create(self, body):
        playlist_id = uuid4().hex
        with self.database.connect(write=True) as connection:
            connection.execute(
                """INSERT INTO playlists(id, library_id, name, kind, definition, created_at, updated_at, user_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    playlist_id,
                    self.library.library_id(),
                    body.name,
                    body.kind,
                    body.definition.model_dump_json(exclude_none=True) if body.definition else None,
                    now(),
                    now(),
                    self.user_id,
                ),
            )
        return self.get(playlist_id)

    def update(self, playlist_id, body):
        with self.database.connect(write=True) as connection:
            connection.execute("BEGIN IMMEDIATE")
            record = self._record(connection, playlist_id, body.version, editable=True)
            if body.kind != record["kind"]:
                raise HTTPException(409, "playlist_kind_immutable")
            connection.execute(
                "UPDATE playlists SET name = ?, definition = ?, version = version + 1, updated_at = ? WHERE id = ?",
                (
                    body.name,
                    body.definition.model_dump_json(exclude_none=True) if body.definition else None,
                    now(),
                    playlist_id,
                ),
            )
        return self.get(playlist_id)

    def delete(self, playlist_id, version):
        with self.database.connect(write=True) as connection:
            connection.execute("BEGIN IMMEDIATE")
            self._record(connection, playlist_id, version, editable=True)
            connection.execute("DELETE FROM playlists WHERE id = ?", (playlist_id,))

    def edit_tracks(
        self, playlist_id, version, *, append=None, remove=None, reorder=None, move=None
    ):
        with self.database.connect(write=True) as connection:
            connection.execute("BEGIN IMMEDIATE")
            record = self._record(connection, playlist_id, version, editable=True)
            if record["kind"] != "manual":
                raise HTTPException(409, "smart_playlist_tracks_readonly")
            ids = [
                row["track_id"]
                for row in connection.execute(
                    "SELECT track_id FROM playlist_tracks WHERE playlist_id = ? ORDER BY position",
                    (playlist_id,),
                )
            ]
            if append:
                for track_id in append:
                    if (
                        not isinstance(track_id, str)
                        or len(track_id) > 128
                        or connection.execute(
                            "SELECT id FROM tracks WHERE id = ? AND library_id = ? AND status = 'available'",
                            (track_id, self.library.library_id()),
                        ).fetchone()
                        is None
                    ):
                        raise HTTPException(404, "track_not_found")
                ids = list(dict.fromkeys([*ids, *append]))
                if len(ids) > 5000:
                    raise HTTPException(422, "playlist_track_limit")
            if remove is not None:
                if remove not in ids:
                    raise HTTPException(404, "playlist_track_not_found")
                ids.remove(remove)
            if reorder is not None:
                if len(reorder) != len(ids) or set(reorder) != set(ids):
                    raise HTTPException(409, "playlist_order_conflict")
                ids = reorder
            if move is not None:
                track_id, direction = move
                if track_id not in ids:
                    raise HTTPException(404, "playlist_track_not_found")
                start = ids.index(track_id)
                target = max(0, min(len(ids) - 1, start + direction))
                ids.insert(target, ids.pop(start))
            connection.execute("DELETE FROM playlist_tracks WHERE playlist_id = ?", (playlist_id,))
            connection.executemany(
                "INSERT INTO playlist_tracks VALUES (?, ?, ?)",
                [(playlist_id, track_id, i) for i, track_id in enumerate(ids)],
            )
            connection.execute(
                "UPDATE playlists SET version = version + 1, updated_at = ? WHERE id = ?",
                (now(), playlist_id),
            )
        return self.get(playlist_id)


class PlaylistMove(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: int = Field(ge=1, strict=True)
    track_id: str = Field(min_length=1, max_length=128)
    direction: Literal[-1, 1]


def playlist_router(store: PlaylistStore, auth):
    router = APIRouter(prefix="/api/v1/playlists", dependencies=[Depends(auth.require_session)])

    def scoped(user: Annotated[dict, Depends(auth.require_session)]):
        current = PlaylistStore(store.library.for_user(user["id"]))
        current.ensure_default()
        return current

    @router.get("")
    def listing(
        current: Annotated[PlaylistStore, Depends(scoped)],
        q: str = Query(default="", max_length=256),
        limit: int = Query(default=50, ge=1, le=100),
        offset: int = Query(default=0, ge=0),
    ):
        return current.listing(q, limit, offset)

    @router.post("", dependencies=[Depends(auth.require_client)], status_code=201)
    def create(body: PlaylistCreate, current: Annotated[PlaylistStore, Depends(scoped)]):
        return current.create(body)

    @router.get("/{playlist_id}")
    def detail(playlist_id: str, current: Annotated[PlaylistStore, Depends(scoped)]):
        return current.get(playlist_id)

    @router.put("/{playlist_id}", dependencies=[Depends(auth.require_client)])
    def update(
        playlist_id: str, body: PlaylistUpdate, current: Annotated[PlaylistStore, Depends(scoped)]
    ):
        return current.update(playlist_id, body)

    @router.delete("/{playlist_id}", dependencies=[Depends(auth.require_client)], status_code=204)
    def delete(
        playlist_id: str,
        current: Annotated[PlaylistStore, Depends(scoped)],
        version: int = Query(ge=1),
    ):
        current.delete(playlist_id, version)

    @router.get("/{playlist_id}/tracks")
    def tracks(
        playlist_id: str,
        current: Annotated[PlaylistStore, Depends(scoped)],
        q: str = Query(default="", max_length=256),
        limit: int = Query(default=50, ge=1, le=200),
        offset: int = Query(default=0, ge=0),
    ):
        return current.tracks(playlist_id, q, limit, offset)

    @router.post("/{playlist_id}/tracks", dependencies=[Depends(auth.require_client)])
    def append(
        playlist_id: str, body: PlaylistTracks, current: Annotated[PlaylistStore, Depends(scoped)]
    ):
        return current.edit_tracks(playlist_id, body.version, append=body.track_ids)

    @router.delete("/{playlist_id}/tracks/{track_id}", dependencies=[Depends(auth.require_client)])
    def remove(
        playlist_id: str,
        track_id: str,
        current: Annotated[PlaylistStore, Depends(scoped)],
        version: int = Query(ge=1),
    ):
        return current.edit_tracks(playlist_id, version, remove=track_id)

    @router.put("/{playlist_id}/order", dependencies=[Depends(auth.require_client)])
    def reorder(
        playlist_id: str, body: PlaylistTracks, current: Annotated[PlaylistStore, Depends(scoped)]
    ):
        return current.edit_tracks(playlist_id, body.version, reorder=body.track_ids)

    @router.post("/{playlist_id}/move", dependencies=[Depends(auth.require_client)])
    def move(
        playlist_id: str, body: PlaylistMove, current: Annotated[PlaylistStore, Depends(scoped)]
    ):
        return current.edit_tracks(playlist_id, body.version, move=(body.track_id, body.direction))

    return router
