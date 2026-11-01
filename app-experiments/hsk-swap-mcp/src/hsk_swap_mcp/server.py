"""HSK Swap MCP: a wallet's HSKswap positions and P&L on HSK Chain (testnet by default), read live on every call, and
a trading vault per agent: a contract that holds the agent's trading funds and only swaps within limits the agent sets.
The server holds no key: it prepares unsigned transactions and the agent signs them with its own wallet."""

import functools
import json
import logging
import sys
import traceback
from typing import Annotated

import httpx
import uvicorn
from mcp.server.mcpserver import MCPServer
from mcp_types import CallToolResult, TextContent, ToolAnnotations
from pydantic import BaseModel, Field
from starlette.requests import Request
from starlette.responses import JSONResponse

from .auth import BearerAuthMiddleware
from .chain import Chain, checksum
from .config import get_settings
from .errors import ToolFailure
from .explorer import Explorer
from .models import Pnl, Positions, PreparedTx, VaultStatus
from .networks import NETWORKS
from .pnl import compute_pnl
from .positions import Services, read_positions
from .prices import Pricer
from .vault import create_tx, policy_tx, status, swap_tx, vault_of, withdraw_tx

log = logging.getLogger("hsk_swap_mcp")

_services: Services | None = None


def services() -> Services:
    global _services
    if _services is None:
        settings = get_settings()
        net = NETWORKS[settings.hsk_network]
        client = httpx.AsyncClient(timeout=settings.http_timeout_seconds, headers={"user-agent": "hsk-swap-mcp"})
        chain = Chain(settings.rpc_url or net.rpc, client)
        _services = Services(net=net, chain=chain,
                             explorer=Explorer(settings.explorer_api or net.explorer_api, client,
                                               settings.max_history_pages),
                             pricer=Pricer(chain, net))
    return _services


mcp = MCPServer(
    name="hsk-swap",
    instructions=(
        "HSKswap (a Uniswap V3 DEX) on HSK Chain, read live from the chain on every call, plus your trading vault. "
        "Reading: get_positions answers what a wallet holds now (coins, tokens, liquidity positions with range, "
        "amounts and uncollected fees); get_pnl answers how it has done (realized and unrealized P&L per token, per "
        "liquidity position, recent trades). Pass your own EVM address (wallet_address): when it owns a vault, both "
        "read the vault, which is where your trading happens. "
        "Trading: you trade only through your vault, a contract you own that holds the trading funds and refuses "
        "any swap outside its limits: allowed tokens, a per-trade and a daily limit per token, a max slippage "
        "against the pool price; output always stays in the vault and withdrawals go only to you. The user sets "
        "the limits by asking you; set them with vault_policy_tx exactly as asked, and never loosen them unless "
        "the user asks. Start with vault_status. Each vault_*_tx tool returns an unsigned transaction: sign it "
        "with sign_evm_transaction, broadcast it with send_transaction on the HSK testnet network, then build the "
        "next one. Fund the vault by sending HSK to its address with wallet_transfer. Gas is paid from your own "
        "wallet, so keep some HSK there. "
        "Dollar values count USDT and USDC as $1 and price everything else from HSKswap's own pools; on testnet "
        "those are test prices, not market prices: say so when you quote them. Mention any warnings a result "
        "carries."
    ),
    version="0.1.0",
)


def _error(code: str, message: str) -> CallToolResult:
    body = {"error": {"code": code, "message": message}}
    return CallToolResult(content=[TextContent(type="text", text=json.dumps(body))], is_error=True)


def tool_handler(name: str):
    """Failures as {code, message} errors, never tracebacks."""

    def decorate(fn):
        @functools.wraps(fn)
        async def wrapper(*args, **kwargs):
            try:
                return await fn(*args, **kwargs)
            except ToolFailure as e:
                log.info("tool %s failed: %s %s", name, e.code, e.message)
                return _error(e.code, e.message)
            except Exception as e:
                frames = "\n".join(
                    f"  {f.filename}:{f.lineno} in {f.name}" for f in traceback.extract_tb(e.__traceback__))
                log.error("tool %s crashed: %s\n%s", name, type(e).__name__, frames)
                return _error("internal_error", f"unexpected server error ({type(e).__name__}); see server logs")

        return wrapper

    return decorate


Wallet = Annotated[str, Field(description="EVM address (0x…) of the wallet to read")]
Owner = Annotated[str, Field(description="Your own EVM address (wallet_address): the vault's owner and signer")]
ReadVault = Annotated[bool, Field(description="When the address owns a trading vault, read the vault (default). "
                                              "False reads the address itself")]
READ_ONLY = ToolAnnotations(read_only_hint=True, destructive_hint=False, open_world_hint=True)
PREPARES = ToolAnnotations(read_only_hint=True, destructive_hint=False, open_world_hint=True)


async def target(wallet: str, read_vault: bool) -> tuple[str, str | None]:
    """The address to read, and its owner when that is a vault."""
    wallet = checksum(wallet)
    vault = await vault_of(services(), wallet) if read_vault else None
    return (checksum(vault), wallet) if vault else (wallet, None)


@mcp.tool(
    description=(
        "What a wallet holds on HSK Chain right now: native HSK and every token, with dollar values, and its "
        "HSKswap liquidity positions (pair, fee tier, price range, whether the price is in range, token amounts, "
        "uncollected fees, value). All read at one block. An address that owns a trading vault reads the vault."
    ),
    annotations=READ_ONLY,
)
@tool_handler("get_positions")
async def get_positions(wallet: Wallet, read_vault: ReadVault = True) -> Positions:
    address, owner = await target(wallet, read_vault)
    positions, _ = await read_positions(services(), address)
    positions.vault_owner = owner
    return positions


@mcp.tool(
    description=(
        "A wallet's profit and loss on HSK Chain: value now, net deposits, total P&L (value now minus net "
        "deposits, gas included), and per token its average cost, realized and unrealized P&L; per liquidity "
        "position what went in, what came out and P&L; gas spent; the 10 latest trades. Every past transaction is "
        "valued at the price of its own block. An address that owns a trading vault reads the vault (whose gas "
        "the owner pays, so it is not in the vault's P&L). Reads the whole history, so it takes a few seconds."
    ),
    annotations=READ_ONLY,
)
@tool_handler("get_pnl")
async def get_pnl(wallet: Wallet, read_vault: ReadVault = True) -> Pnl:
    address, owner = await target(wallet, read_vault)
    pnl = await compute_pnl(services(), address)
    pnl.vault_owner = owner
    return pnl


@mcp.tool(
    description=(
        "Your trading vault: its address, whether it is paused, its max slippage, each token's limits and what is "
        "left of today's, what it holds, and the HSK on your own wallet for gas. Says what to do next when the "
        "vault, its limits or its funds are missing. Start here."
    ),
    annotations=READ_ONLY,
)
@tool_handler("vault_status")
async def vault_status(owner: Owner) -> VaultStatus:
    return await status(services(), checksum(owner))


@mcp.tool(
    description=(
        "Prepare the transaction that creates your trading vault (one per wallet, owned by it for good). It starts "
        "with no token allowed, max slippage 1% and trading on. Sign with sign_evm_transaction, send with "
        "send_transaction, then vault_status shows its address."
    ),
    annotations=PREPARES,
)
@tool_handler("vault_create_tx")
async def vault_create_tx(owner: Owner) -> PreparedTx:
    return await create_tx(services(), checksum(owner))


class TokenLimitIn(BaseModel):
    token: str = Field(description="HSK (kept as WHSK), USDT, USDC, or a token address")
    allowed: bool = Field(True, description="False removes the token from trading")
    max_per_trade: str = Field("0", description="Most one swap may sell, in whole tokens, e.g. 0.5")
    daily_limit: str = Field("0", description="Most sold per UTC day, in whole tokens")


@mcp.tool(
    description=(
        "Prepare one transaction that changes your vault's limits, only as the user asked: allow a token with its "
        "per-trade and daily sell limits (a swap needs both its tokens allowed), disallow a token, set max "
        "slippage (0–1000 bps against the pool's current price), pause or unpause trading. One change per call "
        "(a token's limits, or max slippage, or pause): for several, call this once per change and send each "
        "before building the next. Sign with sign_evm_transaction, send with send_transaction."
    ),
    annotations=PREPARES,
)
@tool_handler("vault_policy_tx")
async def vault_policy_tx(
    owner: Owner,
    tokens: Annotated[list[TokenLimitIn] | None, Field(description="Token limits to set")] = None,
    max_slippage_bps: Annotated[int | None, Field(description="100 = 1%", ge=0, le=1000)] = None,
    paused: Annotated[bool | None, Field(description="True stops all swaps (withdrawals still work)")] = None,
) -> PreparedTx:
    items = [t.model_dump() for t in tokens or []]
    return await policy_tx(services(), checksum(owner), items, max_slippage_bps, paused)


@mcp.tool(
    description=(
        "Prepare a swap from your vault on HSKswap: sell an exact amount of one token for another through the "
        "best-priced pool, at no worse than the slippage you pass (or the vault's limit), output kept in the vault. "
        "Refuses up front what the vault would refuse (token not allowed, over a limit, paused, not enough held, "
        "price impact past the slippage limit) and says why. Sign with sign_evm_transaction, send with "
        "send_transaction."
    ),
    annotations=PREPARES,
)
@tool_handler("vault_swap_tx")
async def vault_swap_tx(
    owner: Owner,
    sell: Annotated[str, Field(description="Token to sell: HSK, USDT, USDC or an address")],
    buy: Annotated[str, Field(description="Token to buy")],
    amount: Annotated[str, Field(description="How much to sell, in whole tokens, e.g. 0.01")],
    slippage_bps: Annotated[int | None, Field(description="Tighter than the vault's limit, if wanted", ge=0,
                                              le=1000)] = None,
) -> PreparedTx:
    return await swap_tx(services(), checksum(owner), sell, buy, amount, slippage_bps)


@mcp.tool(
    description=(
        "Prepare a withdrawal from your vault to your own wallet (it can pay out to no one else). token HSK unwraps "
        "and sends native HSK; amount in whole tokens, or all. Sign with sign_evm_transaction, send with "
        "send_transaction."
    ),
    annotations=PREPARES,
)
@tool_handler("vault_withdraw_tx")
async def vault_withdraw_tx(
    owner: Owner,
    token: Annotated[str, Field(description="HSK, WHSK, USDT, USDC or an address")],
    amount: Annotated[str, Field(description="Whole tokens, or all")],
) -> PreparedTx:
    return await withdraw_tx(services(), checksum(owner), token, amount)


@mcp.custom_route("/healthz", methods=["GET"])
async def healthz(_: Request) -> JSONResponse:
    return JSONResponse({"ok": True, "network": NETWORKS[get_settings().hsk_network].name})


def build_http_app():
    settings = get_settings()
    if not settings.mcp_auth_token:
        raise SystemExit("MCP_AUTH_TOKEN is required for the http transport")
    app = mcp.streamable_http_app(host=settings.mcp_host)
    return BearerAuthMiddleware(app, settings.mcp_auth_token)


def main() -> None:
    logging.basicConfig(stream=sys.stderr, level=logging.INFO)
    logging.getLogger("httpx").setLevel(logging.WARNING)
    settings = get_settings()
    log.info("network %s", NETWORKS[settings.hsk_network].name)
    if settings.mcp_transport == "stdio":
        mcp.run("stdio")
    else:
        uvicorn.run(build_http_app(), host=settings.mcp_host, port=settings.mcp_port)


if __name__ == "__main__":
    main()
