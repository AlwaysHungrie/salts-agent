"""JSON-RPC reads: plain eth_call, Multicall3 batches, balances and receipts. Every read names a block, so one answer
is one consistent snapshot."""

import asyncio
import itertools
from dataclasses import dataclass

import httpx
from eth_abi import decode, encode
from eth_utils import keccak, to_checksum_address

from .errors import ToolFailure
from .networks import MULTICALL3

Block = int | str
# The public RPC throttles bursts: back off and try again on these.
RETRY_STATUS = {429, 502, 503, 504}
RETRY_DELAYS = (0.5, 1.0, 2.0, 4.0)


def arg_types(sig: str) -> list[str]:
    """`f(address,(uint256,address))` -> ["address", "(uint256,address)"]: top-level types, tuples kept whole."""
    inner = sig[sig.index("(") + 1:-1]
    types, depth, start = [], 0, 0
    for i, ch in enumerate(inner):
        depth += ch == "("
        depth -= ch == ")"
        if ch == "," and depth == 0:
            types.append(inner[start:i])
            start = i + 1
    if inner:
        types.append(inner[start:])
    return types


@dataclass(frozen=True)
class Call:
    to: str
    sig: str
    args: tuple = ()
    returns: tuple[str, ...] = ()

    def data(self) -> bytes:
        return keccak(text=self.sig)[:4] + encode(arg_types(self.sig), list(self.args))

    def decode(self, raw: bytes) -> tuple | None:
        """The return values, or None when the call returned nothing it could be (no contract, a revert)."""
        try:
            return tuple(decode(list(self.returns), raw))
        except Exception:
            return None


def block_tag(block: Block) -> str:
    return hex(block) if isinstance(block, int) else block


class Chain:
    def __init__(self, rpc_url: str, client: httpx.AsyncClient) -> None:
        self.rpc_url = rpc_url
        self.client = client
        self._ids = itertools.count(1)
        self._gate = asyncio.Semaphore(8)

    async def rpc(self, method: str, params: list):
        async with self._gate:
            for attempt in range(len(RETRY_DELAYS) + 1):
                try:
                    payload = {"jsonrpc": "2.0", "id": next(self._ids), "method": method, "params": params}
                    res = await self.client.post(self.rpc_url, json=payload)
                    if res.status_code in RETRY_STATUS and attempt < len(RETRY_DELAYS):
                        await asyncio.sleep(RETRY_DELAYS[attempt])
                        continue
                    res.raise_for_status()
                    body = res.json()
                    break
                except httpx.TransportError as e:
                    if attempt < len(RETRY_DELAYS):
                        await asyncio.sleep(RETRY_DELAYS[attempt])
                        continue
                    raise ToolFailure("rpc_unavailable", f"HSK RPC {method} failed: {type(e).__name__}") from e
                except (httpx.HTTPError, ValueError) as e:
                    raise ToolFailure("rpc_unavailable", f"HSK RPC {method} failed: {type(e).__name__}") from e
        if "error" in body:
            error = body["error"]
            return RpcError(error.get("message", "error"), error.get("data"))
        return body["result"]

    async def block_number(self) -> int:
        return int(await self._ok("eth_blockNumber", []), 16)

    async def balance(self, address: str, block: Block) -> int:
        return int(await self._ok("eth_getBalance", [address, block_tag(block)]), 16)

    async def receipt(self, tx_hash: str) -> dict | None:
        return await self._ok("eth_getTransactionReceipt", [tx_hash])

    async def call(self, call: Call, block: Block = "latest", sender: str | None = None) -> tuple | None:
        """One eth_call, `sender` as msg.sender (to simulate what that wallet would get). None on a revert."""
        tx = {"to": call.to, "data": "0x" + call.data().hex()}
        if sender:
            tx["from"] = sender
        result = await self.rpc("eth_call", [tx, block_tag(block)])
        if isinstance(result, RpcError):
            return None
        return call.decode(bytes.fromhex(result.removeprefix("0x")))

    async def multicall(self, calls: list[Call], block: Block = "latest") -> list[tuple | None]:
        """Many calls in one eth_call through Multicall3; a call that fails is None, the rest still answer."""
        if not calls:
            return []
        batch = Call(MULTICALL3, "aggregate3((address,bool,bytes)[])", ([(c.to, True, c.data()) for c in calls],),
                     ("(bool,bytes)[]",))
        out = await self.call(batch, block)
        if out is None:
            raise ToolFailure("rpc_unavailable", "Multicall3 read failed")
        return [c.decode(raw) if ok else None for c, (ok, raw) in zip(calls, out[0])]

    async def prepare(self, sender: str, to: str, data: bytes, chain_id: int, value: int = 0) -> dict[str, str]:
        """An unsigned transaction from `sender`, simulated first: nonce (pending), gas (+20%) and EIP-1559 fees,
        or a legacy gas price on a chain without a base fee. Raises Reverted when it would fail."""
        tx = {"from": sender, "to": to, "data": "0x" + data.hex(), "value": hex(value)}
        gas = await self.rpc("eth_estimateGas", [tx])
        if isinstance(gas, RpcError):
            raise Reverted(gas.message, gas.data)
        nonce = await self._ok("eth_getTransactionCount", [sender, "pending"])
        latest = await self._ok("eth_getBlockByNumber", ["latest", False])
        out = {"chainId": str(chain_id), "to": to, "value": str(value), "data": tx["data"],
               "nonce": str(int(nonce, 16)), "gas": str(int(gas, 16) * 12 // 10)}
        if latest.get("baseFeePerGas"):
            tip = await self.rpc("eth_maxPriorityFeePerGas", [])
            tip = 10**9 if isinstance(tip, RpcError) else int(tip, 16)
            out["maxPriorityFeePerGas"] = str(tip)
            out["maxFeePerGas"] = str(2 * int(latest["baseFeePerGas"], 16) + tip)
        else:
            out["gasPrice"] = str(int(await self._ok("eth_gasPrice", []), 16))
        return out

    async def _ok(self, method: str, params: list):
        result = await self.rpc(method, params)
        if isinstance(result, RpcError):
            raise ToolFailure("rpc_unavailable", f"HSK RPC {method}: {result.message}")
        return result


class Reverted(Exception):
    """A transaction that would fail, with the node's message and revert data."""

    def __init__(self, message: str, data: str | None) -> None:
        super().__init__(message)
        self.message = message
        self.data = data


class RpcError:
    def __init__(self, message: str, data=None) -> None:
        self.message = message
        # Revert data (0x…), when the node gives it: the custom error a contract raised.
        self.data = data if isinstance(data, str) and data.startswith("0x") else None


def checksum(address: str) -> str:
    try:
        return to_checksum_address(address)
    except (ValueError, TypeError) as e:
        raise ToolFailure("invalid_input", f"not an EVM address: {address!r}") from e
