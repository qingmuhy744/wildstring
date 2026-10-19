"""Official-SDK Streamable HTTP, with per-request WildString credentials."""

import asyncio
import re
from contextlib import asynccontextmanager
from urllib.parse import urlsplit
from uuid import uuid4

from fastapi import HTTPException
from mcp.server.streamable_http_manager import StreamableHTTPSessionManager
from starlette.requests import Request
from starlette.responses import JSONResponse

from wildstring.mcp_bridge import BridgeError, BridgeProtocol


class LocalBridge(BridgeProtocol):
    """Reuse the stdio contract, keeping request identity out of shared state."""

    def __init__(self, platform):
        self.platform = platform

    def request(self, path, payload=None, context=None):
        if context is None or context.request is None:
            raise BridgeError("agent_credential_invalid")
        try:
            actor = self.platform.actor(context.request)
            if not actor.credential_id:
                raise BridgeError("agent_credential_required")
            if path == "/tools":
                return {"tools": self.platform.tool_catalog(actor)}
            if not path.startswith("/tools/"):
                raise BridgeError("unknown_or_forbidden_tool")
            name = path.removeprefix("/tools/")
            result = self.platform.execute_tool(actor, name, payload)
            trace = getattr(context.request.state, "trace_id", None) or uuid4().hex
            self.platform.log("agent.tool.executed", actor, trace_id=trace, tool=name)
            return {"result": result, "trace_id": trace}
        except HTTPException as error:
            code = error.detail
            raise BridgeError(
                code
                if isinstance(code, str) and re.fullmatch(r"[a-z0-9_]{1,100}", code)
                else "agent_tool_failed"
            ) from None


class HTTPMCP:
    def __init__(self, platform):
        self.platform = platform
        self.manager = None

    @asynccontextmanager
    async def run(self):
        manager = StreamableHTTPSessionManager(
            LocalBridge(self.platform).server(),
            stateless=True,
            json_response=True,
            max_request_body_size=128 * 1024,
        )
        async with manager.run():
            self.manager = manager
            try:
                yield
            finally:
                self.manager = None

    async def __call__(self, scope, receive, send):
        request = Request(scope, receive)
        # HostAllowlist validates Host using the same live deployment settings
        # as every other route. Browser origins must additionally match it.
        origin = request.headers.get("origin")
        try:
            if origin:
                parsed = urlsplit(origin)
                if (
                    parsed.scheme not in {"http", "https"}
                    or parsed.netloc.lower() != request.headers.get("host", "").lower()
                    or parsed.username
                    or parsed.password
                    or parsed.query
                    or parsed.fragment
                    or parsed.path not in {"", "/"}
                ):
                    raise HTTPException(403, "mcp_origin_forbidden")
            if not request.headers.get("authorization", "").startswith("Bearer ws_"):
                raise HTTPException(401, "agent_credential_required")
            await asyncio.to_thread(self.platform.actor, request)
            if self.manager is None:
                raise HTTPException(503, "mcp_unavailable")
        except (HTTPException, ValueError) as error:
            status = error.status_code if isinstance(error, HTTPException) else 403
            detail = error.detail if isinstance(error, HTTPException) else "mcp_origin_forbidden"
            response = JSONResponse(
                {"detail": detail},
                status_code=status,
                headers={"WWW-Authenticate": "Bearer"} if status == 401 else None,
            )
            await response(scope, receive, send)
            return
        await self.manager.handle_request(scope, receive, send)
