"""Shared account profiles and capability checks.

The legacy ``role`` column remains part of the API for compatibility. New
authorization decisions use the more explicit profile and capability names.
"""

from fastapi import HTTPException, Request

from wildstring.agent_models import SCOPES

PROFILES = ("owner", "librarian", "editor", "listener")

PROFILE_SCOPES = {
    "owner": frozenset(
        set(SCOPES)
        | {
            "library:read",
            "library:inspect",
            "library:import",
            "library:delete",
            "metadata:write",
            "lyrics:write",
            "cover:write",
            "release-lock:write",
            "tasks:read",
            "tasks:control",
            "providers:manage",
            "sources:manage",
            "users:manage",
            "settings:manage",
            "diagnostics:read",
            "personal:read",
            "personal:write",
            "agent:use",
            "web:search",
        }
    ),
    "librarian": frozenset(
        {
            "library:read",
            "library:inspect",
            "library:import",
            "library:delete",
            "metadata:write",
            "lyrics:write",
            "cover:write",
            "release-lock:write",
            "tasks:read",
            "tasks:control",
            "diagnostics:read",
            "personal:read",
            "personal:write",
            "agent:use",
            "web:search",
            "library:manage",
            "drafts:write",
            "drafts:apply",
            "tasks:write",
            "notifications:read",
        }
    ),
    "editor": frozenset(
        {
            "library:read",
            "library:inspect",
            "metadata:write",
            "lyrics:write",
            "cover:write",
            "release-lock:write",
            "tasks:read",
            "personal:read",
            "personal:write",
            "agent:use",
            "web:search",
            "drafts:write",
            "tasks:write",
            "notifications:read",
        }
    ),
    "listener": frozenset(
        {
            "library:read",
            "personal:read",
            "personal:write",
            "agent:use",
            "web:search",
            "notifications:read",
            "drafts:write",
            "drafts:apply",
        }
    ),
}


def profile_for(row_or_user) -> str:
    """Return a valid profile while reading old rows without the new column."""

    try:
        profile = row_or_user["profile"]
    except (KeyError, IndexError, TypeError):
        profile = getattr(row_or_user, "profile", None)
    if profile in PROFILES:
        return profile
    return "owner" if row_or_user["role"] == "admin" else "listener"


def scopes_for(row_or_user) -> frozenset[str]:
    return PROFILE_SCOPES[profile_for(row_or_user)]


def require_scope(user: dict, scope: str) -> dict:
    if scope not in PROFILE_SCOPES[profile_for(user)]:
        raise HTTPException(403, "permission_required")
    return user


def require_owner(user: dict) -> dict:
    if profile_for(user) != "owner":
        raise HTTPException(403, "owner_required")
    return user


def dependency(auth, scope: str):
    def check(request: Request) -> dict:
        return require_scope(auth.require_session(request), scope)

    return check
