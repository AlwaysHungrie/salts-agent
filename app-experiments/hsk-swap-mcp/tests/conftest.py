"""Offline fakes: a chain answering calls by (address, signature, args), an explorer serving fixed lists, a pricer
with fixed prices per (token, block)."""

import pytest

from hsk_swap_mcp.chain import Call
from hsk_swap_mcp.networks import NETWORKS

NET = NETWORKS["testnet"]
WALLET = "0x00000000000000000000000000000000000000aa"
WHSK = NET.whsk.lower()
USDT = "0x98b6173a8b7dfc52ce8bc88f1184a918a1ccaa4f"
TOKEN = "0x00000000000000000000000000000000000000c0"
NPM = NET.position_manager.lower()


class FakeChain:
    def __init__(self, answers: dict, block: int = 1000, native: int = 0) -> None:
        # (address lowercase, sig, args) or (address, sig) -> tuple, or a callable(block, sender) -> tuple
        self.answers = answers
        self.block = block
        self.native = native
        self.receipts: dict[str, dict] = {}
        self.senders: list[tuple[str, str | None]] = []

    def _answer(self, call: Call, block, sender):
        args = tuple(a.lower() if isinstance(a, str) else a for a in call.args)
        for key in ((call.to.lower(), call.sig, args), (call.to.lower(), call.sig)):
            if key in self.answers:
                value = self.answers[key]
                return value(block, sender) if callable(value) else value
        return None

    async def block_number(self) -> int:
        return self.block

    async def balance(self, address: str, block) -> int:
        return self.native

    async def receipt(self, tx_hash: str):
        return self.receipts.get(tx_hash)

    async def call(self, call: Call, block="latest", sender=None):
        self.senders.append((call.sig, sender))
        return self._answer(call, block, sender)

    async def multicall(self, calls, block="latest"):
        return [self._answer(c, block, None) for c in calls]


class FakeExplorer:
    max_pages = 40

    def __init__(self, txs=(), transfers=(), internals=(), balances=()) -> None:
        self.lists = {"txs": list(txs), "transfers": list(transfers), "internals": list(internals)}
        self.balances = list(balances)

    async def transactions(self, wallet):
        return self.lists["txs"], True

    async def token_transfers(self, wallet):
        return self.lists["transfers"], True

    async def internal_transactions(self, wallet):
        return self.lists["internals"], True

    async def token_balances(self, wallet):
        return self.balances


class FakePricer:
    def __init__(self, prices: dict) -> None:
        # token lowercase -> price, or -> {block: price}
        self.prices = prices

    def remember_decimals(self, token, decimals) -> None:
        pass

    async def usd(self, token, block):
        p = self.prices.get(token.lower())
        return p.get(block) if isinstance(p, dict) else p


@pytest.fixture
def addresses():
    return {"wallet": WALLET, "whsk": WHSK, "usdt": USDT, "token": TOKEN, "npm": NPM}
