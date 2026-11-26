"""OAuth 2.1 discovery, DCR, PKCE, token rotation, revocation and MCP interop tests."""

from __future__ import annotations

import base64
import secrets
from urllib.parse import parse_qs, urlsplit

from fastapi.testclient import TestClient
from pydantic import SecretStr
from test_auth import PASSWORD, login
from test_personal_library import HEADERS, music

from wildstring.database import SCHEMA_VERSION, Database
from wildstring.library.scanner import scan_library
from wildstring.main import create_app
from wildstring.mcp_oauth import pkce_s256


def _pkce_pair() -> tuple[str, str]:
    verifier = secrets.token_urlsafe(48)
    return verifier, pkce_s256(verifier)


def _rpc(client: TestClient, token: str, method: str, arguments: dict | None = None):
    return client.post(
        "/mcp",
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/json, text/event-stream",
            "MCP-Protocol-Version": "2025-11-25",
        },
        json={"jsonrpc": "2.0", "id": 1, "method": method, "params": arguments or {}},
    )


def test_discovery_metadata_and_www_authenticate_resource_metadata(settings, authenticated_client):
    with authenticated_client(settings) as client:
        unauthorized = client.post(
            "/mcp",
            json={"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}},
        )
        assert unauthorized.status_code == 401
        www = unauthorized.headers["www-authenticate"]
        assert www.startswith("Bearer ")
        assert (
            'resource_metadata="http://testserver/.well-known/oauth-protected-resource/mcp"' in www
        )

        for path in (
            "/.well-known/oauth-protected-resource",
            "/.well-known/oauth-protected-resource/mcp",
        ):
            res = client.get(path)
            assert res.status_code == 200
            body = res.json()
            assert body["resource"] == "http://testserver/mcp"
            assert body["authorization_servers"] == ["http://testserver"]
            assert body["bearer_methods_supported"] == ["header"]
            assert "library:read" in body["scopes_supported"]

        as_meta = client.get("/.well-known/oauth-authorization-server")
        assert as_meta.status_code == 200
        meta = as_meta.json()
        assert meta["issuer"] == "http://testserver"
        assert meta["authorization_endpoint"] == "http://testserver/oauth/authorize"
        assert meta["token_endpoint"] == "http://testserver/oauth/token"
        assert meta["registration_endpoint"] == "http://testserver/oauth/register"
        assert meta["revocation_endpoint"] == "http://testserver/oauth/revoke"
        assert meta["code_challenge_methods_supported"] == ["S256"]
        assert meta["grant_types_supported"] == ["authorization_code", "refresh_token"]
        assert "library:read" in meta["scopes_supported"]


def test_full_dcr_pkce_mcp_refresh_and_dual_track_pat_isolation(settings, authenticated_client):
    music(settings, "OAuth-Track.flac", ["OAuth 艺人"], [], album="OAuth 专辑")
    scan_library(settings)
    redirect_uri = "https://oauth-redirect.googleusercontent.com/r/wildstring-demo"

    with authenticated_client(settings) as client:
        # 1. Existing static PAT keeps working cleanly alongside OAuth 2.1.
        pat_res = client.post(
            "/api/v1/agent/credentials",
            headers=HEADERS,
            json={"name": "Static Local CLI", "scopes": ["library:read"]},
        )
        assert pat_res.status_code == 200
        pat_token = pat_res.json()["token"]
        assert _rpc(client, pat_token, "tools/list").status_code == 200

        # 2. Dynamic Client Registration (public PKCE client).
        reg = client.post(
            "/oauth/register",
            json={
                "client_name": "Google Gemini",
                "redirect_uris": [redirect_uri],
                "token_endpoint_auth_method": "none",
            },
        )
        assert reg.status_code == 201, reg.text
        assert reg.headers["cache-control"] == "no-store"
        client_id = reg.json()["client_id"]
        assert "client_secret" not in reg.json()

        # 3. Authorize context + deny path.
        verifier, challenge = _pkce_pair()
        ctx = client.post(
            "/api/v1/oauth/authorize/context",
            headers=HEADERS,
            json={
                "client_id": client_id,
                "redirect_uri": redirect_uri,
                "response_type": "code",
                "code_challenge": challenge,
                "code_challenge_method": "S256",
                "scope": "library:read personal:read",
                "state": "opaque-state-1",
                "resource": "http://testserver/mcp",
            },
        )
        assert ctx.status_code == 200, ctx.text
        ctx_body = ctx.json()
        assert ctx_body["client"]["name"] == "Google Gemini"
        assert ctx_body["redirect_host"] == "oauth-redirect.googleusercontent.com"
        assert ctx_body["default_scopes"] == ["library:read", "personal:read"]

        denied = client.post(
            "/api/v1/oauth/authorize/decision",
            headers=HEADERS,
            json={
                "decision": "deny",
                "client_id": client_id,
                "redirect_uri": redirect_uri,
                "code_challenge": challenge,
                "code_challenge_method": "S256",
                "scopes": [],
                "state": "opaque-state-1",
                "resource": "http://testserver/mcp",
            },
        )
        assert denied.status_code == 200
        denied_qs = parse_qs(urlsplit(denied.json()["redirect_to"]).query)
        assert denied_qs["error"] == ["access_denied"]
        assert denied_qs["state"] == ["opaque-state-1"]

        # 4. Approve with narrowed scope (`library:read` only).
        approved = client.post(
            "/api/v1/oauth/authorize/decision",
            headers=HEADERS,
            json={
                "decision": "approve",
                "client_id": client_id,
                "redirect_uri": redirect_uri,
                "code_challenge": challenge,
                "code_challenge_method": "S256",
                "scopes": ["library:read"],
                "state": "opaque-state-2",
                "resource": "http://testserver/mcp",
            },
        )
        assert approved.status_code == 200, approved.text
        parsed = urlsplit(approved.json()["redirect_to"])
        assert f"{parsed.scheme}://{parsed.netloc}{parsed.path}" == redirect_uri
        qs = parse_qs(parsed.query)
        code = qs["code"][0]
        assert qs["state"] == ["opaque-state-2"]

        # 5. Wrong PKCE verifier is rejected without consuming the code.
        bad_pkce = client.post(
            "/oauth/token",
            data={
                "grant_type": "authorization_code",
                "client_id": client_id,
                "code": code,
                "redirect_uri": redirect_uri,
                "code_verifier": secrets.token_urlsafe(48),
                "resource": "http://testserver/mcp",
            },
        )
        assert bad_pkce.status_code == 400
        assert bad_pkce.json()["error"] == "invalid_grant"

        # 6. Valid exchange issues ws_... access_token + wsr_... refresh_token.
        exchanged = client.post(
            "/oauth/token",
            data={
                "grant_type": "authorization_code",
                "client_id": client_id,
                "code": code,
                "redirect_uri": redirect_uri,
                "code_verifier": verifier,
                "resource": "http://testserver/mcp",
            },
        )
        assert exchanged.status_code == 200, exchanged.text
        assert exchanged.headers["cache-control"] == "no-store"
        tokens = exchanged.json()
        assert tokens["token_type"] == "Bearer"
        assert tokens["access_token"].startswith("ws_")
        assert tokens["refresh_token"].startswith("wsr_")
        assert tokens["expires_in"] == 3600
        assert tokens["scope"] == "library:read"

        # OAuth short-lived credentials stay hidden from manual PAT list, while grants list shows it.
        manual_creds = client.get("/api/v1/agent/credentials").json()["items"]
        assert [item["name"] for item in manual_creds] == ["Static Local CLI"]
        grants = client.get("/api/v1/oauth/grants").json()["items"]
        assert len(grants) == 1
        assert grants[0]["client_name"] == "Google Gemini"
        assert grants[0]["scopes"] == ["library:read"]
        grant_id = grants[0]["id"]

        # 7. Real MCP call works and enforces granted scope.
        catalog = _rpc(client, tokens["access_token"], "tools/list")
        assert catalog.status_code == 200
        tool_names = {tool["name"] for tool in catalog.json()["result"]["tools"]}
        assert "search_tracks" in tool_names
        assert "get_personal_library" not in tool_names
        found = _rpc(
            client, tokens["access_token"], "tools/call", {"name": "search_tracks", "arguments": {}}
        )
        assert found.status_code == 200
        assert (
            found.json()["result"]["structuredContent"]["result"]["items"][0]["title"]
            == "OAuth-Track.flac"
        )

        # 8. Refresh token rotation invalidates old access token and rejects scope widening.
        widen = client.post(
            "/oauth/token",
            data={
                "grant_type": "refresh_token",
                "client_id": client_id,
                "refresh_token": tokens["refresh_token"],
                "scope": "library:read drafts:write",
            },
        )
        assert widen.status_code == 400
        assert widen.json()["error"] == "invalid_scope"

        refreshed = client.post(
            "/oauth/token",
            data={
                "grant_type": "refresh_token",
                "client_id": client_id,
                "refresh_token": tokens["refresh_token"],
                "resource": "http://testserver/mcp",
            },
        )
        assert refreshed.status_code == 200, refreshed.text
        next_tokens = refreshed.json()
        assert next_tokens["access_token"] != tokens["access_token"]
        assert next_tokens["refresh_token"] != tokens["refresh_token"]
        assert _rpc(client, tokens["access_token"], "tools/list").status_code == 401
        assert _rpc(client, next_tokens["access_token"], "tools/list").status_code == 200

        # 9. Revoking grant from Settings immediately revokes access & refresh tokens, PAT untouched.
        revoked = client.delete(f"/api/v1/oauth/grants/{grant_id}", headers=HEADERS)
        assert revoked.status_code == 200
        assert _rpc(client, next_tokens["access_token"], "tools/list").status_code == 401
        post_revoke_refresh = client.post(
            "/oauth/token",
            data={
                "grant_type": "refresh_token",
                "client_id": client_id,
                "refresh_token": next_tokens["refresh_token"],
            },
        )
        assert post_revoke_refresh.status_code == 400
        assert post_revoke_refresh.json()["error"] == "invalid_grant"
        assert _rpc(client, pat_token, "tools/list").status_code == 200


def test_code_replay_and_refresh_replay_revoke_entire_grant(settings, authenticated_client):
    redirect_uri = "https://claude.ai/api/mcp/auth_callback"
    with authenticated_client(settings) as client:
        client_id = client.post(
            "/oauth/register",
            json={"client_name": "Claude Web", "redirect_uris": [redirect_uri]},
        ).json()["client_id"]

        # Authorization code replay revokes issued grant & access token.
        v1, c1 = _pkce_pair()
        approved1 = client.post(
            "/api/v1/oauth/authorize/decision",
            headers=HEADERS,
            json={
                "decision": "approve",
                "client_id": client_id,
                "redirect_uri": redirect_uri,
                "code_challenge": c1,
                "code_challenge_method": "S256",
                "scopes": ["library:read"],
            },
        )
        code1 = parse_qs(urlsplit(approved1.json()["redirect_to"]).query)["code"][0]
        first = client.post(
            "/oauth/token",
            data={
                "grant_type": "authorization_code",
                "client_id": client_id,
                "code": code1,
                "redirect_uri": redirect_uri,
                "code_verifier": v1,
            },
        ).json()
        assert _rpc(client, first["access_token"], "tools/list").status_code == 200

        replay = client.post(
            "/oauth/token",
            data={
                "grant_type": "authorization_code",
                "client_id": client_id,
                "code": code1,
                "redirect_uri": redirect_uri,
                "code_verifier": v1,
            },
        )
        assert replay.status_code == 400
        assert replay.json()["error"] == "invalid_grant"
        assert _rpc(client, first["access_token"], "tools/list").status_code == 401

        # Refresh token replay revokes the newer rotated token and grant.
        v2, c2 = _pkce_pair()
        approved2 = client.post(
            "/api/v1/oauth/authorize/decision",
            headers=HEADERS,
            json={
                "decision": "approve",
                "client_id": client_id,
                "redirect_uri": redirect_uri,
                "code_challenge": c2,
                "code_challenge_method": "S256",
                "scopes": ["library:read"],
            },
        )
        code2 = parse_qs(urlsplit(approved2.json()["redirect_to"]).query)["code"][0]
        tok2 = client.post(
            "/oauth/token",
            data={
                "grant_type": "authorization_code",
                "client_id": client_id,
                "code": code2,
                "redirect_uri": redirect_uri,
                "code_verifier": v2,
            },
        ).json()
        tok3 = client.post(
            "/oauth/token",
            data={
                "grant_type": "refresh_token",
                "client_id": client_id,
                "refresh_token": tok2["refresh_token"],
            },
        ).json()
        assert _rpc(client, tok3["access_token"], "tools/list").status_code == 200

        reused_refresh = client.post(
            "/oauth/token",
            data={
                "grant_type": "refresh_token",
                "client_id": client_id,
                "refresh_token": tok2["refresh_token"],
            },
        )
        assert reused_refresh.status_code == 400
        assert reused_refresh.json()["error"] == "invalid_grant"
        assert _rpc(client, tok3["access_token"], "tools/list").status_code == 401


def test_confidential_manual_client_basic_auth_revoke_and_delete(settings, authenticated_client):
    redirect_uri = "https://oauth-redirect.googleusercontent.com/r/static-app"
    with authenticated_client(settings) as client:
        created = client.post(
            "/api/v1/oauth/clients",
            headers=HEADERS,
            json={
                "name": "Static Gemini Connector",
                "redirect_uris": [redirect_uri],
                "token_endpoint_auth_method": "client_secret_basic",
            },
        )
        assert created.status_code == 201, created.text
        client_id = created.json()["client_id"]
        client_secret = created.json()["client_secret"]
        assert client_secret.startswith("wss_")
        listed = client.get("/api/v1/oauth/clients").json()["items"]
        assert len(listed) == 1
        assert "client_secret" not in listed[0]

        verifier, challenge = _pkce_pair()
        approved = client.post(
            "/api/v1/oauth/authorize/decision",
            headers=HEADERS,
            json={
                "decision": "approve",
                "client_id": client_id,
                "redirect_uri": redirect_uri,
                "code_challenge": challenge,
                "code_challenge_method": "S256",
                "scopes": ["library:read"],
            },
        )
        code = parse_qs(urlsplit(approved.json()["redirect_to"]).query)["code"][0]

        # Missing secret fails.
        no_secret = client.post(
            "/oauth/token",
            data={
                "grant_type": "authorization_code",
                "client_id": client_id,
                "code": code,
                "redirect_uri": redirect_uri,
                "code_verifier": verifier,
            },
        )
        assert no_secret.status_code == 401

        # Dual auth fails per RFC 6749 §2.3.
        basic = base64.b64encode(f"{client_id}:{client_secret}".encode()).decode()
        dual = client.post(
            "/oauth/token",
            headers={"Authorization": f"Basic {basic}"},
            data={
                "grant_type": "authorization_code",
                "client_id": client_id,
                "code": code,
                "redirect_uri": redirect_uri,
                "code_verifier": verifier,
            },
        )
        assert dual.status_code == 400
        assert dual.json()["error"] == "invalid_request"

        # Valid Basic auth succeeds.
        exchanged = client.post(
            "/oauth/token",
            headers={"Authorization": f"Basic {basic}"},
            data={
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": redirect_uri,
                "code_verifier": verifier,
            },
        )
        assert exchanged.status_code == 200, exchanged.text
        tokens = exchanged.json()
        assert _rpc(client, tokens["access_token"], "tools/list").status_code == 200

        # RFC 7009 revocation via refresh_token kills the entire grant & access token.
        rev = client.post(
            "/oauth/revoke",
            headers={"Authorization": f"Basic {basic}"},
            data={"token": tokens["refresh_token"]},
        )
        assert rev.status_code == 200
        assert _rpc(client, tokens["access_token"], "tools/list").status_code == 401

        # Deleting manual client removes it cleanly.
        deleted = client.delete(f"/api/v1/oauth/clients/{client_id}", headers=HEADERS)
        assert deleted.status_code == 200
        assert client.get("/api/v1/oauth/clients").json()["items"] == []


def test_redirect_uri_loopback_validation_resource_and_listener_scope_ceiling(
    settings, authenticated_client
):
    with authenticated_client(settings) as client:
        # Reject insecure non-loopback HTTP, fragments, userinfo, and unknown schemes.
        for bad_uri in (
            "http://evil.example/callback",
            "https://valid.example/cb#fragment",
            "https://user:pass@valid.example/cb",
            "javascript:alert(1)",
        ):
            res = client.post(
                "/oauth/register",
                json={"client_name": "Bad", "redirect_uris": [bad_uri]},
            )
            assert res.status_code == 400, bad_uri

        # RFC 8252 loopback dynamic port allowed.
        loopback_id = client.post(
            "/oauth/register",
            json={"client_name": "Local CLI", "redirect_uris": ["http://127.0.0.1/callback"]},
        ).json()["client_id"]
        _, challenge = _pkce_pair()
        ctx_ok = client.post(
            "/api/v1/oauth/authorize/context",
            headers=HEADERS,
            json={
                "client_id": loopback_id,
                "redirect_uri": "http://127.0.0.1:43210/callback",
                "response_type": "code",
                "code_challenge": challenge,
                "code_challenge_method": "S256",
            },
        )
        assert ctx_ok.status_code == 200

        # Foreign resource indicator is rejected.
        bad_resource = client.post(
            "/api/v1/oauth/authorize/context",
            headers=HEADERS,
            json={
                "client_id": loopback_id,
                "redirect_uri": "http://127.0.0.1:43210/callback",
                "response_type": "code",
                "code_challenge": challenge,
                "code_challenge_method": "S256",
                "resource": "https://other.example/mcp",
            },
        )
        assert bad_resource.status_code == 400
        assert bad_resource.json()["detail"] == "oauth_invalid_resource"

        # Non-owner listener cannot approve owner-only scopes.
        created_user = client.post(
            "/api/v1/manage/users",
            headers=HEADERS,
            json={
                "username": "listener_oauth",
                "password": "listener-secure-password-123",
                "profile": "listener",
            },
        )
        assert created_user.status_code == 201
        with TestClient(client.app) as listener:
            assert (
                listener.post(
                    "/api/v1/auth/login",
                    headers=HEADERS,
                    json={
                        "username": "listener_oauth",
                        "password": "listener-secure-password-123",
                    },
                ).status_code
                == 200
            )
            lctx = listener.post(
                "/api/v1/oauth/authorize/context",
                headers=HEADERS,
                json={
                    "client_id": loopback_id,
                    "redirect_uri": "http://127.0.0.1:43210/callback",
                    "response_type": "code",
                    "code_challenge": challenge,
                    "code_challenge_method": "S256",
                    "scope": "library:read library:manage diagnostics:read",
                },
            )
            assert lctx.status_code == 200
            assert "library:manage" not in lctx.json()["allowed_scopes"]
            assert "diagnostics:read" not in lctx.json()["allowed_scopes"]
            assert lctx.json()["default_scopes"] == ["library:read"]
            forbidden = listener.post(
                "/api/v1/oauth/authorize/decision",
                headers=HEADERS,
                json={
                    "decision": "approve",
                    "client_id": loopback_id,
                    "redirect_uri": "http://127.0.0.1:43210/callback",
                    "code_challenge": challenge,
                    "code_challenge_method": "S256",
                    "scopes": ["library:manage"],
                },
            )
            assert forbidden.status_code == 422


def test_https_only_policy_and_schema_63_migration(settings):
    settings.admin_password = SecretStr(PASSWORD)
    with TestClient(create_app(settings), base_url="https://testserver") as https_client:
        assert login(https_client).status_code == 200
        manual = https_client.post(
            "/api/v1/agent/credentials",
            headers=HEADERS,
            json={"name": "Before Migration", "scopes": ["library:read"]},
        )
        assert manual.status_code == 200
        assert (
            https_client.patch(
                "/api/v1/manage/server",
                headers=HEADERS,
                json={"connection_policy": "https_only"},
            ).status_code
            == 200
        )

    with TestClient(create_app(settings), base_url="http://testserver") as http_client:
        blocked = http_client.post(
            "/oauth/register",
            json={"client_name": "Plaintext", "redirect_uris": ["https://claude.ai/cb"]},
        )
        assert blocked.status_code == 403
        assert blocked.json()["detail"] == "https_required"

    # Simulate v62 -> v63 migration while preserving existing credentials.
    database = Database(settings.data_dir)
    with database.connect(write=True) as db:
        db.execute("DROP TABLE oauth_refresh_tokens")
        db.execute("DROP TABLE oauth_codes")
        db.execute("DROP TABLE oauth_grants")
        db.execute("DROP TABLE oauth_clients")
        db.execute("PRAGMA user_version = 62")
    database.initialize()
    with database.connect(scoped=False) as db:
        assert db.execute("PRAGMA user_version").fetchone()[0] == SCHEMA_VERSION
        row = db.execute("SELECT name, oauth_grant_id FROM agent_credentials").fetchone()
        assert row["name"] == "Before Migration"
        assert row["oauth_grant_id"] is None


def test_disabled_user_and_authorize_privacy_headers_and_dcr_rate_limit(
    settings, authenticated_client, monkeypatch
):
    from wildstring import mcp_oauth as oauth_module

    monkeypatch.setattr(oauth_module, "DCR_RATE_LIMIT_MAX_PER_IP", 2)
    redirect_uri = "https://oauth-redirect.googleusercontent.com/r/rate-check"
    with authenticated_client(settings) as client:
        page = client.get("/oauth/authorize")
        assert page.headers["cache-control"] == "no-store"
        assert page.headers["referrer-policy"] == "no-referrer"

        first = client.post(
            "/oauth/register", json={"client_name": "One", "redirect_uris": [redirect_uri]}
        )
        assert first.status_code == 201
        client_id = first.json()["client_id"]
        assert (
            client.post(
                "/oauth/register", json={"client_name": "Two", "redirect_uris": [redirect_uri]}
            ).status_code
            == 201
        )
        throttled = client.post(
            "/oauth/register", json={"client_name": "Three", "redirect_uris": [redirect_uri]}
        )
        assert throttled.status_code == 429

        # Create a listener, authorize OAuth, then disable the listener -> MCP & refresh blocked.
        created = client.post(
            "/api/v1/manage/users",
            headers=HEADERS,
            json={
                "username": "disabled_oauth",
                "password": "listener-secure-password-456",
                "profile": "listener",
            },
        )
        assert created.status_code == 201
        user_id = created.json()["id"]
        user_ver = created.json()["version"]
        verifier, challenge = _pkce_pair()
        with TestClient(client.app) as listener:
            assert (
                listener.post(
                    "/api/v1/auth/login",
                    headers=HEADERS,
                    json={
                        "username": "disabled_oauth",
                        "password": "listener-secure-password-456",
                    },
                ).status_code
                == 200
            )
            approved = listener.post(
                "/api/v1/oauth/authorize/decision",
                headers=HEADERS,
                json={
                    "decision": "approve",
                    "client_id": client_id,
                    "redirect_uri": redirect_uri,
                    "code_challenge": challenge,
                    "code_challenge_method": "S256",
                    "scopes": ["library:read"],
                },
            )
            code = parse_qs(urlsplit(approved.json()["redirect_to"]).query)["code"][0]
            tokens = listener.post(
                "/oauth/token",
                data={
                    "grant_type": "authorization_code",
                    "client_id": client_id,
                    "code": code,
                    "redirect_uri": redirect_uri,
                    "code_verifier": verifier,
                },
            ).json()
            assert _rpc(listener, tokens["access_token"], "tools/list").status_code == 200

            assert (
                client.put(
                    f"/api/v1/manage/users/{user_id}",
                    headers=HEADERS,
                    json={"version": user_ver, "profile": "listener", "enabled": False},
                ).status_code
                == 200
            )
            assert _rpc(listener, tokens["access_token"], "tools/list").status_code == 401
            refreshed = listener.post(
                "/oauth/token",
                data={
                    "grant_type": "refresh_token",
                    "client_id": client_id,
                    "refresh_token": tokens["refresh_token"],
                },
            )
            assert refreshed.status_code == 400
            assert refreshed.json()["error"] == "invalid_grant"
