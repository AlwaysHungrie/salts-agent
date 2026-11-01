"""The trading vault (contracts/src/HskTradingVault.sol): one per owner, made by the network's HskVaultFactory.

The server never signs. Each *_tx function returns an unsigned transaction from the owner, already simulated (so a
refusal comes back as a reason, before anything is signed) with nonce, gas and fees filled in. The owner (an agent's
own wallet) signs it and broadcasts it.
"""

from decimal import Decimal, InvalidOperation

from eth_abi import decode
from eth_utils import keccak

from .chain import Call, Reverted, checksum
from .errors import ToolFailure
from .models import PreparedTx, VaultStatus, VaultToken
from .networks import FEE_TIERS
from .positions import Services, fee_tier, human, read_positions, text, token_meta

ZERO = "0x0000000000000000000000000000000000000000"
UINT128_MAX = 2**128 - 1

# The vault's and factory's custom errors, as the agent should read them.
ERRORS = {
    "NotOwner()": "only the vault's owner can do that",
    "IsPaused()": "the vault is paused; unpause it with vault_policy_tx first",
    "SameToken()": "sell and buy are the same token",
    "ZeroAmount()": "the amount must be more than 0",
    "TokenNotAllowed(address)": "token {0} is not allowed in the vault; allow it with vault_policy_tx",
    "OverTradeLimit(uint256)": "over the per-trade limit ({0} base units)",
    "OverDailyLimit(uint256)": "over today's limit ({0} base units left today)",
    "NoPool()": "no HSKswap pool for that pair and fee tier",
    "MinOutBelowFloor(uint256)": "the minimum output is below the vault's slippage floor ({0} base units)",
    "SlippageOverCap()": "max slippage can be at most 1000 bps (10%)",
    "CallFailed()": "a token transfer failed",
    "VaultExists(address)": "this owner already has a vault at {0}",
    "Error(string)": "{0}",
}
SELECTORS = {keccak(text=sig)[:4]: sig for sig in ERRORS}


def revert_reason(reverted: Reverted) -> str:
    data = bytes.fromhex((reverted.data or "0x")[2:])
    sig = SELECTORS.get(data[:4])
    if sig is None:
        return reverted.message
    types = sig[sig.index("(") + 1:-1]
    args = decode(types.split(","), data[4:]) if types else ()
    return ERRORS[sig].format(*args)


def factory(svc: Services) -> str:
    if not svc.net.vault_factory:
        raise ToolFailure("no_vaults", f"no vault factory on {svc.net.name}")
    return svc.net.vault_factory


async def vault_of(svc: Services, owner: str) -> str | None:
    if not svc.net.vault_factory:
        return None
    out = await svc.chain.call(Call(svc.net.vault_factory, "vaultOf(address)", (owner,), ("address",)))
    return out[0] if out and int(out[0], 16) else None


async def require_vault(svc: Services, owner: str) -> str:
    vault = await vault_of(svc, owner)
    if vault is None:
        raise ToolFailure("no_vault", f"{owner} has no trading vault yet; create one with vault_create_tx")
    return vault


async def resolve_token(svc: Services, token: str) -> tuple[str, str, int]:
    """(address, symbol, decimals) from a symbol (HSK, WHSK, a stablecoin) or an address. HSK means WHSK: the
    vault holds HSK wrapped."""
    name = token.strip()
    if name.upper() in ("HSK", "WHSK"):
        return svc.net.whsk.lower(), "WHSK", 18
    for address, symbol in svc.net.stables.items():
        if name.upper() == symbol.upper():
            name = address
    if not name.lower().startswith("0x"):
        known = ", ".join(["HSK", *svc.net.stables.values()])
        raise ToolFailure("invalid_input", f"unknown token {token!r}: use {known} or a token address")
    address = checksum(name).lower()
    meta = await token_meta(svc, [address], {})
    if address not in meta:
        raise ToolFailure("invalid_input", f"{address} is not an ERC-20 token on {svc.net.name}")
    return address, *meta[address]


def base_units(amount: str | float, decimals: int, what: str) -> int:
    try:
        value = Decimal(str(amount))
    except InvalidOperation as e:
        raise ToolFailure("invalid_input", f"{what} must be a number, got {amount!r}") from e
    raw = value.scaleb(decimals)
    if value < 0 or raw != raw.to_integral_value():
        raise ToolFailure("invalid_input", f"{what} must be positive with at most {decimals} decimals")
    return int(raw)


async def prepare(svc: Services, owner: str, to: str, data: bytes, summary: str) -> PreparedTx:
    try:
        tx = await svc.chain.prepare(owner, to, data, svc.net.chain_id)
    except Reverted as e:
        raise ToolFailure("would_revert", f"the transaction would fail: {revert_reason(e)}") from e
    return PreparedTx(
        transaction=tx, summary=summary,
        next=(f"Sign it with sign_evm_transaction, then broadcast the signed transaction with send_transaction on "
              f"{svc.net.name}. Build another vault transaction only after this one is sent."))


def encode_call(sig: str, *args) -> bytes:
    return Call(ZERO, sig, args).data()


# ------------------------------------------------------------------ status


async def status(svc: Services, owner: str) -> VaultStatus:
    vault = await vault_of(svc, owner)
    gas = await svc.chain.balance(owner, "latest")
    if vault is None:
        return VaultStatus(owner=owner, vault=None, owner_gas_hsk=text(human(gas, 18)), paused=None,
                           max_slippage_bps=None, tokens=[], holdings=[], total_value_usd=None,
                           next="No vault yet: create one with vault_create_tx.", explorer=None)
    paused, slippage, listed = await svc.chain.multicall([
        Call(vault, "paused()", (), ("bool",)), Call(vault, "maxSlippageBps()", (), ("uint16",)),
        Call(vault, "tokens()", (), ("address[]",))])
    addresses = [a.lower() for a in (listed[0] if listed else ())]
    meta = await token_meta(svc, addresses, {})
    reads = await svc.chain.multicall([c for a in addresses for c in (
        Call(vault, "limits(address)", (a,), ("bool", "uint128", "uint128")),
        Call(vault, "remainingToday(address)", (a,), ("uint256",)))])
    tokens = []
    for i, address in enumerate(addresses):
        limit, remaining = reads[2 * i] or (False, 0, 0), reads[2 * i + 1] or (0,)
        symbol, decimals = meta.get(address, (address[:8], 18))
        tokens.append(VaultToken(
            symbol=symbol, token=address, allowed=limit[0], max_per_trade=text(human(limit[1], decimals)),
            daily_limit=text(human(limit[2], decimals)), remaining_today=text(human(remaining[0], decimals))))
    positions, _ = await read_positions(svc, checksum(vault))
    hint = None
    if not any(t.allowed for t in tokens):
        hint = "No token is allowed yet: set limits with vault_policy_tx before trading."
    elif not positions.holdings:
        hint = "The vault is empty: send it HSK (wallet_transfer to the vault address); it keeps it as WHSK."
    return VaultStatus(
        owner=owner, vault=checksum(vault), owner_gas_hsk=text(human(gas, 18)), paused=paused[0] if paused else None,
        max_slippage_bps=slippage[0] if slippage else None, tokens=tokens, holdings=positions.holdings,
        total_value_usd=positions.total_value_usd, next=hint, explorer=f"{svc.net.explorer}/address/{vault}")


# ------------------------------------------------------------------ transactions


async def create_tx(svc: Services, owner: str) -> PreparedTx:
    existing = await vault_of(svc, owner)
    if existing:
        raise ToolFailure("vault_exists", f"{owner} already has a vault: {checksum(existing)}")
    return await prepare(svc, owner, factory(svc), encode_call("createVault()"),
                         f"Create {owner}'s trading vault. It starts with no token allowed, max slippage 100 bps "
                         "(1%), not paused. Owned by this wallet for good.")


async def policy_tx(svc: Services, owner: str, tokens: list[dict], max_slippage_bps: int | None,
                    paused: bool | None) -> PreparedTx:
    vault = await require_vault(svc, owner)
    calls, said = [], []
    for item in tokens:
        address, symbol, decimals = await resolve_token(svc, str(item.get("token", "")))
        allowed = bool(item.get("allowed", True))
        per_trade = base_units(item.get("max_per_trade", 0), decimals, f"{symbol} max_per_trade") if allowed else 0
        daily = base_units(item.get("daily_limit", 0), decimals, f"{symbol} daily_limit") if allowed else 0
        if allowed and not (0 < per_trade <= UINT128_MAX and 0 < daily <= UINT128_MAX):
            raise ToolFailure("invalid_input", f"{symbol}: max_per_trade and daily_limit must be more than 0")
        calls.append(encode_call("setTokenLimit(address,bool,uint128,uint128)", address, allowed, per_trade, daily))
        said.append(f"allow {symbol}: up to {text(human(per_trade, decimals))} per trade, "
                    f"{text(human(daily, decimals))} per day" if allowed else f"disallow {symbol}")
    if max_slippage_bps is not None:
        if not 0 <= max_slippage_bps <= 1000:
            raise ToolFailure("invalid_input", "max_slippage_bps must be between 0 and 1000 (10%)")
        calls.append(encode_call("setMaxSlippageBps(uint16)", max_slippage_bps))
        said.append(f"max slippage {max_slippage_bps} bps")
    if paused is not None:
        calls.append(encode_call("setPaused(bool)", paused))
        said.append("pause trading" if paused else "unpause trading")
    if not calls:
        raise ToolFailure("invalid_input", "nothing to change: pass tokens, max_slippage_bps or paused")
    if len(calls) > 1:
        raise ToolFailure("one_change_at_a_time",
                          f"{len(calls)} changes asked ({'; '.join(said)}). Ask for one per call: each is its own "
                          "short transaction, far less likely to be garbled when copied between signing and sending.")
    return await prepare(svc, owner, vault, calls[0], "Vault limits: " + said[0] + ".")


async def swap_tx(svc: Services, owner: str, sell: str, buy: str, amount: str, slippage_bps: int | None) -> PreparedTx:
    vault = await require_vault(svc, owner)
    (t_in, s_in, d_in), (t_out, s_out, d_out) = await resolve_token(svc, sell), await resolve_token(svc, buy)
    amount_in = base_units(amount, d_in, "amount")
    if amount_in == 0:
        raise ToolFailure("invalid_input", "amount must be more than 0")
    reads = await svc.chain.multicall([
        Call(vault, "paused()", (), ("bool",)), Call(vault, "maxSlippageBps()", (), ("uint16",)),
        Call(vault, "limits(address)", (t_in,), ("bool", "uint128", "uint128")),
        Call(vault, "limits(address)", (t_out,), ("bool", "uint128", "uint128")),
        Call(vault, "remainingToday(address)", (t_in,), ("uint256",)),
        Call(t_in, "balanceOf(address)", (vault,), ("uint256",))])
    paused, (max_bps,), limit_in, limit_out, (remaining,), (balance,) = (
        reads[0], reads[1] or (100,), reads[2] or (False, 0, 0), reads[3] or (False, 0, 0), reads[4] or (0,),
        reads[5] or (0,))
    refuse = None
    if paused and paused[0]:
        refuse = "the vault is paused; unpause it with vault_policy_tx first"
    elif not limit_in[0] or not limit_out[0]:
        missing = [s for s, lim in ((s_in, limit_in), (s_out, limit_out)) if not lim[0]]
        refuse = f"{' and '.join(missing)} not allowed in the vault; allow with vault_policy_tx"
    elif amount_in > limit_in[1]:
        refuse = f"over the per-trade limit of {text(human(limit_in[1], d_in))} {s_in}"
    elif amount_in > remaining:
        refuse = f"over today's limit: {text(human(remaining, d_in))} {s_in} left today"
    elif amount_in > balance:
        refuse = f"the vault holds only {text(human(balance, d_in))} {s_in}"
    if refuse:
        raise ToolFailure("refused_by_vault", refuse)

    # The best single pool: QuoterV2 per fee tier that has a pool (it reverts internally, so eth_call it).
    pools = await svc.chain.multicall([Call(svc.net.factory, "getPool(address,address,uint24)", (t_in, t_out, fee),
                                            ("address",)) for fee in FEE_TIERS])
    best = None
    for fee, pool in zip(FEE_TIERS, pools):
        if not pool or not int(pool[0], 16):
            continue
        quote = await svc.chain.call(Call(
            svc.net.quoter, "quoteExactInputSingle((address,address,uint256,uint24,uint160))",
            ((t_in, t_out, amount_in, fee, 0),), ("uint256", "uint160", "uint32", "uint256")))
        if quote and quote[0] and (best is None or quote[0] > best[1]):
            best = (fee, quote[0])
    if best is None:
        raise ToolFailure("no_pool", f"no HSKswap pool can trade {s_in} for {s_out}")
    fee, quoted = best
    floor = await svc.chain.call(Call(vault, "minOutFloor(address,address,uint24,uint256)",
                                      (t_in, t_out, fee, amount_in), ("uint256",)))
    floor = floor[0] if floor else 0
    if quoted < floor:
        raise ToolFailure("price_impact_too_high", (
            f"{amount} {s_in} would get {text(human(quoted, d_out))} {s_out}, below the "
            f"{text(human(floor, d_out))} the vault's {max_bps} bps slippage limit allows; trade less, or raise "
            "max_slippage_bps with vault_policy_tx"))
    bps = max_bps if slippage_bps is None else min(slippage_bps, max_bps)
    min_out = max(quoted * (10_000 - bps) // 10_000, floor)
    data = encode_call("swap(address,address,uint24,uint256,uint256)", t_in, t_out, fee, amount_in, min_out)
    return await prepare(svc, owner, vault, data, (
        f"Vault swap: sell {amount} {s_in} for about {text(human(quoted, d_out))} {s_out} (at least "
        f"{text(human(min_out, d_out))}) in the {fee_tier(fee)} pool. The {s_out} stays in the vault."))


async def withdraw_tx(svc: Services, owner: str, token: str, amount: str) -> PreparedTx:
    vault = await require_vault(svc, owner)
    native = token.strip().upper() == "HSK"
    address, symbol, decimals = await resolve_token(svc, token)
    held = await svc.chain.call(Call(address, "balanceOf(address)", (vault,), ("uint256",)))
    held = held[0] if held else 0
    raw = held if str(amount).strip().lower() == "all" else base_units(amount, decimals, "amount")
    if not 0 < raw <= held:
        raise ToolFailure("invalid_input", f"the vault holds {text(human(held, decimals))} {symbol}")
    data = encode_call("withdraw(address,uint256)", ZERO if native else address, raw)
    shown = "HSK" if native else symbol
    return await prepare(svc, owner, vault, data,
                         f"Withdraw {text(human(raw, decimals))} {shown} from the vault to its owner {owner}.")

