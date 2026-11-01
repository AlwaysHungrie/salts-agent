import httpx
import pytest
from eth_abi import decode, encode
from eth_utils import keccak

from hsk_swap_mcp import chain as chain_mod
from hsk_swap_mcp.chain import Call, Chain, arg_types, checksum
from hsk_swap_mcp.errors import ToolFailure


def test_arg_types_keeps_tuples_whole():
    assert arg_types("collect((uint256,address,uint128,uint128))") == ["(uint256,address,uint128,uint128)"]
    assert arg_types("getPool(address,address,uint24)") == ["address", "address", "uint24"]
    assert arg_types("slot0()") == []


def test_call_data_is_selector_and_arguments():
    call = Call("0x" + "11" * 20, "balanceOf(address)", ("0x" + "22" * 20,), ("uint256",))
    data = call.data()
    assert data[:4] == keccak(text="balanceOf(address)")[:4] == bytes.fromhex("70a08231")
    assert decode(["address"], data[4:])[0] == "0x" + "22" * 20
    assert call.decode(encode(["uint256"], [7])) == (7,)
    assert call.decode(b"") is None


def test_checksum_refuses_junk():
    assert checksum("0xcc158a81f7e8a1a00b2e8201722feb5555b58a95") == "0xCc158a81f7e8A1a00b2E8201722FEB5555b58a95"
    with pytest.raises(ToolFailure) as e:
        checksum("not-an-address")
    assert e.value.code == "invalid_input"


def rpc_app(handler):
    async def respond(request: httpx.Request) -> httpx.Response:
        import json
        body = json.loads(request.content)
        return handler(body)
    return httpx.MockTransport(respond)


async def test_rpc_retries_throttled_requests(monkeypatch):
    monkeypatch.setattr(chain_mod, "RETRY_DELAYS", (0, 0))
    seen = []

    def handler(body):
        seen.append(body["method"])
        if len(seen) < 3:
            return httpx.Response(429)
        return httpx.Response(200, json={"jsonrpc": "2.0", "id": body["id"], "result": "0x10"})

    async with httpx.AsyncClient(transport=rpc_app(handler)) as client:
        assert await Chain("http://rpc", client).block_number() == 16
    assert seen == ["eth_blockNumber"] * 3


async def test_rpc_gives_up_with_a_tool_failure(monkeypatch):
    monkeypatch.setattr(chain_mod, "RETRY_DELAYS", (0,))
    async with httpx.AsyncClient(transport=rpc_app(lambda body: httpx.Response(503))) as client:
        with pytest.raises(ToolFailure) as e:
            await Chain("http://rpc", client).block_number()
    assert e.value.code == "rpc_unavailable"


async def test_multicall_batches_and_keeps_failures_apart():
    token = "0x" + "33" * 20

    def handler(body):
        tx, block = body["params"]
        assert block == "0x2a"
        data = bytes.fromhex(tx["data"][2:])
        assert data[:4] == keccak(text="aggregate3((address,bool,bytes)[])")[:4]
        (calls,) = decode(["(address,bool,bytes)[]"], data[4:])
        assert [c[0] for c in calls] == [token, token] and all(c[1] for c in calls)
        out = encode(["(bool,bytes)[]"], [[(True, encode(["uint8"], [18])), (False, b"")]])
        return httpx.Response(200, json={"jsonrpc": "2.0", "id": body["id"], "result": "0x" + out.hex()})

    async with httpx.AsyncClient(transport=rpc_app(handler)) as client:
        out = await Chain("http://rpc", client).multicall(
            [Call(token, "decimals()", (), ("uint8",)), Call(token, "symbol()", (), ("string",))], 42)
    assert out == [(18,), None]


async def test_call_returns_none_on_revert():
    def handler(body):
        return httpx.Response(200, json={"jsonrpc": "2.0", "id": body["id"],
                                         "error": {"code": 3, "message": "execution reverted"}})

    async with httpx.AsyncClient(transport=rpc_app(handler)) as client:
        assert await Chain("http://rpc", client).call(Call("0x" + "44" * 20, "slot0()", (), ("uint160",))) is None
