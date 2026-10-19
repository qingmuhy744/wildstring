"""Real SDK HTTP transport inside the app, scoped and isolated per request."""

from concurrent.futures import ThreadPoolExecutor

from test_personal_library import HEADERS, music

from wildstring.library.scanner import scan_library


def credential(api, scopes):
    response = api.post(
        "/api/v1/agent/credentials",
        headers=HEADERS,
        json={"name": "HTTP MCP test", "scopes": scopes},
    )
    assert response.status_code == 200
    return response.json()


def rpc(api, token, method, arguments=None):
    return api.post(
        "/mcp",
        headers={
            "Authorization": "Bearer " + token,
            "Accept": "application/json, text/event-stream",
            "MCP-Protocol-Version": "2025-11-25",
        },
        json={"jsonrpc": "2.0", "id": 1, "method": method, "params": arguments or {}},
    )


def test_native_http_initialization_discovery_draft_gate_and_revocation(
    settings, authenticated_client
):
    music(settings, "HTTP-MCP.flac", ["合成艺人"], [], album="合成专辑")
    scan_library(settings)
    with authenticated_client(settings) as api:
        saved = credential(api, ["library:read", "drafts:write", "drafts:apply"])
        token = saved["token"]
        initialized = rpc(
            api,
            token,
            "initialize",
            {
                "protocolVersion": "2025-11-25",
                "capabilities": {},
                "clientInfo": {"name": "test-client", "version": "1"},
            },
        )
        assert initialized.status_code == 200, initialized.text
        assert initialized.json()["result"]["protocolVersion"] == "2025-11-25"
        catalog = rpc(api, token, "tools/list").json()["result"]["tools"]
        names = {item["name"] for item in catalog}
        assert {"search_tracks", "create_draft", "apply_draft"} <= names
        assert "get_system_status" not in names
        result = rpc(api, token, "tools/call", {"name": "search_tracks", "arguments": {}})
        assert result.status_code == 200, result.text
        track = result.json()["result"]["structuredContent"]["result"]["items"][0]
        draft = rpc(
            api,
            token,
            "tools/call",
            {
                "name": "create_draft",
                "arguments": {
                    "kind": "playlist",
                    "title": "HTTP MCP preview",
                    "payload": {"name": "HTTP MCP playlist", "track_ids": [track["id"]]},
                },
            },
        ).json()["result"]["structuredContent"]["result"]
        denied = rpc(
            api,
            token,
            "tools/call",
            {
                "name": "apply_draft",
                "arguments": {
                    "draft_id": draft["id"],
                    "version": draft["version"],
                    "idempotency_key": "http-mcp-fixture",
                },
            },
        ).json()["result"]
        assert denied["isError"] and "draft_approval_required" in denied["content"][0]["text"]
        assert (
            api.delete("/api/v1/agent/credentials/" + saved["id"], headers=HEADERS).status_code
            == 200
        )
        assert rpc(api, token, "tools/list").status_code == 401


def test_native_http_credentials_origins_limits_and_parallel_scope_isolation(
    settings, authenticated_client
):
    with authenticated_client(settings) as api:
        first = credential(api, ["library:read"])["token"]
        second = credential(api, ["notifications:read"])["token"]
        assert (
            api.post("/mcp", json={"jsonrpc": "2.0", "method": "tools/list", "id": 1}).status_code
            == 401
        )
        assert (
            api.post(
                "/mcp",
                headers={"Authorization": "Bearer " + first, "Origin": "https://evil.example"},
                json={},
            ).status_code
            == 403
        )
        oversized = api.post(
            "/mcp",
            headers={
                "Authorization": "Bearer " + first,
                "Content-Type": "application/json",
                "Accept": "application/json, text/event-stream",
            },
            content=" " * (128 * 1024 + 1),
        )
        assert oversized.status_code == 413

        def catalog(token):
            result = rpc(api, token, "tools/list")
            assert result.status_code == 200, result.text
            return {t["name"] for t in result.json()["result"]["tools"]}

        tokens = [first, second] * 4
        with ThreadPoolExecutor(max_workers=4) as pool:
            catalogs = list(pool.map(catalog, tokens))
        for token, names in zip(tokens, catalogs, strict=True):
            assert ("search_tracks" in names) == (token == first)
            assert ("list_notifications" in names) == (token == second)


def test_official_sdk_http_client_over_real_socket(settings, authenticated_client):
    import asyncio
    import threading
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    import httpx2
    from mcp.client.session import ClientSession
    from mcp.client.streamable_http import streamable_http_client

    with authenticated_client(settings) as api:
        saved = credential(api, ["library:read", "library:manage", "personal:read"])

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def route(self):
                raw = self.rfile.read(int(self.headers.get("Content-Length", 0)))
                response = api.request(
                    self.command,
                    self.path,
                    content=raw or None,
                    headers={
                        key: value
                        for key, value in self.headers.items()
                        if key.lower()
                        in {
                            "authorization",
                            "content-type",
                            "accept",
                            "mcp-protocol-version",
                            "mcp-session-id",
                        }
                    },
                )
                self.send_response(response.status_code)
                self.send_header(
                    "Content-Type", response.headers.get("Content-Type", "application/json")
                )
                self.send_header("Content-Length", str(len(response.content)))
                self.end_headers()
                self.wfile.write(response.content)

            do_POST = route
            do_GET = route
            do_DELETE = route

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()

        async def exercise():
            async with httpx2.AsyncClient(
                headers={"Authorization": "Bearer " + saved["token"]}, trust_env=False
            ) as http:
                async with streamable_http_client(
                    f"http://127.0.0.1:{server.server_port}/mcp", http_client=http
                ) as (read, write):
                    async with ClientSession(read, write, read_timeout_seconds=10) as session:
                        initialized = await session.initialize()
                        assert initialized.server_info.name == "WildString"
                        catalog = await session.list_tools()
                        names = {t.name for t in catalog.tools}
                        assert {
                            "get_gain_settings",
                            "get_import_settings",
                            "get_lyrics_quality",
                        } <= names
                        result = await session.call_tool("get_import_settings", {})
                        assert not result.is_error
                        assert result.structured_content["result"]["download_policy"][
                            "wait_for_album"
                        ]
                        invalid = await session.call_tool("list_intake_items", {"limit": 101})
                        assert invalid.is_error and "agent_invalid_input" in invalid.content[0].text

        try:
            asyncio.run(exercise())
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)
