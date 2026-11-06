"""Persistent server identity and explicit, per-field environment overrides."""

import sqlite3
import uuid
from typing import Literal

import anyio
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator
from starlette.responses import JSONResponse


def migrate(connection):
    connection.execute(
        "CREATE TABLE IF NOT EXISTS server_settings ("
        "id INTEGER PRIMARY KEY CHECK(id=1), instance_id TEXT NOT NULL, "
        "name TEXT, connection_policy TEXT)"
    )
    connection.execute(
        "INSERT OR IGNORE INTO server_settings(id,instance_id) VALUES(1,?)", (str(uuid.uuid4()),)
    )
    columns = {row[1] for row in connection.execute("PRAGMA table_info(sessions)")}
    if "transport" not in columns:
        connection.execute("ALTER TABLE sessions ADD COLUMN transport TEXT NOT NULL DEFAULT ''")
    connection.execute("PRAGMA user_version = 48")
    # initialize() enables WAL immediately afterward, outside a transaction.
    connection.commit()


class ServerUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    name: str | None = Field(default=None, min_length=1, max_length=80)
    connection_policy: Literal["mixed", "https_only"] | None = None

    @field_validator("name", mode="before")
    @classmethod
    def trim_name(cls, value):
        return value.strip() if isinstance(value, str) else value


class ServerSettings:
    def __init__(self, database, settings):
        self.database, self.settings = database, settings

    def read(self):
        with self.database.connect() as connection:
            row = connection.execute("SELECT * FROM server_settings WHERE id=1").fetchone()
        values = {"instance_id": row["instance_id"], "sources": {}}
        for key, default in (("name", "野弦"), ("connection_policy", "legacy")):
            environment = getattr(self.settings, "server_name" if key == "name" else key)
            if row[key] is not None:
                values[key], values["sources"][key] = row[key], "database"
            elif environment is not None:
                effective = ServerUpdate.model_validate({key: environment})
                values[key], values["sources"][key] = getattr(effective, key), "environment"
            else:
                values[key], values["sources"][key] = default, "default"
        return values

    def public(self):
        return {key: value for key, value in self.read().items() if key != "sources"}

    def router(self, auth):
        router = APIRouter()

        @router.get("/api/v1/server")
        def public():
            return self.public()

        @router.get("/api/v1/manage/server", dependencies=[Depends(auth.require_owner)])
        def read():
            return self.read()

        @router.patch(
            "/api/v1/manage/server",
            dependencies=[Depends(auth.require_owner), Depends(auth.require_client)],
        )
        def update(body: ServerUpdate):
            changes = body.model_dump(exclude_unset=True)
            # Validate inheritance before clearing a working DB override.
            for key, value in changes.items():
                if value is None:
                    fallback = getattr(self.settings, "server_name" if key == "name" else key)
                    if fallback is not None:
                        try:
                            ServerUpdate.model_validate({key: fallback})
                        except ValidationError:
                            raise HTTPException(422, "environment_setting_invalid") from None
            with self.database.connect(write=True) as connection:
                connection.execute("BEGIN IMMEDIATE")
                previous = connection.execute(
                    "SELECT connection_policy FROM server_settings WHERE id=1"
                ).fetchone()[0]
                if "connection_policy" in changes and previous != changes["connection_policy"]:
                    # Revoking HTTP/legacy sessions is permanent, including after reverting
                    # to mixed. HTTPS sessions stay usable with the new policy.
                    connection.execute("DELETE FROM sessions WHERE transport!='https'")
                for key, value in changes.items():
                    statement = (
                        "UPDATE server_settings SET name=? WHERE id=1"
                        if key == "name"
                        else "UPDATE server_settings SET connection_policy=? WHERE id=1"
                    )
                    connection.execute(statement, (value,))
            return self.read()

        return router


class ConnectionSecurity:
    """Enforce policy for cookie APIs and Bearer MCP, before either authenticates."""

    def __init__(self, app, server_settings):
        self.app, self.server_settings = app, server_settings

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or not (
            scope["path"].startswith("/api/v1/") or scope["path"].rstrip("/") == "/mcp"
        ):
            await self.app(scope, receive, send)
            return
        try:
            settings = await anyio.to_thread.run_sync(self.server_settings.read)
        except (sqlite3.Error, OSError):
            await JSONResponse({"detail": "server_settings_unavailable"}, status_code=503)(
                scope, receive, send
            )
            return
        scope.setdefault("state", {})["connection_policy"] = settings["connection_policy"]
        if (
            settings["connection_policy"] == "https_only"
            and scope["scheme"] != "https"
            and scope["path"] != "/api/v1/server"
        ):
            await JSONResponse({"detail": "https_required"}, status_code=403)(scope, receive, send)
            return
        await self.app(scope, receive, send)
