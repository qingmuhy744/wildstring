"""Separate adding a personal subscription from administering shared content."""

from typing import Annotated

from fastapi import Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field


class CatalogPolicyUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: int = Field(ge=1, strict=True)
    allow_user_subscriptions: bool = Field(strict=True)


class PodcastCatalogPolicy:
    def __init__(self, database):
        self.database = database

    def read(self, user):
        with self.database.connect() as db:
            row = db.execute("SELECT * FROM podcast_catalog_settings WHERE id=1").fetchone()
        allowed = bool(row["allow_user_subscriptions"])
        return {
            "version": row["version"],
            "allow_user_subscriptions": allowed,
            "can_add": allowed or user["profile"] in {"owner", "librarian"},
        }

    def require_add(self, user, fields):
        if not self.read(user)["can_add"]:
            raise HTTPException(403, "podcast_subscriptions_disabled")
        if user["profile"] not in {"owner", "librarian"} and fields - {"feed_url"}:
            raise HTTPException(403, "podcast_catalog_management_required")

    def routes(self, router, auth):
        @router.get("/catalog-settings")
        def read(user: Annotated[dict, Depends(auth.require_session)]):
            return self.read(user)

        @router.put("/catalog-settings", dependencies=[Depends(auth.require_client)])
        def update(body: CatalogPolicyUpdate, user: Annotated[dict, Depends(auth.require_owner)]):
            with self.database.connect(write=True) as db:
                changed = db.execute(
                    "UPDATE podcast_catalog_settings SET allow_user_subscriptions=?,"
                    "version=version+1 WHERE id=1 AND version=?",
                    (body.allow_user_subscriptions, body.version),
                ).rowcount
                if not changed:
                    raise HTTPException(409, "podcast_catalog_settings_conflict")
            return self.read(user)
