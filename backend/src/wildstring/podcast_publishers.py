"""Manually confirmed, server-wide podcast publisher identities."""

import sqlite3
import unicodedata
from typing import Self
from uuid import uuid4

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from wildstring.database import Database


def migrate(connection: sqlite3.Connection) -> None:
    connection.execute("BEGIN IMMEDIATE")
    connection.execute("""CREATE TABLE IF NOT EXISTS podcast_publishers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        name_key TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )""")
    columns = {row[1] for row in connection.execute("PRAGMA table_info(podcasts)")}
    if "publisher_id" not in columns:
        connection.execute(
            "ALTER TABLE podcasts ADD COLUMN publisher_id TEXT "
            "REFERENCES podcast_publishers(id) ON DELETE SET NULL"
        )
    if "publisher_version" not in columns:
        connection.execute(
            "ALTER TABLE podcasts ADD COLUMN publisher_version INTEGER NOT NULL DEFAULT 1"
        )
    connection.execute("CREATE INDEX IF NOT EXISTS podcasts_by_publisher ON podcasts(publisher_id)")
    connection.execute("PRAGMA user_version = 35")
    connection.commit()


class PublisherRef(BaseModel):
    id: str
    name: str


class PublisherSummary(PublisherRef):
    podcast_count: int


class PublisherAssignment(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: int = Field(ge=1, strict=True)
    publisher_id: str | None = Field(default=None, min_length=1, max_length=64)
    name: str | None = Field(default=None, min_length=1, max_length=120)

    @field_validator("name")
    @classmethod
    def clean_name(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = " ".join(unicodedata.normalize("NFC", value).split())
        if not value or any(unicodedata.category(char).startswith("C") for char in value):
            raise ValueError("invalid publisher name")
        return value

    @model_validator(mode="after")
    def exclusive_selection(self) -> Self:
        if self.name is not None and self.publisher_id is not None:
            raise ValueError("choose publisher_id or name")
        return self


def publisher_fields(row: sqlite3.Row) -> dict:
    return {
        "publisher": {"id": row["publisher_id"], "name": row["publisher_name"]}
        if row["publisher_id"] is not None
        else None,
        "publisher_version": row["publisher_version"],
    }


class PodcastPublishers:
    def __init__(self, database: Database):
        self.database = database

    def list(self) -> list[dict]:
        with self.database.connect() as connection:
            return [
                dict(row)
                for row in connection.execute(
                    "SELECT pub.id, pub.name, COUNT(p.id) AS podcast_count "
                    "FROM podcast_publishers pub JOIN podcasts p ON p.publisher_id=pub.id "
                    "GROUP BY pub.id ORDER BY pub.name COLLATE NOCASE, pub.id"
                )
            ]

    def get(self, publisher_id: str) -> dict:
        with self.database.connect() as connection:
            row = connection.execute(
                "SELECT pub.id, pub.name, COUNT(p.id) AS podcast_count "
                "FROM podcast_publishers pub LEFT JOIN podcasts p ON p.publisher_id=pub.id "
                "WHERE pub.id=? GROUP BY pub.id",
                (publisher_id,),
            ).fetchone()
            if row is None:
                raise HTTPException(404, "出品方未找到")
            return dict(row)

    def assign(self, podcast_id: str, value: PublisherAssignment) -> None:
        with self.database.connect(write=True) as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                "SELECT publisher_version FROM podcasts WHERE id=?", (podcast_id,)
            ).fetchone()
            if row is None:
                raise HTTPException(404, "播客未找到")
            if row["publisher_version"] != value.version:
                raise HTTPException(409, "出品方归属已被修改，请重新打开后再试。")
            publisher_id = value.publisher_id
            if publisher_id is not None:
                if (
                    connection.execute(
                        "SELECT 1 FROM podcast_publishers WHERE id=?", (publisher_id,)
                    ).fetchone()
                    is None
                ):
                    raise HTTPException(404, "出品方未找到")
            elif value.name is not None:
                name_key = unicodedata.normalize("NFKC", value.name).casefold()
                existing = connection.execute(
                    "SELECT id FROM podcast_publishers WHERE name_key=?", (name_key,)
                ).fetchone()
                publisher_id = existing["id"] if existing else str(uuid4())
                if existing is None:
                    connection.execute(
                        "INSERT INTO podcast_publishers(id,name,name_key) VALUES (?,?,?)",
                        (publisher_id, value.name, name_key),
                    )
            connection.execute(
                "UPDATE podcasts SET publisher_id=?, publisher_version=publisher_version+1 "
                "WHERE id=?",
                (publisher_id, podcast_id),
            )
