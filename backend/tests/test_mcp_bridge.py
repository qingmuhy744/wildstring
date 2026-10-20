"""Exercise the real official SDK over stdio, including structured failures."""

import asyncio
import json
import os
import sys
import threading
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from mcp import Client
from mcp.client.stdio import StdioServerParameters

from wildstring.mcp_bridge import Bridge, BridgeError

TOKEN = "ws_" + "fixture" * 6


@contextmanager
def tool_server():
    calls = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_GET(self):
            assert self.headers["Authorization"] == "Bearer " + TOKEN
            raw = json.dumps(
                {
                    "tools": [
                        {
                            "name": "search_tracks",
                            "description": "Search real library IDs",
                            "inputSchema": {
                                "type": "object",
                                "properties": {"q": {"type": "string"}},
                            },
                            "readOnlyHint": True,
                        }
                    ]
                }
            ).encode()
            self.send_response(200)
            self.end_headers()
            self.wfile.write(raw)

        def do_POST(self):
            assert self.headers["Authorization"] == "Bearer " + TOKEN
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            calls.append(body)
            self.send_response(403 if body.get("q") == "forbidden" else 200)
            self.end_headers()
            self.wfile.write(
                json.dumps(
                    {"detail": "credential_revoked"}
                    if body.get("q") == "forbidden"
                    else {
                        "result": {"items": [{"id": "real-track-id", "title": "合成歌曲"}]},
                        "trace_id": "a" * 32,
                    }
                ).encode()
            )

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield "http://127.0.0.1:" + str(server.server_port), calls
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def test_official_stdio_discovery_call_resource_prompt_and_revocation():
    with tool_server() as (url, calls):

        async def exercise():
            params = StdioServerParameters(
                command=sys.executable,
                args=["-m", "wildstring.mcp_bridge"],
                env=os.environ
                | {
                    "WILDSTRING_MCP_URL": url,
                    "WILDSTRING_MCP_TOKEN": TOKEN,
                    "NO_PROXY": "127.0.0.1",
                },
            )
            async with Client(params) as client:
                tools = await client.list_tools()
                assert (
                    tools.tools[0].name == "search_tracks"
                    and tools.tools[0].annotations.read_only_hint
                )
                result = await client.call_tool("search_tracks", {"q": "合成"})
                assert (
                    not result.is_error
                    and result.structured_content["result"]["items"][0]["id"] == "real-track-id"
                )
                denied = await client.call_tool("search_tracks", {"q": "forbidden"})
                assert denied.is_error and "credential_revoked" in denied.content[0].text
                arbitrary = await client.call_tool("delete_files", {})
                assert arbitrary.is_error
                usage = await client.read_resource("wildstring://usage")
                assert "manual mode requires" in usage.contents[0].text
                assert "automatic mode applies only" in usage.contents[0].text
                assert "Tools cannot change" in usage.contents[0].text
                prompts = await client.list_prompts()
                assert prompts.prompts[0].name == "inspect-library"
                prompt = await client.get_prompt("inspect-library")
                assert "Wait for my approval" in prompt.messages[0].content.text

        asyncio.run(exercise())
        assert len(calls) == 2 and all("token" not in body for body in calls)


def test_stdio_real_backend_draft_approval_apply_diagnostics_and_revoke(
    settings, authenticated_client
):
    from test_personal_library import HEADERS, music

    from wildstring.library.scanner import scan_library

    music(settings, "MCP合成.flac", ["合成艺人"], [], album="合成专辑")
    scan_library(settings)
    with authenticated_client(settings) as api:
        created = api.post(
            "/api/v1/agent/credentials",
            headers=HEADERS,
            json={
                "name": "MCP fixture",
                "scopes": [
                    "library:read",
                    "drafts:write",
                    "drafts:apply",
                    "notifications:read",
                    "diagnostics:read",
                ],
            },
        )
        assert created.status_code == 200
        credential = created.json()

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def route(self):
                raw = self.rfile.read(int(self.headers.get("Content-Length", 0)))
                # No Cookie from the owning TestClient: the MCP token alone must
                # carry authority, and must never acquire a site approval session.
                response = api.request(
                    self.command,
                    self.path,
                    content=raw or None,
                    headers={
                        "Authorization": self.headers.get("Authorization", ""),
                        "Content-Type": "application/json",
                    },
                )
                self.send_response(response.status_code)
                self.end_headers()
                self.wfile.write(response.content)

            do_GET = route
            do_POST = route

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()

        async def exercise():
            params = StdioServerParameters(
                command=sys.executable,
                args=["-m", "wildstring.mcp_bridge"],
                env=os.environ
                | {
                    "WILDSTRING_MCP_URL": f"http://127.0.0.1:{server.server_port}",
                    "WILDSTRING_MCP_TOKEN": credential["token"],
                    "NO_PROXY": "127.0.0.1",
                },
            )
            async with Client(params) as client:
                tools = await client.list_tools()
                assert {"search_tracks", "create_draft", "apply_draft", "get_system_status"} <= {
                    item.name for item in tools.tools
                }
                search = await client.call_tool("search_tracks", {"q": "MCP合成"})
                identity = search.structured_content["result"]["items"][0]["id"]
                draft = await client.call_tool(
                    "create_draft",
                    {
                        "kind": "playlist",
                        "title": "MCP草案",
                        "payload": {"name": "MCP歌单", "track_ids": [identity]},
                    },
                )
                data = draft.structured_content["result"]
                args = {
                    "draft_id": data["id"],
                    "version": data["version"],
                    "idempotency_key": "fixture-key",
                }
                denied = await client.call_tool("apply_draft", args)
                assert denied.is_error and "draft_approval_required" in denied.content[0].text
                # Only the human-facing Cookie route can grant concrete approval.
                approved = api.post(
                    "/api/v1/agent/drafts/" + data["id"] + "/approve",
                    headers=HEADERS,
                    json={"version": data["version"]},
                )
                assert approved.status_code == 200
                applied = await client.call_tool("apply_draft", args)
                assert not applied.is_error, applied.content
                again = await client.call_tool("apply_draft", args)
                assert (
                    again.structured_content["result"]["result"]
                    == applied.structured_content["result"]["result"]
                )
                notices = await client.call_tool("list_notifications", {})
                assert notices.structured_content["result"]["unread_count"] >= 2
                status = await client.call_tool("get_system_status", {})
                assert status.structured_content["result"]["schema_version"] == 25
                deletion_response = api.delete(
                    "/api/v1/agent/credentials/" + credential["id"], headers=HEADERS
                )
                assert deletion_response.status_code == 200
                revoked = await client.call_tool("search_tracks", {})
                assert revoked.is_error and "agent_credential_invalid" in revoked.content[0].text

        try:
            asyncio.run(exercise())
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)


@pytest.mark.parametrize(
    "url",
    [
        "file:///etc/passwd",
        "https://user:password@example.com",
        "https://example.com?token=secret",
        "http://192.168.1.2",
        "https://example.com/#secret",
    ],
)
def test_bridge_rejects_unsafe_connection_without_echoing(url):
    with pytest.raises(BridgeError, match="^invalid_mcp_connection$"):
        Bridge(url, TOKEN)
