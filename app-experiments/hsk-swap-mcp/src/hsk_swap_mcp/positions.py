"""A wallet's positions now: native HSK, every ERC-20 it holds, and its HSKswap liquidity positions. All read at one
block. A liquidity position's amounts and uncollected fees come from simulating decreaseLiquidity and collect as the
owner, so they are exactly what the position manager would pay out."""

import asyncio
from dataclasses import dataclass, field
from decimal import Decimal

from .chain import Call, Chain
from .errors import ToolFailure
from .explorer import Explorer
from .models import Holding, LiquidityPosition, Positions
from .networks import Network
from .prices import Pricer

UINT128_MAX = 2**128 - 1
FAR_DEADLINE = 2**63
NATIVE = "native"


@dataclass
class Services:
    net: Network
    chain: Chain
    explorer: Explorer
    pricer: Pricer


@dataclass
class Snapshot:
    """What P&L needs from the positions: value per asset (lowercase token or NATIVE) and per position."""

    block: int
    amounts: dict[str, Decimal] = field(default_factory=dict)
    prices: dict[str, float | None] = field(default_factory=dict)
    symbols: dict[str, str] = field(default_factory=dict)
    liquidity: dict[int, tuple[str, float | None]] = field(default_factory=dict)  # token_id -> (pair, value)


def human(raw: int, decimals: int) -> Decimal:
    return Decimal(raw).scaleb(-decimals)


def text(amount: Decimal) -> str:
    s = format(amount, "f")
    return s.rstrip("0").rstrip(".") if "." in s else s


def fee_tier(fee: int) -> str:
    return f"{fee / 10000:g}%"


def tick_price(tick: int, dec0: int, dec1: int) -> float:
    """token1 per whole token0 at a tick."""
    return 1.0001**tick * 10 ** (dec0 - dec1)


def money(value: float | None) -> float | None:
    return None if value is None else round(value, 6)


async def token_meta(svc: Services, tokens: list[str], known: dict[str, tuple[str, int]]) -> dict[str, tuple[str, int]]:
    """Symbol and decimals per token: what the explorer said, else read from the token."""
    missing = [t for t in tokens if t not in known]
    calls = [c for t in missing for c in (Call(t, "symbol()", (), ("string",)), Call(t, "decimals()", (), ("uint8",)))]
    out = await svc.chain.multicall(calls)
    meta = dict(known)
    for i, t in enumerate(missing):
        sym, dec = out[2 * i], out[2 * i + 1]
        if dec is not None:
            meta[t] = (sym[0] if sym else t[:8], dec[0])
    for t, (_, dec) in meta.items():
        svc.pricer.remember_decimals(t, dec)
    return meta


async def read_positions(svc: Services, wallet: str) -> tuple[Positions, Snapshot]:
    net, chain = svc.net, svc.chain
    block = await chain.block_number()
    snap = Snapshot(block=block)

    # The explorer finds which tokens the wallet holds; the amounts are read from the chain at `block`.
    known: dict[str, tuple[str, int]] = {}
    try:
        for item in await svc.explorer.token_balances(wallet):
            token = item.get("token") or {}
            address = (token.get("address_hash") or token.get("address") or "").lower()
            if token.get("type") == "ERC-20" and address and token.get("decimals") is not None:
                known[address] = (token.get("symbol") or address[:8], int(token["decimals"]))
    except ToolFailure:
        pass
    tokens = list(dict.fromkeys([net.whsk.lower(), *net.stables, *known]))
    meta = await token_meta(svc, tokens, known)
    tokens = [t for t in tokens if t in meta]

    native_raw, balances = await asyncio.gather(
        chain.balance(wallet, block),
        chain.multicall([Call(t, "balanceOf(address)", (wallet,), ("uint256",)) for t in tokens], block))

    holdings: list[Holding] = []
    unpriced: list[str] = []
    rows = [(NATIVE, "HSK", native_raw, 18)] + [
        (t, meta[t][0], out[0], meta[t][1]) for t, out in zip(tokens, balances) if out and out[0]]
    prices = await asyncio.gather(*(svc.pricer.usd(net.whsk if key == NATIVE else key, block) for key, *_ in rows))
    for (key, symbol, raw, dec), price in zip(rows, prices):
        if not raw:
            continue
        amount = human(raw, dec)
        value = float(amount) * price if price is not None else None
        if price is None:
            unpriced.append(symbol)
        snap.amounts[key], snap.prices[key], snap.symbols[key] = amount, price, symbol
        holdings.append(Holding(symbol=symbol, token=None if key == NATIVE else key, amount=text(amount),
                                price_usd=money(price), value_usd=money(value)))

    liquidity, closed = await read_liquidity(svc, wallet, block, snap, unpriced)
    holdings_value = sum(h.value_usd or 0 for h in holdings)
    liquidity_value = sum(p.value_usd or 0 for p in liquidity)
    positions = Positions(
        network=net.name, wallet=wallet, block=block, holdings=holdings, liquidity=liquidity,
        closed_liquidity_positions=closed, holdings_value_usd=round(holdings_value, 6),
        liquidity_value_usd=round(liquidity_value, 6), total_value_usd=round(holdings_value + liquidity_value, 6),
        unpriced=sorted(set(unpriced)), explorer=f"{net.explorer}/address/{wallet}")
    return positions, snap


async def read_liquidity(svc: Services, wallet: str, block: int, snap: Snapshot,
                         unpriced: list[str]) -> tuple[list[LiquidityPosition], int]:
    net, chain, npm = svc.net, svc.chain, svc.net.position_manager
    count = await chain.call(Call(npm, "balanceOf(address)", (wallet,), ("uint256",)), block)
    if not count or not count[0]:
        return [], 0
    ids = await chain.multicall(
        [Call(npm, "tokenOfOwnerByIndex(address,uint256)", (wallet, i), ("uint256",)) for i in range(count[0])], block)
    ids = [out[0] for out in ids if out]
    infos = await chain.multicall([Call(npm, "positions(uint256)", (i,), (
        "uint96", "address", "address", "address", "uint24", "int24", "int24", "uint128", "uint256", "uint256",
        "uint128", "uint128")) for i in ids], block)

    async def one(token_id: int, info: tuple) -> LiquidityPosition | None:
        _, _, t0, t1, fee, lower, upper, liq = info[:8]
        t0, t1 = t0.lower(), t1.lower()
        fees = await chain.call(Call(npm, "collect((uint256,address,uint128,uint128))",
                                     ((token_id, wallet, UINT128_MAX, UINT128_MAX),), ("uint256", "uint256")),
                                block, sender=wallet)
        f0, f1 = fees or (0, 0)
        if not liq and not f0 and not f1:
            return None
        principal = (0, 0)
        if liq:
            principal = await chain.call(Call(
                npm, "decreaseLiquidity((uint256,uint128,uint256,uint256,uint256))",
                ((token_id, liq, 0, 0, FAR_DEADLINE),), ("uint256", "uint256")), block, sender=wallet) or (0, 0)
        meta = await token_meta(svc, [t0, t1], {})
        (s0, d0), (s1, d1) = meta.get(t0, (t0[:8], 18)), meta.get(t1, (t1[:8], 18))
        pool = await chain.call(Call(net.factory, "getPool(address,address,uint24)", (t0, t1, fee), ("address",)))
        pool = pool[0] if pool else ""
        slot0 = await chain.call(
            Call(pool, "slot0()", (), ("uint160", "int24", "uint16", "uint16", "uint16", "uint8", "bool")), block)
        tick = slot0[1] if slot0 else None
        p0, p1 = await asyncio.gather(svc.pricer.usd(t0, block), svc.pricer.usd(t1, block))
        a0, a1 = human(principal[0], d0), human(principal[1], d1)
        u0, u1 = human(f0, d0), human(f1, d1)
        value = fees_value = None
        if p0 is not None and p1 is not None:
            value = float(a0 + u0) * p0 + float(a1 + u1) * p1
            fees_value = float(u0) * p0 + float(u1) * p1
        else:
            unpriced.extend(s for s, p in ((s0, p0), (s1, p1)) if p is None)
        pair = f"{s0}/{s1}"
        snap.liquidity[token_id] = (pair, value)
        return LiquidityPosition(
            token_id=token_id, pool=pool, pair=pair, fee_tier=fee_tier(fee),
            in_range=tick is not None and lower <= tick < upper,
            price_range=f"{tick_price(lower, d0, d1):.6g} – {tick_price(upper, d0, d1):.6g} {s1} per {s0}",
            current_price=f"{tick_price(tick, d0, d1):.6g} {s1} per {s0}" if tick is not None else "unknown",
            amount0=f"{text(a0)} {s0}", amount1=f"{text(a1)} {s1}",
            uncollected_fee0=f"{text(u0)} {s0}", uncollected_fee1=f"{text(u1)} {s1}",
            value_usd=money(value), uncollected_fees_usd=money(fees_value))

    found = await asyncio.gather(*(one(i, info) for i, info in zip(ids, infos) if info))
    open_ = [p for p in found if p is not None]
    return open_, len(ids) - len(open_)
