"""File observations and versioned overrides; never writes audio files."""

import json
from uuid import UUID, uuid4

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, model_validator

from wildstring.library.albums import album_key
from wildstring.library.metadata import normalize
from wildstring.library.tag_fields import DETAIL_DEFAULTS, ROLE_FIELDS, valid_date

BASE_FIELDS = ("title", "artists", "album", "album_artists", "track_number", "disc_number")
FIELDS = (*BASE_FIELDS, *DETAIL_DEFAULTS)


def apply_effective(connection, track_id):
    row = connection.execute(
        "SELECT t.library_id, t.path, m.observed, m.overrides FROM tracks t "
        "JOIN track_metadata m ON m.track_id=t.id WHERE t.id=?",
        (track_id,),
    ).fetchone()
    fields = DETAIL_DEFAULTS | json.loads(row["observed"]) | json.loads(row["overrides"])
    fields["album_id"] = album_key(
        row["library_id"], row["path"], fields["album"], fields["album_artists"]
    )
    fields["search_text"] = normalize(
        " ".join(
            [
                fields["title"],
                *fields["artists"],
                fields["album"] or "",
                *fields["album_artists"],
                *[person for key in ROLE_FIELDS.values() for person in fields[key]],
                *fields["genres"],
            ]
        )
    )
    if "title" in json.loads(row["overrides"]):
        fields["title_source"] = "user"
    from wildstring.library.artists import artist_key

    connection.execute("DELETE FROM track_credits WHERE track_id=?", (track_id,))
    for role, key in {"artist": "artists", "album_artist": "album_artists", **ROLE_FIELDS}.items():
        for position, person in enumerate(fields[key]):
            connection.execute(
                "INSERT OR IGNORE INTO people(id,library_id,name,normalized) VALUES (?,?,?,?)",
                (
                    artist_key(row["library_id"], person),
                    row["library_id"],
                    person,
                    normalize(person),
                ),
            )
            identity = connection.execute(
                "SELECT id FROM people WHERE library_id=? AND normalized=?",
                (row["library_id"], normalize(person)),
            ).fetchone()[0]
            connection.execute(
                "INSERT OR IGNORE INTO track_credits(track_id,person_id,role,position,credited_name) VALUES (?,?,?,?,?)",
                (track_id, identity, role, position, person),
            )
    fields["extra"] = json.dumps({key: fields[key] for key in DETAIL_DEFAULTS}, ensure_ascii=False)
    for key in ("artists", "album_artists"):
        fields[key] = json.dumps(fields[key], ensure_ascii=False)
    fields["id"] = track_id
    connection.execute(
        """UPDATE tracks SET title=:title, title_source=:title_source,
        artists=:artists, album=:album, album_artists=:album_artists,
        track_number=:track_number, disc_number=:disc_number, album_id=:album_id,
        search_text=:search_text,extra=:extra WHERE id=:id""",
        fields,
    )


def observe(connection, track_id, metadata):
    observed = json.dumps(
        DETAIL_DEFAULTS
        | {key: metadata[key] for key in (*BASE_FIELDS, "title_source")}
        | metadata.get("details", {}),
        sort_keys=True,
        ensure_ascii=False,
    )
    previous = connection.execute(
        "SELECT observed FROM track_metadata WHERE track_id=?", (track_id,)
    ).fetchone()
    changed = previous is not None and json.loads(previous["observed"]) != json.loads(observed)
    connection.execute(
        """INSERT INTO track_metadata(track_id, observed) VALUES (?, ?)
        ON CONFLICT(track_id) DO UPDATE SET observed=excluded.observed,
        version=track_metadata.version + ?""",
        (track_id, observed, int(changed)),
    )
    apply_effective(connection, track_id)


class Overrides(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    title: str | None = Field(default=None, min_length=1, max_length=1000)
    artists: list[str] | None = Field(default=None, max_length=50)
    album: str | None = Field(default=None, max_length=1000)
    album_artists: list[str] | None = Field(default=None, max_length=50)
    track_number: int | None = Field(default=None, ge=1, le=99999)
    disc_number: int | None = Field(default=None, ge=1, le=99999)
    artist_credit: str | None = Field(default=None, max_length=1000)
    album_artist_credit: str | None = Field(default=None, max_length=1000)
    composers: list[str] | None = Field(default=None, max_length=50)
    lyricists: list[str] | None = Field(default=None, max_length=50)
    arrangers: list[str] | None = Field(default=None, max_length=50)
    vocalists: list[str] | None = Field(default=None, max_length=50)
    genres: list[str] | None = Field(default=None, max_length=50)
    tags: list[str] | None = Field(default=None, max_length=50)
    track_total: int | None = Field(default=None, ge=1, le=99999)
    disc_total: int | None = Field(default=None, ge=1, le=99999)
    release_date: str | None = None
    original_date: str | None = None
    external_ids: dict | None = Field(default=None, max_length=20)
    description: str | None = Field(default=None, max_length=4096)

    @model_validator(mode="after")
    def validate_values(self):
        for key in self.model_fields_set:
            value = getattr(self, key)
            if (
                key
                in (
                    "title",
                    "artists",
                    "album_artists",
                    "artist_credit",
                    "album_artist_credit",
                    "description",
                    "external_ids",
                    "tags",
                    "genres",
                    *ROLE_FIELDS.values(),
                )
                and value is None
            ):
                raise ValueError("Required metadata cannot be null")
            if (
                key in ("release_date", "original_date")
                and value is not None
                and valid_date(value) is None
            ):
                raise ValueError("Invalid date")
            if key == "external_ids" and value is not None:
                from wildstring.library.tag_fields import ID_TAGS

                if set(value) - set(ID_TAGS):
                    raise ValueError("Unknown external identity")
                for kind, identity in value.items():
                    names = identity if isinstance(identity, list) else [identity]
                    if (kind in {"artists", "album_artists", "works"}) != isinstance(
                        identity, list
                    ):
                        raise ValueError("Invalid external identity shape")
                    if len(names) > 50 or any(
                        not isinstance(name, str) or str(UUID(name)) != name.lower()
                        for name in names
                    ):
                        raise ValueError("Invalid external identity")
            if isinstance(value, str):
                if (
                    not value.strip()
                    and key not in {"artist_credit", "album_artist_credit", "description"}
                ) or "\x00" in value:
                    raise ValueError("Empty or invalid metadata")
                setattr(self, key, value.strip())
            if isinstance(value, list):
                if any(not text.strip() or len(text) > 1000 or "\x00" in text for text in value):
                    raise ValueError("Invalid artist value")
                setattr(self, key, list(dict.fromkeys(text.strip() for text in value)))
        return self


class MetadataUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: int = Field(ge=1, strict=True)
    overrides: Overrides


class MetadataEditor:
    def __init__(self, repository):
        self.repository = repository

    def read(self, track_id):
        with self.repository.database.connect() as connection:
            row = connection.execute(
                """SELECT m.* FROM track_metadata m
                JOIN tracks t ON t.id=m.track_id WHERE t.id=? AND t.library_id=?""",
                (track_id, self.repository.library_id()),
            ).fetchone()
            origins = {
                r[0]: r[1]
                for r in connection.execute(
                    "SELECT field,source FROM metadata_origins WHERE track_id=?", (track_id,)
                )
            }
        if row is None:
            raise HTTPException(404, "track_not_found")
        observed, overrides = (
            DETAIL_DEFAULTS | json.loads(row["observed"]),
            json.loads(row["overrides"]),
        )
        return {
            "track_id": track_id,
            "version": row["version"],
            "observed": observed,
            "overrides": overrides,
            "origins": origins,
            "effective": observed | overrides,
        }

    def save(self, track_id, body, *, user_id="admin", source="manual"):
        with self.repository.database.connect(write=True) as connection:
            connection.execute("BEGIN IMMEDIATE")
            self.save_in_transaction(connection, track_id, body, user_id=user_id, source=source)
        return self.read(track_id)

    def save_in_transaction(self, connection, track_id, body, *, user_id="admin", source="manual"):
        """Validate and write under a caller-owned transaction (e.g. proposal application)."""
        row = connection.execute(
            """SELECT m.version,m.overrides FROM track_metadata m JOIN tracks t
            ON t.id=m.track_id WHERE t.id=? AND t.library_id=?""",
            (track_id, self.repository.library_id()),
        ).fetchone()
        if row is None:
            raise HTTPException(404, "track_not_found")
        if row["version"] != body.version:
            raise HTTPException(409, "metadata_version_conflict")
        connection.execute(
            "INSERT INTO metadata_history(id,track_id,user_id,before_values,after_version,created_at) VALUES (?,?,?,?,?,datetime('now'))",
            (uuid4().hex, track_id, user_id, row["overrides"], body.version + 1),
        )
        connection.execute(
            "UPDATE track_metadata SET overrides=?, version=version+1 WHERE track_id=?",
            (
                json.dumps(body.overrides.model_dump(exclude_unset=True), ensure_ascii=False),
                track_id,
            ),
        )
        before = json.loads(row["overrides"])
        after = body.overrides.model_dump(exclude_unset=True)
        for key in set(before) | set(after):
            if key not in after:
                connection.execute(
                    "DELETE FROM metadata_origins WHERE track_id=? AND field=?", (track_id, key)
                )
            elif key not in before or before[key] != after[key]:
                connection.execute(
                    "INSERT OR REPLACE INTO metadata_origins VALUES (?,?,?)",
                    (track_id, key, source),
                )
        apply_effective(connection, track_id)
