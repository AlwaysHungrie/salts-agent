import pytest

from hsk_swap_mcp.positions import Services, read_positions, text, tick_price

from .conftest import NET, NPM, TOKEN, USDT, WALLET, WHSK, FakeChain, FakeExplorer, FakePricer

E18 = 10**18
POOL = "0x00000000000000000000000000000000000000d0"
ZERO = "0x" + "00" * 20


def owner_only(value):
    def answer(block, sender):
        assert sender == WALLET, "position reads must simulate as the owner"
        return value
    return answer


def position(t0, t1, fee, lower, upper, liquidity):
    return (0, ZERO, t0, t1, fee, lower, upper, liquidity, 0, 0, 0, 0)


async def test_holdings_and_liquidity_at_one_block():
    factory = NET.factory.lower()
    chain = FakeChain({
        (WHSK, "balanceOf(address)", (WALLET,)): (E18,),
        (USDT, "balanceOf(address)", (WALLET,)): (0,),
        (TOKEN, "balanceOf(address)", (WALLET,)): (3 * E18,),
        (WHSK, "symbol()"): ("WHSK",), (WHSK, "decimals()"): (18,),
        (USDT, "symbol()"): ("USDT",), (USDT, "decimals()"): (18,),
        (TOKEN, "symbol()"): ("TKN",), (TOKEN, "decimals()"): (18,),
        (NPM, "balanceOf(address)", (WALLET,)): (2,),
        (NPM, "tokenOfOwnerByIndex(address,uint256)", (WALLET, 0)): (7,),
        (NPM, "tokenOfOwnerByIndex(address,uint256)", (WALLET, 1)): (8,),
        (NPM, "positions(uint256)", (7,)): position(TOKEN, USDT, 3000, -600, 600, 1000),
        (NPM, "positions(uint256)", (8,)): position(TOKEN, USDT, 3000, -600, 600, 0),
        (NPM, "collect((uint256,address,uint128,uint128))", ((7, WALLET, 2**128 - 1, 2**128 - 1),)):
            owner_only((E18, 0)),
        (NPM, "collect((uint256,address,uint128,uint128))", ((8, WALLET, 2**128 - 1, 2**128 - 1),)):
            owner_only((0, 0)),
        (NPM, "decreaseLiquidity((uint256,uint128,uint256,uint256,uint256))", ((7, 1000, 0, 0, 2**63),)):
            owner_only((2 * E18, 5 * E18)),
        (factory, "getPool(address,address,uint24)", (TOKEN, USDT, 3000)): (POOL,),
        (POOL, "slot0()"): (2**96, 0, 0, 0, 0, 0, True),
    }, block=1234, native=2 * E18)
    explorer = FakeExplorer(balances=[{"token": {"type": "ERC-20", "address": TOKEN, "symbol": "TKN",
                                                 "decimals": "18"}, "value": str(3 * E18)}])
    pricer = FakePricer({WHSK: 3.0, USDT: 1.0, TOKEN: 0.5})
    positions, snap = await read_positions(Services(net=NET, chain=chain, explorer=explorer, pricer=pricer), WALLET)

    assert positions.block == 1234
    assert {h.symbol: (h.amount, h.value_usd) for h in positions.holdings} == {
        "HSK": ("2", 6.0), "WHSK": ("1", 3.0), "TKN": ("3", 1.5)}
    [lp] = positions.liquidity
    assert lp.token_id == 7 and lp.pair == "TKN/USDT" and lp.fee_tier == "0.3%" and lp.in_range
    assert lp.amount0 == "2 TKN" and lp.amount1 == "5 USDT" and lp.uncollected_fee0 == "1 TKN"
    assert lp.value_usd == pytest.approx(3 * 0.5 + 5)
    assert lp.uncollected_fees_usd == pytest.approx(0.5)
    assert positions.closed_liquidity_positions == 1
    assert positions.total_value_usd == pytest.approx(10.5 + 6.5)
    assert positions.unpriced == []
    assert snap.liquidity == {7: ("TKN/USDT", pytest.approx(6.5))}


async def test_unpriced_tokens_stay_out_of_the_totals():
    chain = FakeChain({
        (TOKEN, "balanceOf(address)", (WALLET,)): (E18,),
        (WHSK, "symbol()"): ("WHSK",), (WHSK, "decimals()"): (18,),
        (USDT, "symbol()"): ("USDT",), (USDT, "decimals()"): (18,),
        (NPM, "balanceOf(address)", (WALLET,)): (0,),
    }, native=E18)
    explorer = FakeExplorer(balances=[{"token": {"type": "ERC-20", "address": TOKEN, "symbol": "TKN",
                                                 "decimals": "18"}, "value": str(E18)}])
    positions, _ = await read_positions(
        Services(net=NET, chain=chain, explorer=explorer, pricer=FakePricer({WHSK: 2.0})), WALLET)
    assert positions.total_value_usd == pytest.approx(2.0)
    assert positions.unpriced == ["TKN"]


def test_formatting():
    from decimal import Decimal
    assert text(Decimal("1.500")) == "1.5" and text(Decimal("10")) == "10"
    assert tick_price(0, 18, 6) == pytest.approx(1e12)
