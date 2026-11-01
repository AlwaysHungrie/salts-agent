from pydantic import BaseModel, Field


class Holding(BaseModel):
    symbol: str
    token: str | None = Field(description="Token contract; null for native HSK")
    amount: str = Field(description="Whole tokens, exact")
    price_usd: float | None = Field(description="Null when no HSKswap pool prices it")
    value_usd: float | None


class LiquidityPosition(BaseModel):
    token_id: int
    pool: str
    pair: str = Field(description="token0/token1")
    fee_tier: str = Field(description="e.g. 0.3%")
    in_range: bool
    price_range: str = Field(description="token1 per token0 between the range's ticks")
    current_price: str = Field(description="token1 per token0 now")
    amount0: str
    amount1: str
    uncollected_fee0: str
    uncollected_fee1: str
    value_usd: float | None = Field(description="Both amounts plus uncollected fees")
    uncollected_fees_usd: float | None


class Positions(BaseModel):
    network: str
    wallet: str
    vault_owner: str | None = Field(None, description="Set when `wallet` is a trading vault: the wallet that owns it")
    block: int = Field(description="Every number is read at this block")
    holdings: list[Holding]
    liquidity: list[LiquidityPosition]
    closed_liquidity_positions: int = Field(description="Position NFTs held with no liquidity and no fees left")
    holdings_value_usd: float
    liquidity_value_usd: float
    total_value_usd: float
    unpriced: list[str] = Field(description="Symbols left out of the totals: no HSKswap pool prices them")
    explorer: str


class AssetPnl(BaseModel):
    symbol: str
    token: str | None
    amount: str = Field(description="Held now (HSK includes WHSK)")
    average_cost_usd: float | None
    price_usd: float | None
    value_usd: float | None
    cost_basis_usd: float
    unrealized_usd: float | None
    realized_usd: float


class LiquidityPnl(BaseModel):
    token_id: int | None = Field(description="Null for liquidity transactions whose position could not be told")
    pair: str | None
    open: bool
    deposited_usd: float = Field(description="Tokens put in, valued when they went in")
    withdrawn_usd: float = Field(description="Tokens and fees taken out, valued when they came out")
    value_usd: float | None = Field(description="What it holds now, uncollected fees included; null when unpriced")
    pnl_usd: float | None


class Trade(BaseModel):
    tx: str
    block: int
    time: str | None
    sold: dict[str, str]
    bought: dict[str, str]
    value_usd: float | None


class Pnl(BaseModel):
    network: str
    wallet: str
    vault_owner: str | None = Field(None, description="Set when `wallet` is a trading vault: the wallet that owns it")
    block: int
    total_value_usd: float = Field(description="Holdings plus liquidity positions now")
    net_deposits_usd: float = Field(description="Value sent in minus value sent out, each at its own time")
    total_pnl_usd: float = Field(description="total_value_usd - net_deposits_usd. Gas is in it")
    realized_usd: float
    unrealized_usd: float
    liquidity_pnl_usd: float
    gas_spent_hsk: str
    gas_spent_usd: float
    assets: list[AssetPnl]
    liquidity: list[LiquidityPnl]
    trades: int
    recent_trades: list[Trade] = Field(description="Newest first, at most 10")
    history_complete: bool
    warnings: list[str]
    explorer: str


class VaultToken(BaseModel):
    symbol: str
    token: str
    allowed: bool
    max_per_trade: str = Field(description="Most one swap may sell, whole tokens")
    daily_limit: str = Field(description="Most sold per UTC day, whole tokens")
    remaining_today: str


class VaultStatus(BaseModel):
    owner: str
    vault: str | None = Field(description="Null until vault_create_tx has been signed and sent")
    owner_gas_hsk: str = Field(description="HSK on the owner's own wallet, which pays every vault transaction's gas")
    paused: bool | None
    max_slippage_bps: int | None = Field(description="Least a swap may get: the pool's price less fee less this")
    tokens: list[VaultToken] = Field(description="Every token ever given limits; only allowed ones trade")
    holdings: list[Holding]
    total_value_usd: float | None
    next: str | None = Field(description="What to do next, when something is missing")
    explorer: str | None


class PreparedTx(BaseModel):
    transaction: dict[str, str] = Field(description="Unsigned, for sign_evm_transaction as it is")
    summary: str
    next: str
