import json

from mcp_types import CallToolResult
from starlette.testclient import TestClient

from hsk_swap_mcp import config, server


async def test_bad_wallet_is_an_invalid_input_error():
    result = await server.get_pnl(wallet="0x123")
    assert isinstance(result, CallToolResult) and result.is_error
    assert json.loads(result.content[0].text)["error"]["code"] == "invalid_input"


def test_http_needs_the_bearer_token(monkeypatch):
    monkeypatch.setenv("MCP_AUTH_TOKEN", "secret-token")
    config.get_settings.cache_clear()
    try:
        with TestClient(server.build_http_app(), base_url="http://localhost:8390") as client:
            assert client.get("/healthz").json() == {"ok": True, "network": "HSK Chain Testnet"}
            assert client.post("/mcp", json={}).status_code == 401
            assert client.post("/mcp", json={}, headers={"authorization": "Bearer wrong"}).status_code == 401
            ok = client.post("/mcp", headers={"authorization": "Bearer secret-token",
                                              "accept": "application/json, text/event-stream"},
                             json={"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
                                 "protocolVersion": "2025-06-18", "capabilities": {},
                                 "clientInfo": {"name": "test", "version": "0"}}})
            assert ok.status_code == 200
    finally:
        config.get_settings.cache_clear()
