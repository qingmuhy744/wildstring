"""OAuth 2.1 authorization server & RFC 9728 metadata layered over MCP credentials.

Keeps WildString's existing static PAT (`ws_...`) flow intact while adding browser-based
OAuth 2.1 (Authorization Code + mandatory PKCE S256, RFC 9728, RFC 8414, RFC 7591 DCR,
RFC 8707 resource indicators, rotating refresh tokens, and RFC 7009 revocation).
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re
import secrets
import sqlite3
import threading
import time
from collections import deque
from typing import Literal
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from wildstring.agent_common import digest, encoded, future
from wildstring.agent_models import SCOPES
from wildstring.library.repository import now
from wildstring.permissions import profile_for, scopes_for

AUTH_CODE_TTL_SECONDS = 60
ACCESS_TOKEN_TTL_SECONDS = 3600
REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60
MAX_REDIRECT_URIS = 16
MAX_UNGRANTED_DYNAMIC_CLIENTS = 500
DYNAMIC_CLIENT_IDLE_TTL_SECONDS = 24 * 60 * 60
DCR_RATE_LIMIT_WINDOW_SECONDS = 3600
DCR_RATE_LIMIT_MAX_PER_IP = 30
PKCE_VERIFIER_RE = re.compile(r"^[A-Za-z0-9._~-]{43,128}$")
PKCE_CHALLENGE_RE = re.compile(r"^[A-Za-z0-9_-]{43,128}$")
LOOPBACK_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})
AUTH_METHODS = ("none", "client_secret_post", "client_secret_basic")
ADMIN_ONLY_SCOPES = frozenset({"diagnostics:read", "library:manage"})
DEFAULT_READ_SCOPES = ("library:read", "personal:read")


def _normalized_authority(scheme: str, netloc: str) -> str:
    lowered = netloc.strip().lower()
    if scheme == "http" and lowered.endswith(":80"):
        return lowered[:-3]
    if scheme == "https" and lowered.endswith(":443"):
        return lowered[:-4]
    return lowered


def server_origin(request: Request) -> str:
    scheme = (request.url.scheme or "http").lower()
    netloc = _normalized_authority(scheme, request.url.netloc)
    root_path = (request.scope.get("root_path") or "").rstrip("/")
    return f"{scheme}://{netloc}{root_path}"


def mcp_resource_uri(request: Request) -> str:
    return f"{server_origin(request)}/mcp"


def protected_resource_metadata_url(request: Request) -> str:
    return f"{server_origin(request)}/.well-known/oauth-protected-resource/mcp"


def normalize_resource(value: str | None) -> str | None:
    if value is None:
        return None
    stripped = value.strip()
    if not stripped:
        return None
    if len(stripped) > 2048 or any(ord(c) < 32 for c in stripped):
        raise ValueError("invalid_resource")
    parts = urlsplit(stripped)
    if (
        parts.scheme.lower() not in {"http", "https"}
        or not parts.hostname
        or parts.username is not None
        or parts.password is not None
        or parts.query
        or parts.fragment
    ):
        raise ValueError("invalid_resource")
    scheme = parts.scheme.lower()
    netloc = _normalized_authority(scheme, parts.netloc)
    path = parts.path.rstrip("/")
    return f"{scheme}://{netloc}{path}"


def resource_matches(request: Request, resource: str | None) -> str | None:
    normalized = normalize_resource(resource)
    if normalized is None:
        return None
    expected_origin = server_origin(request)
    expected_mcp = f"{expected_origin}/mcp"
    if normalized not in {expected_origin, expected_mcp}:
        raise ValueError("resource_mismatch")
    return normalized


def validate_redirect_uri(uri: str) -> str:
    if not isinstance(uri, str):
        raise ValueError("invalid_redirect_uri")
    cleaned = uri.strip()
    if not cleaned or len(cleaned) > 2048 or any(ord(c) < 32 for c in cleaned):
        raise ValueError("invalid_redirect_uri")
    parts = urlsplit(cleaned)
    scheme = parts.scheme.lower()
    host = (parts.hostname or "").lower()
    if not host or parts.username is not None or parts.password is not None or parts.fragment:
        raise ValueError("invalid_redirect_uri")
    if scheme == "https":
        return cleaned
    if scheme == "http" and host in LOOPBACK_HOSTS:
        return cleaned
    raise ValueError("invalid_redirect_uri")


def _loopback_equivalent(registered: str, candidate: str) -> bool:
    reg = urlsplit(registered)
    cand = urlsplit(candidate)
    if reg.scheme.lower() != "http" or cand.scheme.lower() != "http":
        return False
    reg_host = (reg.hostname or "").lower()
    cand_host = (cand.hostname or "").lower()
    if reg_host not in LOOPBACK_HOSTS or reg_host != cand_host:
        return False
    return reg.path == cand.path and reg.query == cand.query


def redirect_uri_matches(registered_uris: list[str], candidate: str) -> bool:
    try:
        cleaned = validate_redirect_uri(candidate)
    except ValueError:
        return False
    for registered in registered_uris:
        if cleaned == registered or _loopback_equivalent(registered, cleaned):
            return True
    return False


def pkce_s256(verifier: str) -> str:
    raw = hashlib.sha256(verifier.encode("ascii")).digest()
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def append_query(url: str, params: dict[str, str]) -> str:
    parts = urlsplit(url)
    existing = parse_qsl(parts.query, keep_blank_values=True)
    merged = existing + [(k, v) for k, v in params.items() if v is not None]
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(merged), ""))


def allowed_scopes_for_user(user: dict) -> list[str]:
    profile = profile_for(user)
    permitted = scopes_for(user)
    return [
        scope
        for scope in SCOPES
        if scope in permitted and (profile == "owner" or scope not in ADMIN_ONLY_SCOPES)
    ]


def parse_scope_string(raw: str | None) -> list[str]:
    if not raw or not raw.strip():
        return []
    tokens = raw.strip().split()
    unknown = [token for token in tokens if token not in SCOPES]
    if unknown:
        raise ValueError("invalid_scope")
    return list(dict.fromkeys(tokens))


def oauth_error(
    error: str, description: str, status_code: int = 400, *, headers: dict[str, str] | None = None
) -> JSONResponse:
    base_headers = {"Cache-Control": "no-store", "Pragma": "no-cache"}
    if headers:
        base_headers.update(headers)
    return JSONResponse(
        {"error": error, "error_description": description},
        status_code=status_code,
        headers=base_headers,
    )


class DynamicClientRegistration(BaseModel):
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)
    client_name: str = Field(default="MCP Client", min_length=1, max_length=100)
    redirect_uris: list[str] = Field(min_length=1, max_length=MAX_REDIRECT_URIS)
    grant_types: list[str] = Field(default_factory=lambda: ["authorization_code", "refresh_token"])
    response_types: list[str] = Field(default_factory=lambda: ["code"])
    token_endpoint_auth_method: Literal["none", "client_secret_post", "client_secret_basic"] = (
        "none"
    )
    scope: str | None = Field(default=None, max_length=512)

    @field_validator("redirect_uris")
    @classmethod
    def check_redirect_uris(cls, values: list[str]) -> list[str]:
        return list(dict.fromkeys(validate_redirect_uri(item) for item in values))

    @field_validator("grant_types")
    @classmethod
    def check_grant_types(cls, values: list[str]) -> list[str]:
        allowed = {"authorization_code", "refresh_token"}
        unique = list(dict.fromkeys(values))
        if "authorization_code" not in unique or set(unique) - allowed:
            raise ValueError("unsupported_grant_type")
        return unique

    @field_validator("response_types")
    @classmethod
    def check_response_types(cls, values: list[str]) -> list[str]:
        if list(dict.fromkeys(values)) != ["code"]:
            raise ValueError("unsupported_response_type")
        return ["code"]


class ManualClientCreate(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    name: str = Field(min_length=1, max_length=100)
    redirect_uris: list[str] = Field(min_length=1, max_length=MAX_REDIRECT_URIS)
    token_endpoint_auth_method: Literal["none", "client_secret_post", "client_secret_basic"] = (
        "client_secret_post"
    )

    @field_validator("redirect_uris")
    @classmethod
    def check_redirect_uris(cls, values: list[str]) -> list[str]:
        return list(dict.fromkeys(validate_redirect_uri(item) for item in values))


class AuthorizeContextRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    client_id: str = Field(default="", max_length=128)
    redirect_uri: str = Field(default="", max_length=2048)
    response_type: str = Field(default="", max_length=64)
    code_challenge: str = Field(default="", max_length=128)
    code_challenge_method: str = Field(default="", max_length=32)
    scope: str | None = Field(default=None, max_length=512)
    state: str | None = Field(default=None, max_length=512)
    resource: str | None = Field(default=None, max_length=2048)


class AuthorizeDecision(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    decision: Literal["approve", "deny"]
    client_id: str = Field(min_length=1, max_length=128)
    redirect_uri: str = Field(min_length=1, max_length=2048)
    code_challenge: str = Field(min_length=43, max_length=128)
    code_challenge_method: Literal["S256"] = "S256"
    scopes: list[str] = Field(default_factory=list, max_length=len(SCOPES))
    state: str | None = Field(default=None, max_length=512)
    resource: str | None = Field(default=None, max_length=2048)


class MCPOAuth:
    def __init__(self, database, auth, platform, server_settings):
        self.database = database
        self.auth = auth
        self.platform = platform
        self.server_settings = server_settings
        self._dcr_lock = threading.Lock()
        self._dcr_hits: dict[str, deque[float]] = {}

    def _check_dcr_rate_limit(self, client_host: str | None) -> bool:
        key = client_host or "unknown"
        ts = time.monotonic()
        cutoff = ts - DCR_RATE_LIMIT_WINDOW_SECONDS
        with self._dcr_lock:
            if len(self._dcr_hits) > 2048:
                stale = [
                    host
                    for host, bucket in self._dcr_hits.items()
                    if not bucket or bucket[-1] < cutoff
                ]
                for host in stale:
                    self._dcr_hits.pop(host, None)
            bucket = self._dcr_hits.setdefault(key, deque())
            while bucket and bucket[0] < cutoff:
                bucket.popleft()
            if len(bucket) >= DCR_RATE_LIMIT_MAX_PER_IP:
                return False
            bucket.append(ts)
            return True

    def _prune_ephemeral(self, connection: sqlite3.Connection) -> None:
        current = now()
        connection.execute(
            "DELETE FROM oauth_codes WHERE expires_at <= ? AND used_at IS NULL", (current,)
        )
        connection.execute(
            "DELETE FROM oauth_codes WHERE created_at <= ?",
            (future(-24 * 60 * 60),),
        )
        stale_cutoff = future(-DYNAMIC_CLIENT_IDLE_TTL_SECONDS)
        connection.execute(
            "DELETE FROM oauth_clients WHERE registration_source='dynamic' "
            "AND created_at <= ? "
            "AND NOT EXISTS (SELECT 1 FROM oauth_grants g WHERE g.client_id=oauth_clients.client_id)",
            (stale_cutoff,),
        )

    def _revoke_grant(self, connection: sqlite3.Connection, grant_id: str) -> None:
        ts = now()
        connection.execute(
            "UPDATE oauth_grants SET revoked_at=COALESCE(revoked_at, ?) WHERE id=?",
            (ts, grant_id),
        )
        connection.execute(
            "UPDATE oauth_refresh_tokens SET revoked_at=COALESCE(revoked_at, ?) WHERE grant_id=?",
            (ts, grant_id),
        )
        connection.execute(
            "UPDATE agent_credentials SET revoked_at=COALESCE(revoked_at, ?), version=version+1 "
            "WHERE oauth_grant_id=? AND revoked_at IS NULL",
            (ts, grant_id),
        )

    def _insert_client(
        self,
        connection: sqlite3.Connection,
        *,
        name: str,
        redirect_uris: list[str],
        auth_method: str,
        source: Literal["dynamic", "manual"],
        owner_user_id: str | None,
    ) -> dict:
        client_id = "wsa_" + secrets.token_urlsafe(24)
        client_secret = "wss_" + secrets.token_urlsafe(32) if auth_method != "none" else None
        created_at = now()
        connection.execute(
            "INSERT INTO oauth_clients("
            "client_id, client_secret_hash, name, redirect_uris, "
            "token_endpoint_auth_method, registration_source, owner_user_id, created_at"
            ") VALUES (?,?,?,?,?,?,?,?)",
            (
                client_id,
                digest(client_secret) if client_secret else None,
                name,
                encoded(redirect_uris),
                auth_method,
                source,
                owner_user_id,
                created_at,
            ),
        )
        result = {
            "client_id": client_id,
            "name": name,
            "redirect_uris": redirect_uris,
            "token_endpoint_auth_method": auth_method,
            "registration_source": source,
            "created_at": created_at,
        }
        if client_secret is not None:
            result["client_secret"] = client_secret
        return result

    @staticmethod
    async def _read_form_or_json(request: Request) -> dict[str, str]:
        content_type = (request.headers.get("content-type") or "").split(";")[0].strip().lower()
        body = await request.body()
        if len(body) > 64 * 1024:
            raise HTTPException(413, "oauth_request_too_large")
        if content_type == "application/json":
            try:
                parsed = json.loads(body or b"{}")
            except ValueError:
                return {}
            if not isinstance(parsed, dict):
                return {}
            return {str(k): str(v) for k, v in parsed.items() if v is not None}
        return dict(parse_qsl(body.decode("utf-8", errors="replace"), keep_blank_values=True))

    def _authenticate_client(
        self, connection: sqlite3.Connection, request: Request, form: dict[str, str]
    ) -> tuple[sqlite3.Row | None, JSONResponse | None]:
        auth_header = request.headers.get("authorization", "")
        basic_id: str | None = None
        basic_secret: str | None = None
        if auth_header:
            scheme, _, value = auth_header.partition(" ")
            if scheme.lower() != "basic" or not value:
                return None, oauth_error(
                    "invalid_client",
                    "Unsupported authorization scheme",
                    401,
                    headers={"WWW-Authenticate": 'Basic realm="WildString OAuth"'},
                )
            try:
                decoded = base64.b64decode(value.encode("ascii"), validate=True).decode("utf-8")
            except (ValueError, UnicodeDecodeError):
                return None, oauth_error(
                    "invalid_client",
                    "Malformed Basic credentials",
                    401,
                    headers={"WWW-Authenticate": 'Basic realm="WildString OAuth"'},
                )
            if ":" not in decoded:
                return None, oauth_error(
                    "invalid_client",
                    "Malformed Basic credentials",
                    401,
                    headers={"WWW-Authenticate": 'Basic realm="WildString OAuth"'},
                )
            basic_id, basic_secret = decoded.split(":", 1)

        post_id = form.get("client_id")
        post_secret = form.get("client_secret")
        if basic_id is not None and (post_id is not None or post_secret is not None):
            return None, oauth_error(
                "invalid_request", "Client must not use multiple authentication methods", 400
            )
        client_id = basic_id if basic_id is not None else post_id
        provided_secret = basic_secret if basic_id is not None else post_secret
        if not client_id:
            return None, oauth_error("invalid_client", "Missing client_id", 401)
        row = connection.execute(
            "SELECT * FROM oauth_clients WHERE client_id=?", (client_id,)
        ).fetchone()
        if row is None:
            return None, oauth_error("invalid_client", "Unknown OAuth client", 401)
        method = row["token_endpoint_auth_method"]
        if method == "none":
            if provided_secret:
                return None, oauth_error(
                    "invalid_client", "Public client does not use a secret", 401
                )
            return row, None
        # Accept both HTTP Basic and form-post for confidential clients so connectors like
        # Gemini/Claude work seamlessly regardless of which confidential method they send,
        # while always requiring a valid matching client_secret.
        if not provided_secret or not row["client_secret_hash"]:
            return None, oauth_error(
                "invalid_client",
                "Client authentication required",
                401,
                headers={"WWW-Authenticate": 'Basic realm="WildString OAuth"'}
                if method == "client_secret_basic"
                else None,
            )
        if not hmac.compare_digest(digest(provided_secret), row["client_secret_hash"]):
            return None, oauth_error("invalid_client", "Invalid client credentials", 401)
        return row, None

    def _validate_authorize_request(
        self,
        connection: sqlite3.Connection,
        request: Request,
        user: dict,
        *,
        client_id: str,
        redirect_uri: str,
        response_type: str,
        code_challenge: str,
        code_challenge_method: str,
        scope_param: str | None,
        state: str | None,
        resource_param: str | None,
    ) -> dict:
        if response_type != "code":
            raise HTTPException(400, "oauth_unsupported_response_type")
        if code_challenge_method != "S256" or not PKCE_CHALLENGE_RE.fullmatch(code_challenge or ""):
            raise HTTPException(400, "oauth_pkce_required")
        client = connection.execute(
            "SELECT * FROM oauth_clients WHERE client_id=?", (client_id,)
        ).fetchone()
        if client is None:
            raise HTTPException(400, "oauth_unknown_client")
        registered_uris = json.loads(client["redirect_uris"])
        if not redirect_uri_matches(registered_uris, redirect_uri):
            raise HTTPException(400, "oauth_redirect_uri_mismatch")
        try:
            normalized_resource = resource_matches(request, resource_param)
        except ValueError:
            raise HTTPException(400, "oauth_invalid_resource") from None
        try:
            requested_scopes = parse_scope_string(scope_param)
        except ValueError:
            raise HTTPException(400, "oauth_invalid_scope") from None
        allowed = allowed_scopes_for_user(user)
        allowed_set = set(allowed)
        if requested_scopes:
            effective_default = [scope for scope in requested_scopes if scope in allowed_set]
        else:
            effective_default = [scope for scope in DEFAULT_READ_SCOPES if scope in allowed_set]
        if not effective_default and allowed:
            effective_default = [allowed[0]]
        parsed_redirect = urlsplit(redirect_uri)
        return {
            "client": {
                "client_id": client["client_id"],
                "name": client["name"],
                "registration_source": client["registration_source"],
            },
            "redirect_uri": redirect_uri.strip(),
            "redirect_host": parsed_redirect.netloc,
            "state": state,
            "resource": normalized_resource,
            "requested_scopes": requested_scopes,
            "allowed_scopes": allowed,
            "default_scopes": effective_default,
            "user": {
                "id": user["id"],
                "username": user["username"],
                "profile": user["profile"],
            },
        }

    def _issue_access_credential(
        self,
        connection: sqlite3.Connection,
        *,
        user_id: str,
        client_name: str,
        scopes: list[str],
        grant_id: str,
    ) -> tuple[str, str]:
        cred_id = uuid4().hex
        access_token = "ws_" + secrets.token_urlsafe(32)
        created = now()
        expires = future(ACCESS_TOKEN_TTL_SECONDS)
        connection.execute(
            "INSERT INTO agent_credentials("
            "id, user_id, name, token_hash, scopes, created_at, expires_at, oauth_grant_id"
            ") VALUES (?,?,?,?,?,?,?,?)",
            (
                cred_id,
                user_id,
                f"OAuth · {client_name}"[:100],
                digest(access_token),
                encoded(scopes),
                created,
                expires,
                grant_id,
            ),
        )
        return cred_id, access_token

    def router(self) -> APIRouter:
        router = APIRouter(tags=["oauth"])

        @router.get(
            "/.well-known/oauth-protected-resource", operation_id="oauth_protected_resource"
        )
        @router.get(
            "/.well-known/oauth-protected-resource/mcp",
            operation_id="oauth_protected_resource_mcp",
        )
        def protected_resource_metadata(request: Request, response: Response):
            response.headers["Cache-Control"] = "public, max-age=300"
            origin = server_origin(request)
            name = self.server_settings.public()["name"]
            return {
                "resource": f"{origin}/mcp",
                "authorization_servers": [origin],
                "bearer_methods_supported": ["header"],
                "scopes_supported": list(SCOPES),
                "resource_name": f"{name} MCP",
            }

        @router.get(
            "/.well-known/oauth-authorization-server",
            operation_id="oauth_authorization_server_metadata",
        )
        def authorization_server_metadata(request: Request, response: Response):
            response.headers["Cache-Control"] = "public, max-age=300"
            origin = server_origin(request)
            return {
                "issuer": origin,
                "authorization_endpoint": f"{origin}/oauth/authorize",
                "token_endpoint": f"{origin}/oauth/token",
                "registration_endpoint": f"{origin}/oauth/register",
                "revocation_endpoint": f"{origin}/oauth/revoke",
                "response_types_supported": ["code"],
                "response_modes_supported": ["query"],
                "grant_types_supported": ["authorization_code", "refresh_token"],
                "token_endpoint_auth_methods_supported": list(AUTH_METHODS),
                "revocation_endpoint_auth_methods_supported": list(AUTH_METHODS),
                "code_challenge_methods_supported": ["S256"],
                "scopes_supported": list(SCOPES),
                "client_id_metadata_document_supported": False,
            }

        @router.post("/oauth/register", status_code=201, operation_id="oauth_dynamic_register")
        async def dynamic_register(request: Request):
            if not self._check_dcr_rate_limit(request.client.host if request.client else None):
                return oauth_error(
                    "invalid_client_metadata",
                    "Too many client registrations from this address",
                    429,
                    headers={"Retry-After": "300"},
                )
            raw = await request.body()
            if len(raw) > 32 * 1024:
                return oauth_error("invalid_client_metadata", "Registration payload too large", 413)
            try:
                payload = DynamicClientRegistration.model_validate(json.loads(raw or b"{}"))
            except (ValueError, ValidationError):
                return oauth_error(
                    "invalid_client_metadata",
                    "Invalid client registration metadata or redirect_uris",
                    400,
                )
            with self.database.connect(write=True) as connection:
                connection.execute("BEGIN IMMEDIATE")
                self._prune_ephemeral(connection)
                count = connection.execute(
                    "SELECT COUNT(*) FROM oauth_clients WHERE registration_source='dynamic' "
                    "AND NOT EXISTS (SELECT 1 FROM oauth_grants g WHERE g.client_id=oauth_clients.client_id)"
                ).fetchone()[0]
                if count >= MAX_UNGRANTED_DYNAMIC_CLIENTS:
                    return oauth_error(
                        "server_error",
                        "Dynamic client registration capacity reached",
                        503,
                    )
                created = self._insert_client(
                    connection,
                    name=payload.client_name,
                    redirect_uris=payload.redirect_uris,
                    auth_method=payload.token_endpoint_auth_method,
                    source="dynamic",
                    owner_user_id=None,
                )
            response_body = {
                "client_id": created["client_id"],
                "client_id_issued_at": int(time.time()),
                "client_name": created["name"],
                "redirect_uris": created["redirect_uris"],
                "grant_types": payload.grant_types,
                "response_types": payload.response_types,
                "token_endpoint_auth_method": created["token_endpoint_auth_method"],
            }
            if "client_secret" in created:
                response_body["client_secret"] = created["client_secret"]
                response_body["client_secret_expires_at"] = 0
            return JSONResponse(
                response_body,
                status_code=201,
                headers={"Cache-Control": "no-store", "Pragma": "no-cache"},
            )

        @router.post("/oauth/token", operation_id="oauth_token_exchange")
        async def token_endpoint(request: Request):
            form = await self._read_form_or_json(request)
            grant_type = form.get("grant_type", "")
            if grant_type not in {"authorization_code", "refresh_token"}:
                return oauth_error(
                    "unsupported_grant_type",
                    "Only authorization_code and refresh_token are supported",
                    400,
                )
            with self.database.connect(write=True) as connection:
                connection.execute("BEGIN IMMEDIATE")
                self._prune_ephemeral(connection)
                client, error_response = self._authenticate_client(connection, request, form)
                if error_response is not None or client is None:
                    return error_response

                if grant_type == "authorization_code":
                    return self._exchange_code(connection, request, client, form)
                return self._exchange_refresh(connection, request, client, form)

        @router.post("/oauth/revoke", operation_id="oauth_token_revoke")
        async def revoke_endpoint(request: Request):
            form = await self._read_form_or_json(request)
            token_value = form.get("token", "")
            with self.database.connect(write=True) as connection:
                connection.execute("BEGIN IMMEDIATE")
                client, error_response = self._authenticate_client(connection, request, form)
                if error_response is not None or client is None:
                    return error_response
                if token_value:
                    hashed = digest(token_value)
                    refresh_row = connection.execute(
                        "SELECT r.grant_id FROM oauth_refresh_tokens r "
                        "JOIN oauth_grants g ON g.id = r.grant_id "
                        "WHERE r.token_hash=? AND g.client_id=?",
                        (hashed, client["client_id"]),
                    ).fetchone()
                    if refresh_row is not None:
                        self._revoke_grant(connection, refresh_row["grant_id"])
                    else:
                        cred_row = connection.execute(
                            "SELECT c.id FROM agent_credentials c "
                            "JOIN oauth_grants g ON g.id = c.oauth_grant_id "
                            "WHERE c.token_hash=? AND g.client_id=?",
                            (hashed, client["client_id"]),
                        ).fetchone()
                        if cred_row is not None:
                            connection.execute(
                                "UPDATE agent_credentials SET revoked_at=COALESCE(revoked_at, ?), "
                                "version=version+1 WHERE id=?",
                                (now(), cred_row["id"]),
                            )
            return JSONResponse(
                {},
                status_code=200,
                headers={"Cache-Control": "no-store", "Pragma": "no-cache"},
            )

        @router.post(
            "/api/v1/oauth/authorize/context",
            dependencies=[Depends(self.auth.require_client)],
            operation_id="oauth_authorize_context",
        )
        def authorize_context(request: Request, body: AuthorizeContextRequest):
            user = self.auth.require_session(request)
            with self.database.connect(scoped=False) as connection:
                return self._validate_authorize_request(
                    connection,
                    request,
                    user,
                    client_id=body.client_id,
                    redirect_uri=body.redirect_uri,
                    response_type=body.response_type,
                    code_challenge=body.code_challenge,
                    code_challenge_method=body.code_challenge_method,
                    scope_param=body.scope,
                    state=body.state,
                    resource_param=body.resource,
                )

        @router.post(
            "/api/v1/oauth/authorize/decision",
            dependencies=[Depends(self.auth.require_client)],
            operation_id="oauth_authorize_decision",
        )
        def authorize_decision(request: Request, body: AuthorizeDecision):
            user = self.auth.require_session(request)
            with self.database.connect(write=True) as connection:
                connection.execute("BEGIN IMMEDIATE")
                self._prune_ephemeral(connection)
                context = self._validate_authorize_request(
                    connection,
                    request,
                    user,
                    client_id=body.client_id,
                    redirect_uri=body.redirect_uri,
                    response_type="code",
                    code_challenge=body.code_challenge,
                    code_challenge_method=body.code_challenge_method,
                    scope_param=None,
                    state=body.state,
                    resource_param=body.resource,
                )
                if body.decision == "deny":
                    params = {"error": "access_denied"}
                    if body.state is not None:
                        params["state"] = body.state
                    return {"redirect_to": append_query(context["redirect_uri"], params)}
                allowed_set = set(context["allowed_scopes"])
                approved_scopes = list(dict.fromkeys(body.scopes))
                if not approved_scopes or set(approved_scopes) - allowed_set:
                    raise HTTPException(422, "oauth_invalid_scope")
                raw_code = "wsc_" + secrets.token_urlsafe(32)
                connection.execute(
                    "INSERT INTO oauth_codes("
                    "code_hash, client_id, user_id, redirect_uri, scopes, "
                    "code_challenge, code_challenge_method, resource, created_at, expires_at"
                    ") VALUES (?,?,?,?,?,?,?,?,?,?)",
                    (
                        digest(raw_code),
                        context["client"]["client_id"],
                        user["id"],
                        context["redirect_uri"],
                        encoded(approved_scopes),
                        body.code_challenge,
                        body.code_challenge_method,
                        context["resource"],
                        now(),
                        future(AUTH_CODE_TTL_SECONDS),
                    ),
                )
            actor = self.platform.current_actor(user["id"])
            self.platform.log(
                "agent.oauth.authorized",
                actor,
                client_id=context["client"]["client_id"],
                scopes=approved_scopes,
            )
            params = {"code": raw_code}
            if body.state is not None:
                params["state"] = body.state
            return {"redirect_to": append_query(context["redirect_uri"], params)}

        @router.get("/api/v1/oauth/grants", operation_id="oauth_list_grants")
        def list_grants(request: Request):
            user = self.auth.require_session(request)
            with self.database.connect(scoped=False) as connection:
                rows = connection.execute(
                    "SELECT g.id, g.client_id, c.name AS client_name, c.registration_source, "
                    "g.scopes, g.created_at, g.last_used_at, g.revoked_at, "
                    "cred.expires_at AS access_expires_at "
                    "FROM oauth_grants g "
                    "JOIN oauth_clients c ON c.client_id = g.client_id "
                    "LEFT JOIN agent_credentials cred ON cred.id = g.credential_id "
                    "WHERE g.user_id = ? "
                    "ORDER BY g.created_at DESC",
                    (user["id"],),
                ).fetchall()
            items = [
                {
                    "id": row["id"],
                    "client_id": row["client_id"],
                    "client_name": row["client_name"],
                    "registration_source": row["registration_source"],
                    "scopes": json.loads(row["scopes"]),
                    "created_at": row["created_at"],
                    "last_used_at": row["last_used_at"],
                    "access_expires_at": row["access_expires_at"],
                    "revoked_at": row["revoked_at"],
                }
                for row in rows
            ]
            return {"items": items, "total": len(items), "limit": len(items), "offset": 0}

        @router.delete(
            "/api/v1/oauth/grants/{grant_id}",
            dependencies=[Depends(self.auth.require_client)],
            operation_id="oauth_revoke_grant",
        )
        def revoke_grant(request: Request, grant_id: str):
            user = self.auth.require_session(request)
            with self.database.connect(write=True) as connection:
                connection.execute("BEGIN IMMEDIATE")
                row = connection.execute(
                    "SELECT id FROM oauth_grants WHERE id=? AND user_id=?",
                    (grant_id, user["id"]),
                ).fetchone()
                if row is None:
                    raise HTTPException(404, "oauth_grant_not_found")
                self._revoke_grant(connection, grant_id)
            actor = self.platform.current_actor(user["id"])
            self.platform.log("agent.oauth.revoked", actor, grant_id=grant_id)
            return {"ok": True}

        @router.get("/api/v1/oauth/clients", operation_id="oauth_list_clients")
        def list_clients(request: Request):
            user = self.auth.require_session(request)
            with self.database.connect(scoped=False) as connection:
                if profile_for(user) == "owner":
                    rows = connection.execute(
                        "SELECT * FROM oauth_clients WHERE registration_source='manual' "
                        "ORDER BY created_at DESC"
                    ).fetchall()
                else:
                    rows = connection.execute(
                        "SELECT * FROM oauth_clients WHERE registration_source='manual' "
                        "AND owner_user_id=? ORDER BY created_at DESC",
                        (user["id"],),
                    ).fetchall()
            items = [
                {
                    "client_id": row["client_id"],
                    "name": row["name"],
                    "redirect_uris": json.loads(row["redirect_uris"]),
                    "token_endpoint_auth_method": row["token_endpoint_auth_method"],
                    "created_at": row["created_at"],
                    "last_used_at": row["last_used_at"],
                }
                for row in rows
            ]
            return {"items": items, "total": len(items), "limit": len(items), "offset": 0}

        @router.post(
            "/api/v1/oauth/clients",
            status_code=201,
            dependencies=[Depends(self.auth.require_client)],
            operation_id="oauth_create_client",
        )
        def create_client(request: Request, body: ManualClientCreate):
            user = self.auth.require_session(request)
            with self.database.connect(write=True) as connection:
                connection.execute("BEGIN IMMEDIATE")
                existing = connection.execute(
                    "SELECT COUNT(*) FROM oauth_clients WHERE registration_source='manual' AND owner_user_id=?",
                    (user["id"],),
                ).fetchone()[0]
                if existing >= 50:
                    raise HTTPException(409, "oauth_client_limit_reached")
                return self._insert_client(
                    connection,
                    name=body.name,
                    redirect_uris=body.redirect_uris,
                    auth_method=body.token_endpoint_auth_method,
                    source="manual",
                    owner_user_id=user["id"],
                )

        @router.delete(
            "/api/v1/oauth/clients/{client_id}",
            dependencies=[Depends(self.auth.require_client)],
            operation_id="oauth_delete_client",
        )
        def delete_client(request: Request, client_id: str):
            user = self.auth.require_session(request)
            with self.database.connect(write=True) as connection:
                connection.execute("BEGIN IMMEDIATE")
                if profile_for(user) == "owner":
                    row = connection.execute(
                        "SELECT client_id FROM oauth_clients WHERE client_id=? AND registration_source='manual'",
                        (client_id,),
                    ).fetchone()
                else:
                    row = connection.execute(
                        "SELECT client_id FROM oauth_clients WHERE client_id=? AND registration_source='manual' AND owner_user_id=?",
                        (client_id, user["id"]),
                    ).fetchone()
                if row is None:
                    raise HTTPException(404, "oauth_client_not_found")
                grants = connection.execute(
                    "SELECT id FROM oauth_grants WHERE client_id=?", (client_id,)
                ).fetchall()
                for grant in grants:
                    self._revoke_grant(connection, grant["id"])
                connection.execute("DELETE FROM oauth_clients WHERE client_id=?", (client_id,))
            return {"ok": True}

        return router

    def _exchange_code(
        self,
        connection: sqlite3.Connection,
        request: Request,
        client: sqlite3.Row,
        form: dict[str, str],
    ) -> JSONResponse:
        code = form.get("code", "")
        redirect_uri = form.get("redirect_uri", "")
        code_verifier = form.get("code_verifier", "")
        resource_param = form.get("resource")
        if not code or not redirect_uri or not code_verifier:
            return oauth_error(
                "invalid_request", "Missing code, redirect_uri, or code_verifier", 400
            )
        if not PKCE_VERIFIER_RE.fullmatch(code_verifier):
            return oauth_error("invalid_grant", "Invalid PKCE code_verifier", 400)
        try:
            normalized_resource = resource_matches(request, resource_param)
        except ValueError:
            return oauth_error("invalid_target", "Resource does not match this MCP server", 400)

        code_hash = digest(code)
        code_row = connection.execute(
            "SELECT * FROM oauth_codes WHERE code_hash=?", (code_hash,)
        ).fetchone()
        if code_row is None:
            return oauth_error("invalid_grant", "Authorization code is invalid or expired", 400)
        if code_row["used_at"] is not None:
            if code_row["grant_id"]:
                self._revoke_grant(connection, code_row["grant_id"])
            return oauth_error("invalid_grant", "Authorization code has already been used", 400)
        current = now()
        if code_row["expires_at"] <= current:
            connection.execute("DELETE FROM oauth_codes WHERE code_hash=?", (code_hash,))
            return oauth_error("invalid_grant", "Authorization code has expired", 400)
        if code_row["client_id"] != client["client_id"]:
            return oauth_error("invalid_grant", "Authorization code belongs to another client", 400)
        if code_row["redirect_uri"] != redirect_uri.strip():
            return oauth_error("invalid_grant", "redirect_uri mismatch", 400)
        if (
            code_row["resource"] is not None
            and normalized_resource is not None
            and code_row["resource"] != normalized_resource
        ):
            return oauth_error("invalid_target", "Resource indicator mismatch", 400)
        if not hmac.compare_digest(pkce_s256(code_verifier), code_row["code_challenge"]):
            return oauth_error("invalid_grant", "PKCE verification failed", 400)

        user_row = connection.execute(
            "SELECT * FROM users WHERE id=? AND enabled=1 AND password_hash IS NOT NULL",
            (code_row["user_id"],),
        ).fetchone()
        if user_row is None:
            return oauth_error("invalid_grant", "User account is no longer active", 400)
        allowed = set(allowed_scopes_for_user(dict(user_row)))
        granted_scopes = [scope for scope in json.loads(code_row["scopes"]) if scope in allowed]
        if not granted_scopes:
            return oauth_error("invalid_scope", "No permitted scopes remain for this account", 400)

        grant_id = uuid4().hex
        connection.execute(
            "INSERT INTO oauth_grants("
            "id, client_id, user_id, scopes, resource, created_at, last_used_at"
            ") VALUES (?,?,?,?,?,?,?)",
            (
                grant_id,
                client["client_id"],
                user_row["id"],
                encoded(granted_scopes),
                normalized_resource or code_row["resource"],
                current,
                current,
            ),
        )
        cred_id, access_token = self._issue_access_credential(
            connection,
            user_id=user_row["id"],
            client_name=client["name"],
            scopes=granted_scopes,
            grant_id=grant_id,
        )
        connection.execute(
            "UPDATE oauth_grants SET credential_id=? WHERE id=?", (cred_id, grant_id)
        )
        connection.execute(
            "UPDATE oauth_codes SET used_at=?, grant_id=? WHERE code_hash=?",
            (current, grant_id, code_hash),
        )
        refresh_token = "wsr_" + secrets.token_urlsafe(32)
        connection.execute(
            "INSERT INTO oauth_refresh_tokens(token_hash, grant_id, created_at, expires_at) "
            "VALUES (?,?,?,?)",
            (digest(refresh_token), grant_id, current, future(REFRESH_TOKEN_TTL_SECONDS)),
        )
        connection.execute(
            "UPDATE oauth_clients SET last_used_at=? WHERE client_id=?",
            (current, client["client_id"]),
        )
        return JSONResponse(
            {
                "access_token": access_token,
                "token_type": "Bearer",
                "expires_in": ACCESS_TOKEN_TTL_SECONDS,
                "refresh_token": refresh_token,
                "scope": " ".join(granted_scopes),
            },
            status_code=200,
            headers={"Cache-Control": "no-store", "Pragma": "no-cache"},
        )

    def _exchange_refresh(
        self,
        connection: sqlite3.Connection,
        request: Request,
        client: sqlite3.Row,
        form: dict[str, str],
    ) -> JSONResponse:
        token_value = form.get("refresh_token", "")
        if not token_value:
            return oauth_error("invalid_request", "Missing refresh_token", 400)
        try:
            normalized_resource = resource_matches(request, form.get("resource"))
        except ValueError:
            return oauth_error("invalid_target", "Resource does not match this MCP server", 400)
        try:
            requested_scopes = parse_scope_string(form.get("scope"))
        except ValueError:
            return oauth_error("invalid_scope", "Unknown scope requested", 400)

        hashed = digest(token_value)
        row = connection.execute(
            "SELECT r.*, g.client_id, g.user_id, g.scopes AS grant_scopes, "
            "g.resource AS grant_resource, g.revoked_at AS grant_revoked_at, "
            "g.credential_id AS old_credential_id "
            "FROM oauth_refresh_tokens r "
            "JOIN oauth_grants g ON g.id = r.grant_id "
            "WHERE r.token_hash=?",
            (hashed,),
        ).fetchone()
        if row is None:
            return oauth_error("invalid_grant", "Refresh token is invalid", 400)
        if row["client_id"] != client["client_id"]:
            return oauth_error("invalid_grant", "Refresh token belongs to another client", 400)
        if row["rotated_at"] is not None:
            self._revoke_grant(connection, row["grant_id"])
            return oauth_error("invalid_grant", "Refresh token reuse detected; grant revoked", 400)
        current = now()
        if (
            row["revoked_at"] is not None
            or row["grant_revoked_at"] is not None
            or row["expires_at"] <= current
        ):
            return oauth_error("invalid_grant", "Refresh token is expired or revoked", 400)
        if (
            row["grant_resource"] is not None
            and normalized_resource is not None
            and row["grant_resource"] != normalized_resource
        ):
            return oauth_error("invalid_target", "Resource indicator mismatch", 400)

        user_row = connection.execute(
            "SELECT * FROM users WHERE id=? AND enabled=1 AND password_hash IS NOT NULL",
            (row["user_id"],),
        ).fetchone()
        if user_row is None:
            self._revoke_grant(connection, row["grant_id"])
            return oauth_error("invalid_grant", "User account is no longer active", 400)

        grant_scopes = json.loads(row["grant_scopes"])
        if requested_scopes and set(requested_scopes) - set(grant_scopes):
            return oauth_error("invalid_scope", "Requested scope exceeds original grant", 400)
        allowed = set(allowed_scopes_for_user(dict(user_row)))
        effective_scopes = [
            scope for scope in (requested_scopes or grant_scopes) if scope in allowed
        ]
        if not effective_scopes:
            self._revoke_grant(connection, row["grant_id"])
            return oauth_error("invalid_scope", "No permitted scopes remain for this account", 400)

        connection.execute(
            "UPDATE oauth_refresh_tokens SET rotated_at=? WHERE token_hash=?",
            (current, hashed),
        )
        if row["old_credential_id"]:
            connection.execute(
                "UPDATE agent_credentials SET revoked_at=COALESCE(revoked_at, ?), version=version+1 "
                "WHERE id=?",
                (current, row["old_credential_id"]),
            )
        cred_id, access_token = self._issue_access_credential(
            connection,
            user_id=user_row["id"],
            client_name=client["name"],
            scopes=effective_scopes,
            grant_id=row["grant_id"],
        )
        new_refresh = "wsr_" + secrets.token_urlsafe(32)
        connection.execute(
            "INSERT INTO oauth_refresh_tokens(token_hash, grant_id, created_at, expires_at) "
            "VALUES (?,?,?,?)",
            (digest(new_refresh), row["grant_id"], current, future(REFRESH_TOKEN_TTL_SECONDS)),
        )
        connection.execute(
            "UPDATE oauth_grants SET credential_id=?, last_used_at=? WHERE id=?",
            (cred_id, current, row["grant_id"]),
        )
        connection.execute(
            "UPDATE oauth_clients SET last_used_at=? WHERE client_id=?",
            (current, client["client_id"]),
        )
        return JSONResponse(
            {
                "access_token": access_token,
                "token_type": "Bearer",
                "expires_in": ACCESS_TOKEN_TTL_SECONDS,
                "refresh_token": new_refresh,
                "scope": " ".join(effective_scopes),
            },
            status_code=200,
            headers={"Cache-Control": "no-store", "Pragma": "no-cache"},
        )
