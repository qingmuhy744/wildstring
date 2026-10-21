"""Check a deployed WildString Streamable HTTP MCP endpoint without printing secrets."""

import asyncio
import os
import sys
from urllib.parse import urlsplit

import httpx2
from mcp.client.session import ClientSession
from mcp.client.streamable_http import streamable_http_client


async def check(url: str, token: str) -> int:
    parts = urlsplit(url)
    if parts.scheme != "https" or not parts.hostname or parts.username or parts.password:
        raise ValueError("MCP remote smoke requires an HTTPS URL")
    no_proxy = os.environ.get("WILDSTRING_MCP_NO_PROXY", "").lower() in {
        "1",
        "true",
        "yes",
    }
    async with httpx2.AsyncClient(
        headers={"Authorization": f"Bearer {token}"}, trust_env=not no_proxy
    ) as http:
        async with streamable_http_client(url, http_client=http) as (
            read_stream,
            write_stream,
        ):
            async with ClientSession(read_stream, write_stream) as session:
                await session.initialize()
                result = await session.list_tools()
                if not result.tools:
                    raise RuntimeError("MCP endpoint returned no tools")
                print(f"MCP OK: {len(result.tools)} tools")
                print("Tools:", ", ".join(tool.name for tool in result.tools[:8]))
    return 0


def main() -> int:
    base = os.environ.get("WILDSTRING_MCP_HTTP_URL") or os.environ.get("WILDSTRING_MCP_URL", "")
    token = os.environ.get("WILDSTRING_MCP_TOKEN", "")
    url = base.rstrip("/") + ("" if base.rstrip("/").endswith("/mcp") else "/mcp")
    if not token:
        print("WILDSTRING_MCP_TOKEN is required", file=sys.stderr)
        return 2
    try:
        return asyncio.run(check(url, token))
    except ExceptionGroup as error:
        details = "; ".join(f"{type(item).__name__}: {item}" for item in error.exceptions)
        print(f"MCP remote smoke failed: {details}", file=sys.stderr)
        return 1
    except Exception as error:
        print(f"MCP remote smoke failed: {type(error).__name__}: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
