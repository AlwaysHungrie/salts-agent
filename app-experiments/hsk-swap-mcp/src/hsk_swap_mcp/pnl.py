"""A wallet's profit and loss from its whole history on the explorer, valued at each transaction's own block.

Each transaction becomes the wallet's net flow per asset (native HSK and WHSK are one asset). Then, in block order:

- gas: HSK spent for nothing, a realized loss at average cost
- a liquidity transaction (sent to the position manager): tokens out are sold at market into that position, tokens
  back are bought at market from it, so each position has what went in and what came out
- a trade (some assets out, some in): worth what came in at market; that is both the proceeds of what went out and
  the cost of what came in
- only in: a deposit at market; only out: a withdrawal at market

Average cost per asset. Total P&L = value now - net deposits, which equals realized + unrealized + liquidity P&L.
"""

import asyncio
from collections import defaultdict
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Callable

from eth_utils import keccak

from .models import AssetPnl, LiquidityPnl, Pnl, Trade
from .positions import NATIVE, Services, Snapshot, money, read_positions, text

HSK = "hsk"
ZERO = "0x0000000000000000000000000000000000000000"
EPSILON = 1e-9
LIQUIDITY_EVENTS = {
    "0x" + keccak(text=sig).hex()
    for sig in ("IncreaseLiquidity(uint256,uint128,uint256,uint256)",
                "DecreaseLiquidity(uint256,uint128,uint256,uint256)",
                "Collect(uint256,address,uint256,uint256)")
}


@dataclass
class TxFlows:
    hash: str
    block: int
    time: str | None = None
    position: int = 0
    to: str | None = None
    ok: bool = True
    gas: Decimal = Decimal(0)
    flows: dict[str, Decimal] = field(default_factory=lambda: defaultdict(Decimal))


def collect_flows(wallet: str, whsk: str, txs: list[dict], transfers: list[dict], internals: list[dict],
                  symbols: dict[str, str]) -> list[TxFlows]:
    """Net flows per transaction from the explorer's three lists, oldest first. Fills `symbols` per asset."""
    wallet, whsk = wallet.lower(), whsk.lower()
    symbols[HSK] = "HSK"
    by_hash: dict[str, TxFlows] = {}

    def entry(h: str, block: int, time: str | None) -> TxFlows:
        if h not in by_hash:
            by_hash[h] = TxFlows(hash=h, block=block, time=time)
        return by_hash[h]

    def side(item: dict, key: str) -> str:
        return ((item.get(key) or {}).get("hash") or "").lower()

    for t in txs:
        e = entry(t["hash"], int(t["block_number"]), t.get("timestamp"))
        e.ok, e.to, e.position = t.get("status") == "ok", side(t, "to") or None, int(t.get("position") or 0)
        value = Decimal(int(t.get("value") or 0)).scaleb(-18)
        if side(t, "from") == wallet:
            e.gas = Decimal(int((t.get("fee") or {}).get("value") or 0)).scaleb(-18)
            if e.ok:
                e.flows[HSK] -= value
        if side(t, "to") == wallet and e.ok:
            e.flows[HSK] += value
    for t in transfers:
        total, token = t.get("total") or {}, t.get("token") or {}
        if total.get("value") is None:
            continue
        address = (token.get("address_hash") or token.get("address") or "").lower()
        asset = HSK if address == whsk else address
        # Minting or burning WHSK is wrapping: one asset, two forms.
        if asset == HSK and ZERO in (side(t, "from"), side(t, "to")):
            continue
        symbols.setdefault(asset, token.get("symbol") or address[:8])
        amount = Decimal(int(total["value"])).scaleb(-int(total.get("decimals") or token.get("decimals") or 18))
        e = entry(t["transaction_hash"], int(t["block_number"]), t.get("timestamp"))
        if side(t, "from") == wallet:
            e.flows[asset] -= amount
        if side(t, "to") == wallet:
            e.flows[asset] += amount
    for t in internals:
        # Value moving to or from WHSK itself is wrapping or unwrapping (a vault does both inside its own calls).
        if not t.get("success", True) or whsk in (side(t, "from"), side(t, "to")):
            continue
        value = Decimal(int(t.get("value") or 0)).scaleb(-18)
        e = entry(t["transaction_hash"], int(t["block_number"]), t.get("timestamp"))
        if side(t, "from") == wallet:
            e.flows[HSK] -= value
        if side(t, "to") == wallet:
            e.flows[HSK] += value
    return sorted(by_hash.values(), key=lambda e: (e.block, e.position, e.hash))


@dataclass
class Book:
    qty: float = 0.0
    cost: float = 0.0
    realized: float = 0.0

    def average(self, market: float | None) -> float:
        return self.cost / self.qty if self.qty > EPSILON else (market or 0.0)


@dataclass
class LpBook:
    deposited: float = 0.0
    withdrawn: float = 0.0


@dataclass
class Ledger:
    books: dict[str, Book] = field(default_factory=lambda: defaultdict(Book))
    liquidity: dict[int | None, LpBook] = field(default_factory=lambda: defaultdict(LpBook))
    deposits: float = 0.0
    withdrawals: float = 0.0
    gas_hsk: Decimal = Decimal(0)
    gas_usd: float = 0.0
    trades: list[Trade] = field(default_factory=list)
    unpriced: set[str] = field(default_factory=set)
    filled_gaps: set[str] = field(default_factory=set)

    def acquire(self, asset: str, qty: float, cost: float) -> None:
        book = self.books[asset]
        book.qty += qty
        book.cost += cost

    def dispose(self, asset: str, qty: float, proceeds: float, market: float | None) -> None:
        book = self.books[asset]
        if book.qty < qty - max(EPSILON, qty * 1e-9):
            # The history holds less than the wallet spent (cut short, or the explorer missed an arrival): count
            # the gap as a deposit at market so the totals stay whole.
            gap = qty - max(book.qty, 0.0)
            self.deposits += gap * (market or 0.0)
            self.acquire(asset, gap, gap * (market or 0.0))
            self.filled_gaps.add(asset)
        average = book.average(market)
        book.realized += proceeds - average * qty
        book.cost -= average * qty
        book.qty -= qty


def run_ledger(events: list[TxFlows], price: Callable[[str, int], float | None], position_manager: str, whsk: str,
               liquidity_ids: dict[str, int], symbols: dict[str, str]) -> Ledger:
    npm, whsk = position_manager.lower(), whsk.lower()
    ledger = Ledger()

    def market(asset: str, block: int) -> float | None:
        p = price(asset, block)
        if p is None:
            ledger.unpriced.add(asset)
        return p

    def worth(side: dict[str, float], block: int) -> dict[str, float]:
        return {a: q * (market(a, block) or 0.0) for a, q in side.items()}

    for e in events:
        if e.gas:
            p = market(HSK, e.block)
            ledger.gas_hsk += e.gas
            ledger.gas_usd += float(e.gas) * (p or 0.0)
            ledger.dispose(HSK, float(e.gas), 0.0, p)
        # Wrapping or unwrapping HSK moves value between two halves of one asset.
        if not e.ok or e.to == whsk:
            continue
        outs = {a: float(-q) for a, q in e.flows.items() if q < 0}
        ins = {a: float(q) for a, q in e.flows.items() if q > 0}
        if not outs and not ins:
            continue
        out_worth, in_worth = worth(outs, e.block), worth(ins, e.block)
        if e.to == npm:
            book = ledger.liquidity[liquidity_ids.get(e.hash)]
            for a, q in outs.items():
                ledger.dispose(a, q, out_worth[a], price(a, e.block))
                book.deposited += out_worth[a]
            for a, q in ins.items():
                ledger.acquire(a, q, in_worth[a])
                book.withdrawn += in_worth[a]
        elif outs and ins:
            value = sum(in_worth.values()) or sum(out_worth.values())
            for a, q in outs.items():
                ledger.dispose(a, q, value * share(out_worth, a), price(a, e.block))
            for a, q in ins.items():
                ledger.acquire(a, q, value * share(in_worth, a))
            ledger.trades.append(Trade(
                tx=e.hash, block=e.block, time=e.time, value_usd=money(value) if value else None,
                sold={symbols.get(a, a): text(Decimal(str(q))) for a, q in outs.items()},
                bought={symbols.get(a, a): text(Decimal(str(q))) for a, q in ins.items()}))
        elif ins:
            for a, q in ins.items():
                ledger.acquire(a, q, in_worth[a])
                ledger.deposits += in_worth[a]
        else:
            for a, q in outs.items():
                ledger.dispose(a, q, out_worth[a], price(a, e.block))
                ledger.withdrawals += out_worth[a]
    return ledger


def share(worths: dict[str, float], asset: str) -> float:
    total = sum(worths.values())
    return worths[asset] / total if total else 1 / len(worths)


async def liquidity_ids(svc: Services, events: list[TxFlows]) -> dict[str, int]:
    """Which position each liquidity transaction touched, from the position manager's events in its receipt."""
    npm = svc.net.position_manager.lower()
    hashes = [e.hash for e in events if e.to == npm and e.ok]
    receipts = await asyncio.gather(*(svc.chain.receipt(h) for h in hashes))
    found = {}
    for h, receipt in zip(hashes, receipts):
        for log in (receipt or {}).get("logs", []):
            topics = log.get("topics") or []
            if log.get("address", "").lower() == npm and len(topics) > 1 and topics[0] in LIQUIDITY_EVENTS:
                found[h] = int(topics[1], 16)
                break
    return found


async def compute_pnl(svc: Services, wallet: str) -> Pnl:
    explorer = svc.explorer
    (positions, snap), (txs, txs_all), (transfers, tr_all), (internals, in_all) = await asyncio.gather(
        read_positions(svc, wallet), explorer.transactions(wallet), explorer.token_transfers(wallet),
        explorer.internal_transactions(wallet))
    symbols: dict[str, str] = {}
    events = collect_flows(wallet, svc.net.whsk, txs, transfers, internals, symbols)

    needed = {(HSK, e.block) for e in events if e.gas} | {(a, e.block) for e in events for a in e.flows}
    keys = sorted(needed)
    values = await asyncio.gather(*(svc.pricer.usd(svc.net.whsk if a == HSK else a, b) for a, b in keys))
    prices = dict(zip(keys, values))
    ledger = run_ledger(events, lambda a, b: prices.get((a, b)), svc.net.position_manager, svc.net.whsk,
                        await liquidity_ids(svc, events), symbols)
    return assemble(svc, wallet, positions.total_value_usd, snap, ledger, symbols, txs_all and tr_all and in_all)


def held(snap: Snapshot, whsk: str) -> dict[str, tuple[Decimal, float | None, str]]:
    """Live amount, price and symbol per ledger asset: native HSK and WHSK together as HSK."""
    out: dict[str, tuple[Decimal, float | None, str]] = {}
    for key, amount in snap.amounts.items():
        asset = HSK if key in (NATIVE, whsk) else key
        before = out.get(asset, (Decimal(0), snap.prices[key], "HSK" if asset == HSK else snap.symbols[key]))
        out[asset] = (before[0] + amount, before[1], before[2])
    return out


def assemble(svc: Services, wallet: str, total_value: float, snap: Snapshot, ledger: Ledger,
             symbols: dict[str, str], complete: bool) -> Pnl:
    whsk = svc.net.whsk.lower()
    live = held(snap, whsk)
    warnings: list[str] = []
    assets: list[AssetPnl] = []
    for asset in sorted(set(ledger.books) | set(live), key=lambda a: (a != HSK, symbols.get(a, a))):
        book = ledger.books.get(asset, Book())
        amount, price, symbol = live.get(asset, (Decimal(0), None, symbols.get(asset, asset[:8])))
        value = float(amount) * price if price is not None else None
        if abs(float(amount) - book.qty) > max(1e-6, abs(book.qty) * 1e-6):
            warnings.append(f"{symbol}: history accounts for {book.qty:.6g}, the chain holds {text(amount)}; the "
                            "explorer may be a few blocks behind, or tokens arrived without a transfer it indexed")
        if not amount and abs(book.realized) < EPSILON:
            continue
        assets.append(AssetPnl(
            symbol=symbol, token=None if asset == HSK else asset, amount=text(amount),
            average_cost_usd=money(book.cost / book.qty) if book.qty > EPSILON else None,
            price_usd=money(price), value_usd=money(value), cost_basis_usd=round(book.cost, 6),
            unrealized_usd=money(value - book.cost) if value is not None else None,
            realized_usd=round(book.realized, 6)))

    liquidity: list[LiquidityPnl] = []
    for token_id in sorted(set(ledger.liquidity) | set(snap.liquidity), key=lambda i: (i is None, i or 0)):
        book = ledger.liquidity.get(token_id, LpBook())
        is_open = token_id in snap.liquidity
        pair, value = snap.liquidity.get(token_id, (None, 0.0))
        if not is_open and not book.deposited and not book.withdrawn:
            continue
        liquidity.append(LiquidityPnl(
            token_id=token_id, pair=pair, open=is_open, deposited_usd=round(book.deposited, 6),
            withdrawn_usd=round(book.withdrawn, 6), value_usd=money(value),
            pnl_usd=money(value + book.withdrawn - book.deposited) if value is not None else None))

    if ledger.unpriced:
        names = sorted(symbols.get(a, a) for a in ledger.unpriced)
        warnings.append(f"no HSKswap price at some point for {', '.join(names)}; those flows count as $0")
    if ledger.filled_gaps:
        names = sorted(symbols.get(a, a) for a in ledger.filled_gaps)
        warnings.append(f"spent more {', '.join(names)} than the history shows arriving; the gap counts as a "
                        "deposit at market")
    if not complete:
        warnings.append(f"history longer than {svc.explorer.max_pages * 50} items per list; older transactions "
                        "are left out")

    net_deposits = ledger.deposits - ledger.withdrawals
    return Pnl(
        network=svc.net.name, wallet=wallet, block=snap.block, total_value_usd=round(total_value, 6),
        net_deposits_usd=round(net_deposits, 6), total_pnl_usd=round(total_value - net_deposits, 6),
        realized_usd=round(sum(a.realized_usd for a in assets), 6),
        unrealized_usd=round(sum(a.unrealized_usd or 0 for a in assets), 6),
        liquidity_pnl_usd=round(sum(p.pnl_usd or 0 for p in liquidity), 6),
        gas_spent_hsk=text(ledger.gas_hsk), gas_spent_usd=round(ledger.gas_usd, 6), assets=assets,
        liquidity=liquidity, trades=len(ledger.trades), recent_trades=ledger.trades[::-1][:10],
        history_complete=bool(complete), warnings=warnings, explorer=f"{svc.net.explorer}/address/{wallet}")
