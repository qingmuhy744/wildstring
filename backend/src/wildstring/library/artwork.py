"""Content-addressed cover choices shared by manual UI and approved Agent drafts."""

import hashlib
import json
import os
from pathlib import Path
from tempfile import NamedTemporaryFile

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field

from wildstring.library.assets import MAX_COVER_BYTES, TrackAssets


class CoverTarget(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    track_id: str = Field(min_length=1, max_length=128)
    metadata_version: int = Field(ge=1)


class CoverProposal(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    suggestion_id: str = Field(min_length=1, max_length=128)
    metadata_version: int = Field(ge=1)
    targets: list[CoverTarget] | None = Field(default=None, min_length=1, max_length=500)


class CoverSelection(CoverProposal):
    image_sha256: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")
    candidate_key: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")


class CoverSelections:
    def __init__(self, providers):
        self.providers = providers
        self.repository = providers.repository
        self.database = self.repository.database
        self.folder = self.database.path.parent / "artwork"

    def candidate(self, connection, identity, version=None):
        row = connection.execute(
            "SELECT s.*,m.version AS current_version,t.title,t.has_cover "
            "FROM metadata_suggestions s JOIN tracks t ON t.id=s.track_id "
            "JOIN track_metadata m ON m.track_id=t.id "
            "WHERE s.id=? AND t.library_id=? AND t.status='available'",
            (identity, self.repository.library_id()),
        ).fetchone()
        if row is None or not row["cover_url"] or row["status"] == "ignored":
            raise HTTPException(404, "suggestion_not_found")
        if version is not None and (
            row["metadata_version"] != version or row["current_version"] != version
        ):
            raise HTTPException(409, "metadata_version_conflict")
        return row

    @staticmethod
    def key(row):
        value = [
            row[key]
            for key in (
                "id",
                "track_id",
                "metadata_version",
                "provider",
                "source_url",
                "cover_url",
                "fields",
                "match",
            )
        ]
        return hashlib.sha256(json.dumps(value, ensure_ascii=False).encode()).hexdigest()

    def store(self, data):
        key = hashlib.sha256(data).hexdigest()
        self.folder.mkdir(parents=True, exist_ok=True)
        with NamedTemporaryFile(dir=self.folder, delete=False) as stream:
            temporary = Path(stream.name)
            try:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
                temporary.replace(self.folder / key)
            finally:
                temporary.unlink(missing_ok=True)
        return key

    def image(self, key, size=768):
        import re

        if not isinstance(key, str) or not re.fullmatch(r"[0-9a-f]{64}", key):
            raise HTTPException(422, "invalid_cover_snapshot")
        try:
            with (self.folder / key).open("rb") as stream:
                data = stream.read(MAX_COVER_BYTES + 1)
        except OSError:
            raise HTTPException(409, "cover_snapshot_unavailable") from None
        if len(data) > MAX_COVER_BYTES or hashlib.sha256(data).hexdigest() != key:
            raise HTTPException(409, "cover_snapshot_unavailable")
        thumbnail = TrackAssets(self.repository).thumbnail(data, size)
        if thumbnail is None:
            raise HTTPException(409, "cover_snapshot_unavailable")
        return data, thumbnail

    def targets(self, connection, body, source):
        targets = body.targets or [
            CoverTarget(track_id=source["track_id"], metadata_version=body.metadata_version)
        ]
        identities = [t.track_id for t in targets]
        if len(set(identities)) != len(identities) or source["track_id"] not in identities:
            raise HTTPException(422, "invalid_cover_targets")
        album = connection.execute(
            "SELECT album_id FROM tracks WHERE id=?", (source["track_id"],)
        ).fetchone()[0]
        records = []
        for item in targets:
            row = connection.execute(
                "SELECT t.id,t.title,t.has_cover,t.album_id,m.version,a.filename FROM tracks t JOIN track_metadata m ON m.track_id=t.id LEFT JOIN artwork_choices a ON a.track_id=t.id WHERE t.id=? AND t.library_id=? AND t.status='available'",
                (item.track_id, self.repository.library_id()),
            ).fetchone()
            if row is None or row["album_id"] != album:
                raise HTTPException(409, "album_membership_changed")
            if row["version"] != item.metadata_version:
                raise HTTPException(409, "metadata_version_conflict")
            records.append(
                {
                    "track_id": row["id"],
                    "title": row["title"],
                    "metadata_version": row["version"],
                    "has_cover": bool(row["has_cover"]),
                    "current_image_sha256": row["filename"],
                }
            )
        return targets, records

    def prepare(self, body):
        with self.database.connect() as connection:
            row = self.candidate(connection, body.suggestion_id, body.metadata_version)
        candidate_key = self.key(row)
        if body.candidate_key is not None and body.candidate_key != candidate_key:
            raise HTTPException(409, "cover_candidate_changed")
        if body.image_sha256 is None:
            if body.candidate_key is not None:
                raise HTTPException(422, "invalid_cover_snapshot")
            data, _ = self.providers.cover_data(row["cover_url"])
            image_sha256 = self.store(data)
        else:
            # Only a complete server snapshot can be reused during a draft edit.
            if body.candidate_key is None:
                raise HTTPException(422, "invalid_cover_snapshot")
            self.image(body.image_sha256)
            image_sha256 = body.image_sha256
        # Recheck after network I/O; no stale snapshot is silently made reviewable.
        with self.database.connect() as connection:
            latest = self.candidate(connection, body.suggestion_id, body.metadata_version)
            if self.key(latest) != candidate_key:
                raise HTTPException(409, "cover_candidate_changed")
            _, targets_before = self.targets(connection, body, latest)
            old = connection.execute(
                "SELECT filename FROM artwork_choices WHERE track_id=?", (row["track_id"],)
            ).fetchone()
        return {
            "suggestion_id": row["id"],
            "metadata_version": body.metadata_version,
            "image_sha256": image_sha256,
            "candidate_key": candidate_key,
            **(
                {"targets": [target.model_dump() for target in body.targets]}
                if body.targets is not None
                else {}
            ),
        }, {
            "track_id": row["track_id"],
            "title": row["title"],
            "has_cover": bool(row["has_cover"]),
            "current_image_sha256": old[0] if old else None,
            "provider": row["provider"],
            "source_url": row["source_url"],
            "match": json.loads(row["match"]),
            "fields": json.loads(row["fields"]),
            "items": targets_before,
        }

    def validate_in_transaction(self, connection, body):
        row = self.candidate(connection, body.suggestion_id, body.metadata_version)
        if self.key(row) != body.candidate_key:
            raise HTTPException(409, "cover_candidate_changed")
        self.image(body.image_sha256)
        targets, _ = self.targets(connection, body, row)
        return row, targets

    def save_in_transaction(self, connection, body):
        row, targets = self.validate_in_transaction(connection, body)
        return self.persist_in_transaction(connection, body, row, targets)

    def persist_in_transaction(self, connection, body, row, targets, metadata_changed=frozenset()):
        for target in targets:
            connection.execute(
                "INSERT INTO artwork_choices(track_id,filename,source_url,mode) VALUES (?,?,?,'chosen') "
                "ON CONFLICT(track_id) DO UPDATE SET filename=excluded.filename,source_url=excluded.source_url,"
                "mode='chosen',version=artwork_choices.version+1",
                (target.track_id, body.image_sha256, row["cover_url"]),
            )
            connection.execute("UPDATE tracks SET has_cover=1 WHERE id=?", (target.track_id,))
            if target.track_id not in metadata_changed:
                connection.execute(
                    "UPDATE track_metadata SET version=version+1 WHERE track_id=?",
                    (target.track_id,),
                )
        return {
            "track_id": row["track_id"],
            "metadata_version": body.metadata_version + 1,
            "image_sha256": body.image_sha256,
            "track_ids": [target.track_id for target in targets],
        }
