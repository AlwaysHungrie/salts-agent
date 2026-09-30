"""Call `ping` over stdio and/or HTTP. Usage: uv run python scripts/smoke.py [stdio|http|both]"""

import asyncio
import os
import sys

from mcp import Client
from mcp.client.stdio import StdioServerParameters
from mcp.client.streamable_http import streamable_http_client
from mcp.shared._httpx_utils import create_mcp_http_client

from recruiter_mcp.config import get_settings


async def run(client: Client, label: str) -> None:
    async with client:
        tools = await client.list_tools()
        res = await client.call_tool("ping", {})
        print(f"[{label}] tools={[t.name for t in tools.tools]} ping={res.structured_content}")


async def main(mode: str) -> None:
    s = get_settings()
    if mode in ("stdio", "both"):
        params = StdioServerParameters(
            command="uv", args=["run", "recruiter-mcp"], env={**os.environ, "MCP_TRANSPORT": "stdio"}
        )
        await run(Client(params), "stdio")
    if mode in ("http", "both"):
        url = f"http://{s.mcp_host}:{s.mcp_port}/mcp"
        http = create_mcp_http_client(headers={"Authorization": f"Bearer {s.mcp_auth_token}"})
        await run(Client(streamable_http_client(url, http_client=http)), "http")


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1] if len(sys.argv) > 1 else "both"))
