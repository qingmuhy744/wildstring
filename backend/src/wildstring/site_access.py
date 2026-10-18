"""Optional, persistent request Host allowlist, independent of forwarded headers."""

import ipaddress
import json
import re
import sqlite3
from urllib.parse import urlsplit

import anyio
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from starlette.responses import JSONResponse


def normalize_host(value: str) -> str:
    if not value or value != value.strip() or any(char in value for char in "/\\@?#%"):
        raise ValueError("Use a hostname or IP without URL, port or path")
    try:
        return ipaddress.ip_address(value).compressed
    except ValueError:
        pass
    try:
        host = value.rstrip(".").encode("idna").decode("ascii").lower()
    except UnicodeError:
        raise ValueError("Invalid hostname") from None
    if len(host) > 253 or any(
        not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label)
        for label in host.split(".")
    ):
        raise ValueError("Invalid hostname")
    return host


class AccessUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    enabled: bool
    hosts: list[str] = Field(max_length=50)
    version: int = Field(ge=1)

    @field_validator("hosts")
    @classmethod
    def valid_hosts(cls, values):
        return list(dict.fromkeys(normalize_host(value) for value in values))

    @model_validator(mode="after")
    def nonempty(self):
        if self.enabled and not self.hosts:
            raise ValueError("An enabled allowlist must contain a host")
        return self


class SiteAccess:
    def __init__(self, database):
        self.database = database

    def read(self):
        with self.database.connect() as connection:
            row = connection.execute("SELECT * FROM site_access WHERE id=1").fetchone()
        return {
            "enabled": bool(row["enabled"]),
            "hosts": json.loads(row["hosts"]),
            "version": row["version"],
        }

    def router(self, auth):
        router = APIRouter(
            prefix="/api/v1/manage/access", dependencies=[Depends(auth.require_admin)]
        )

        @router.get("")
        def read():
            return self.read()

        @router.put("", dependencies=[Depends(auth.require_client)])
        def update(body: AccessUpdate):
            with self.database.connect(write=True) as connection:
                result = connection.execute(
                    "UPDATE site_access SET enabled=?,hosts=?,version=version+1 WHERE id=1 AND version=?",
                    (body.enabled, json.dumps(body.hosts), body.version),
                )
                if result.rowcount != 1:
                    raise HTTPException(409, "settings_version_conflict")
            return self.read()

        return router


class HostAllowlist:
    def __init__(self, app, access):
        self.app, self.access = app, access

    async def __call__(self, scope, receive, send):
        # Health probes expose no account/library data and remain available after a lockout.
        if scope["type"] != "http" or scope["path"] in {"/health", "/health/ready"}:
            await self.app(scope, receive, send)
            return
        try:
            settings = await anyio.to_thread.run_sync(self.access.read)
        except (sqlite3.Error, OSError):
            await JSONResponse({"detail": "access_settings_unavailable"}, status_code=503)(
                scope, receive, send
            )
            return
        if settings["enabled"]:
            values = [value for name, value in scope["headers"] if name.lower() == b"host"]
            allowed = False
            if len(values) == 1:
                try:
                    authority = values[0].decode("ascii")
                    if (
                        any(char.isspace() for char in authority)
                        or any(char in authority for char in "/\\@?#%")
                        or authority.endswith(":")
                        or (
                            authority.startswith("[")
                            and not re.fullmatch(r"\[[0-9a-fA-F:.]+\](?::\d+)?", authority)
                        )
                        or (
                            not authority.startswith("[")
                            and ("[" in authority or "]" in authority or authority.count(":") > 1)
                        )
                    ):
                        raise ValueError("Invalid Host")
                    parsed = urlsplit("//" + authority)
                    if (
                        parsed.username is not None
                        or parsed.password is not None
                        or parsed.path
                        or parsed.query
                        or parsed.fragment
                    ):
                        raise ValueError("Invalid Host")
                    if parsed.port is not None and not 1 <= parsed.port <= 65535:
                        raise ValueError("Invalid port")
                    allowed = normalize_host(parsed.hostname or "") in settings["hosts"]
                except (ValueError, UnicodeError):
                    allowed = False
            if not allowed:
                await JSONResponse({"detail": "host_not_allowed"}, status_code=400)(
                    scope, receive, send
                )
                return

        async def private_send(message):
            if message["type"] == "http.response.start" and scope["path"].startswith("/api/v1/"):
                message = dict(message)
                message["headers"] = [
                    (key, value)
                    for key, value in message.get("headers", [])
                    if key.lower() != b"cache-control"
                ] + [(b"cache-control", b"private, no-store")]
            await send(message)

        await self.app(scope, receive, private_send)
