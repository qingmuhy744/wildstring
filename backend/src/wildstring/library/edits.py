"""File observations and versioned overrides; never writes audio files."""

import json

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, model_validator

from wildstring.library.albums import album_key
from wildstring.library.metadata import normalize

FIELDS = ("title", "artists", "album", "album_artists", "track_number", "disc_number")


def apply_effective(connection, track_id):
    row = connection.execute(
        "SELECT t.library_id, t.path, m.observed, m.overrides FROM tracks t "
        "JOIN track_metadata m ON m.track_id=t.id WHERE t.id=?",
        (track_id,),
    ).fetchone()
    fields = json.loads(row["observed"]) | json.loads(row["overrides"])
    fields["album_id"] = album_key(
        row["library_id"], row["path"], fields["album"], fields["album_artists"]
    )
    fields["search_text"] = normalize(
        " ".join(
            [fields["title"], *fields["artists"], fields["album"] or "", *fields["album_artists"]]
        )
    )
    if "title" in json.loads(row["overrides"]):
        fields["title_source"] = "user"
    for key in ("artists", "album_artists"):
        fields[key] = json.dumps(fields[key], ensure_ascii=False)
    fields["id"] = track_id
    connection.execute(
        """UPDATE tracks SET title=:title, title_source=:title_source,
        artists=:artists, album=:album, album_artists=:album_artists,
        track_number=:track_number, disc_number=:disc_number, album_id=:album_id,
        search_text=:search_text WHERE id=:id""",
        fields,
    )


def observe(connection, track_id, metadata):
    observed = json.dumps(
        {key: metadata[key] for key in (*FIELDS, "title_source")},
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

    @model_validator(mode="after")
    def validate_values(self):
        for key in self.model_fields_set:
            value = getattr(self, key)
            if key in ("title", "artists", "album_artists") and value is None:
                raise ValueError("Required metadata cannot be null")
            if isinstance(value, str):
                if not value.strip() or "\x00" in value:
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
        if row is None:
            raise HTTPException(404, "track_not_found")
        observed, overrides = json.loads(row["observed"]), json.loads(row["overrides"])
        return {
            "track_id": track_id,
            "version": row["version"],
            "observed": observed,
            "overrides": overrides,
            "effective": observed | overrides,
        }

    def save(self, track_id, body):
        with self.repository.database.connect(write=True) as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                """SELECT m.version FROM track_metadata m JOIN tracks t
                ON t.id=m.track_id WHERE t.id=? AND t.library_id=?""",
                (track_id, self.repository.library_id()),
            ).fetchone()
            if row is None:
                raise HTTPException(404, "track_not_found")
            if row["version"] != body.version:
                raise HTTPException(409, "metadata_version_conflict")
            connection.execute(
                "UPDATE track_metadata SET overrides=?, version=version+1 WHERE track_id=?",
                (
                    json.dumps(body.overrides.model_dump(exclude_unset=True), ensure_ascii=False),
                    track_id,
                ),
            )
            apply_effective(connection, track_id)
        return self.read(track_id)
