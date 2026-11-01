"""USD prices from HSKswap's own pools. Stablecoins are $1; HSK (WHSK) is priced against the deepest stablecoin pool;
any other token against its deepest pool with WHSK or a stablecoin. A price at a past block reads that pool's slot0 at
that block (the RPC keeps history), so a trade is valued at the price of its day."""

import asyncio
from dataclasses import dataclass

from .chain import Block, Call, Chain
from .networks import FEE_TIERS, Network


@dataclass(frozen=True)
class Route:
    pool: str
    quote: str  # lowercase address of the token the price is read in
    token_is_token0: bool
    decimals: int
    quote_decimals: int


def pool_price(sqrt_price_x96: int, token_is_token0: bool, decimals: int, quote_decimals: int) -> float:
    """Quote tokens per one token from a pool's sqrtPriceX96 (token1 per token0 in base units, squared, over 2^192)."""
    raw = sqrt_price_x96 * sqrt_price_x96 / 2**192
    if token_is_token0:
        return raw * 10 ** (decimals - quote_decimals)
    return (1 / raw) * 10 ** (decimals - quote_decimals) if raw else 0.0


class Pricer:
    def __init__(self, chain: Chain, net: Network) -> None:
        self.chain = chain
        self.net = net
        self.whsk = net.whsk.lower()
        self._decimals: dict[str, int] = {}
        self._routes: dict[str, Route | None] = {}
        self._slot0: dict[tuple[str, Block], int | None] = {}
        self._lock = asyncio.Lock()

    async def decimals(self, token: str) -> int | None:
        token = token.lower()
        if token not in self._decimals:
            out = await self.chain.call(Call(token, "decimals()", (), ("uint8",)))
            if out is None:
                return None
            self._decimals[token] = out[0]
        return self._decimals[token]

    def remember_decimals(self, token: str, decimals: int) -> None:
        self._decimals[token.lower()] = decimals

    async def usd(self, token: str, block: Block) -> float | None:
        """Dollars per whole token at `block`, or None when no HSKswap pool prices it then."""
        token = token.lower()
        if token in self.net.stables:
            return 1.0
        route = await self.route(token)
        if route is None:
            return None
        sqrt_price = await self._sqrt_price(route.pool, block)
        if not sqrt_price:
            return None
        quote_usd = await self.usd(route.quote, block)
        if quote_usd is None:
            return None
        return pool_price(sqrt_price, route.token_is_token0, route.decimals, route.quote_decimals) * quote_usd

    async def route(self, token: str) -> Route | None:
        """The deepest pool pairing `token` with WHSK or a stablecoin, by the quote side's value in it today."""
        token = token.lower()
        async with self._lock:
            if token in self._routes:
                return self._routes[token]
        quotes = list(self.net.stables) if token == self.whsk else [*self.net.stables, self.whsk]
        pairs = [(q, fee) for q in quotes for fee in FEE_TIERS]
        get_pool = "getPool(address,address,uint24)"
        found = await self.chain.multicall(
            [Call(self.net.factory, get_pool, (token, q, fee), ("address",)) for q, fee in pairs])
        pools = [(q, out[0].lower()) for (q, _), out in zip(pairs, found) if out and int(out[0], 16)]
        best, best_depth = None, 0.0
        if pools:
            depths = await self.chain.multicall(
                [Call(q, "balanceOf(address)", (pool,), ("uint256",)) for q, pool in pools])
            for (q, pool), out in zip(pools, depths):
                q_dec, q_usd = await self.decimals(q), await self.usd(q, "latest")
                if not out or q_dec is None or q_usd is None:
                    continue
                depth = out[0] / 10**q_dec * q_usd
                if depth > best_depth:
                    best, best_depth = (q, pool, q_dec), depth
        route = None
        token_dec = await self.decimals(token)
        if best and token_dec is not None:
            q, pool, q_dec = best
            route = Route(pool=pool, quote=q, token_is_token0=token < q, decimals=token_dec, quote_decimals=q_dec)
        async with self._lock:
            self._routes[token] = route
        return route

    async def _sqrt_price(self, pool: str, block: Block) -> int | None:
        key = (pool, block)
        if key not in self._slot0:
            out = await self.chain.call(
                Call(pool, "slot0()", (), ("uint160", "int24", "uint16", "uint16", "uint16", "uint8", "bool")), block)
            # A past block before the pool existed answers nothing. "latest" is never kept: it moves.
            if block == "latest":
                return out[0] if out else None
            if len(self._slot0) > 50_000:
                self._slot0.clear()
            self._slot0[key] = out[0] if out else None
        return self._slot0[key]
