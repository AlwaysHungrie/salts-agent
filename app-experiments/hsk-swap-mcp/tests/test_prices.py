import pytest

from hsk_swap_mcp.prices import Pricer, pool_price

from .conftest import NET, USDT, WHSK, FakeChain

Q96 = 2**96


def test_pool_price_both_directions_and_decimals():
    assert pool_price(Q96, True, 18, 18) == pytest.approx(1.0)
    # token1 per token0 = 4 in base units: token0 costs 4 quote, token1 costs 1/4.
    assert pool_price(2 * Q96, True, 18, 18) == pytest.approx(4.0)
    assert pool_price(2 * Q96, False, 18, 18) == pytest.approx(0.25)
    # 1 token0 (18 decimals) = 2e-12 base units of a 6-decimal token1 per base unit -> $2 per whole token0.
    sqrt = int((2e-12) ** 0.5 * Q96)
    assert pool_price(sqrt, True, 18, 6) == pytest.approx(2.0, rel=1e-9)


async def test_stablecoins_are_a_dollar():
    pricer = Pricer(FakeChain({}), NET)
    assert await pricer.usd(USDT, 5) == 1.0


async def test_whsk_priced_from_its_deepest_stable_pool_at_each_block():
    shallow, deep = "0x" + "0a" * 20, "0x" + "0b" * 20
    # WHSK (0xca…) sorts after USDT (0x98…), so USDT is token0 and the pool states USDT-per-… inverted.
    def slot0(block, sender):
        price = {10: 4.0, 20: 9.0}[block]  # WHSK in USDT
        return (int((1 / price) ** 0.5 * Q96), 0, 0, 0, 0, 0, True)

    answers = {
        (NET.factory.lower(), "getPool(address,address,uint24)", (WHSK, USDT, 500)): (shallow,),
        (NET.factory.lower(), "getPool(address,address,uint24)", (WHSK, USDT, 3000)): (deep,),
        (USDT, "balanceOf(address)", (shallow,)): (10 * 10**18,),
        (USDT, "balanceOf(address)", (deep,)): (5000 * 10**18,),
        (USDT, "decimals()"): (18,),
        (WHSK, "decimals()"): (18,),
        (deep, "slot0()"): slot0,
    }
    pricer = Pricer(FakeChain(answers), NET)
    assert (await pricer.route(WHSK)).pool == deep
    assert await pricer.usd(WHSK, 10) == pytest.approx(4.0)
    assert await pricer.usd(WHSK, 20) == pytest.approx(9.0)


async def test_no_pool_means_no_price():
    pricer = Pricer(FakeChain({("0x" + "cc" * 20, "decimals()"): (18,)}), NET)
    assert await pricer.usd("0x" + "cc" * 20, 5) is None
