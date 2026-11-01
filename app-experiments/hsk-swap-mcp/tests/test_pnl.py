from decimal import Decimal

import pytest

from hsk_swap_mcp.pnl import HSK, collect_flows, compute_pnl, run_ledger
from hsk_swap_mcp.positions import Services

from .conftest import NET, NPM, TOKEN, USDT, WALLET, WHSK, FakeChain, FakeExplorer, FakePricer

E18 = 10**18
ROUTER = "0x00000000000000000000000000000000000000e0"
FRIEND = "0x00000000000000000000000000000000000000f0"


def tx(h, block, frm, to, value=0, fee=0, status="ok"):
    return {"hash": h, "block_number": block, "timestamp": f"t{block}", "status": status, "position": 0,
            "from": {"hash": frm}, "to": {"hash": to}, "value": str(value), "fee": {"value": str(fee)}}


def transfer(h, block, token, symbol, frm, to, value, decimals=18):
    return {"transaction_hash": h, "block_number": block, "total": {"decimals": str(decimals), "value": str(value)},
            "token": {"address": token, "symbol": symbol, "decimals": str(decimals)},
            "from": {"hash": frm}, "to": {"hash": to}}


def internal(h, block, frm, to, value):
    return {"transaction_hash": h, "block_number": block, "success": True, "from": {"hash": frm}, "to": {"hash": to},
            "value": str(value)}


def ledger_for(txs, transfers=(), internals=(), prices=None, liquidity_ids=None):
    symbols = {}
    events = collect_flows(WALLET, WHSK, txs, list(transfers), list(internals), symbols)
    return run_ledger(events, lambda a, b: (prices or {}).get((a, b)), NPM, WHSK, liquidity_ids or {}, symbols)


async def test_deposit_trade_gas_withdrawal_add_up():
    explorer = FakeExplorer(
        txs=[tx("0x1", 1, FRIEND, WALLET, value=10 * E18),
             tx("0x2", 2, WALLET, ROUTER, value=4 * E18, fee=E18 // 100),
             tx("0x3", 3, WALLET, USDT)],
        transfers=[transfer("0x2", 2, USDT, "USDT", ROUTER, WALLET, 10 * E18),
                   transfer("0x3", 3, USDT, "USDT", WALLET, FRIEND, 2 * E18)])
    chain = FakeChain({(USDT, "balanceOf(address)", (WALLET,)): (8 * E18,),
                       (WHSK, "symbol()"): ("WHSK",), (WHSK, "decimals()"): (18,),
                       (USDT, "symbol()"): ("USDT",), (USDT, "decimals()"): (18,),
                       (NPM, "balanceOf(address)", (WALLET,)): (0,)},
                      block=1000, native=int(5.99 * E18))
    pricer = FakePricer({WHSK: {1: 2.0, 2: 2.5, 3: 2.5, 1000: 3.0}, USDT: 1.0})
    pnl = await compute_pnl(Services(net=NET, chain=chain, explorer=explorer, pricer=pricer), WALLET)

    assert pnl.total_value_usd == pytest.approx(5.99 * 3 + 8)
    assert pnl.net_deposits_usd == pytest.approx(20 - 2)
    assert pnl.total_pnl_usd == pytest.approx(7.97)
    # Gas at average cost (-0.02), 4 HSK bought at $2 sold for $10 (+2).
    assert pnl.realized_usd == pytest.approx(1.98)
    hsk = next(a for a in pnl.assets if a.symbol == "HSK")
    assert hsk.average_cost_usd == pytest.approx(2.0)
    assert hsk.unrealized_usd == pytest.approx(5.99 * 3 - 5.99 * 2)
    assert pnl.realized_usd + pnl.unrealized_usd + pnl.liquidity_pnl_usd == pytest.approx(pnl.total_pnl_usd)
    assert pnl.gas_spent_hsk == "0.01"
    assert pnl.trades == 1
    assert pnl.recent_trades[0].sold == {"HSK": "4"} and pnl.recent_trades[0].bought == {"USDT": "10"}
    assert pnl.recent_trades[0].value_usd == pytest.approx(10)
    assert pnl.warnings == []
    assert pnl.history_complete


def test_liquidity_in_and_out_is_tracked_per_position():
    prices = {(HSK, 1): 2.0, (HSK, 2): 2.0, (HSK, 3): 2.0, (USDT, 1): 1.0, (USDT, 2): 1.0, (USDT, 3): 1.0}
    ledger = ledger_for(
        txs=[tx("0x1", 1, FRIEND, WALLET, value=10 * E18), tx("0x2", 2, WALLET, NPM, value=5 * E18),
             tx("0x3", 3, WALLET, NPM)],
        transfers=[transfer("0x1", 1, USDT, "USDT", FRIEND, WALLET, 100 * E18),
                   transfer("0x2", 2, USDT, "USDT", WALLET, "0xpool", 50 * E18),
                   transfer("0x3", 3, USDT, "USDT", "0xpool", WALLET, 45 * E18)],
        internals=[internal("0x3", 3, NPM, WALLET, 6 * E18)],
        prices=prices, liquidity_ids={"0x2": 7, "0x3": 7})
    book = ledger.liquidity[7]
    assert book.deposited == pytest.approx(50 + 5 * 2)
    assert book.withdrawn == pytest.approx(45 + 6 * 2)
    assert ledger.deposits == pytest.approx(120)
    assert ledger.books[USDT].qty == pytest.approx(95)
    assert ledger.books[HSK].qty == pytest.approx(11)
    assert ledger.trades == []


def test_wrapping_and_failed_transactions_move_nothing_but_gas():
    prices = {(HSK, 1): 2.0, (HSK, 2): 2.0, (HSK, 3): 2.0}
    ledger = ledger_for(
        txs=[tx("0x1", 1, FRIEND, WALLET, value=10 * E18),
             tx("0x2", 2, WALLET, WHSK, value=3 * E18, fee=E18 // 10),
             tx("0x3", 3, WALLET, FRIEND, value=4 * E18, fee=E18 // 10, status="error")],
        prices=prices)
    assert ledger.withdrawals == 0
    assert ledger.books[HSK].qty == pytest.approx(9.8)
    assert ledger.books[HSK].realized == pytest.approx(-0.4)
    assert ledger.gas_hsk == Decimal("0.2")


def test_spending_more_than_history_shows_counts_the_gap_as_a_deposit():
    prices = {(TOKEN, 5): 3.0, (USDT, 5): 1.0}
    ledger = ledger_for(
        txs=[tx("0x5", 5, WALLET, ROUTER)],
        transfers=[transfer("0x5", 5, TOKEN, "TKN", WALLET, ROUTER, 2 * E18),
                   transfer("0x5", 5, USDT, "USDT", ROUTER, WALLET, 6 * E18)],
        prices=prices)
    assert ledger.filled_gaps == {TOKEN}
    assert ledger.deposits == pytest.approx(6)
    assert ledger.books[TOKEN].realized == pytest.approx(0)


def test_unpriced_assets_are_flagged():
    ledger = ledger_for(txs=[tx("0x1", 1, WALLET, ROUTER)],
                        transfers=[transfer("0x1", 1, TOKEN, "TKN", FRIEND, WALLET, E18)])
    assert ledger.unpriced == {TOKEN}
