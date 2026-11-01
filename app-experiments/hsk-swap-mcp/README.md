# HSK Swap MCP

MCP server that shows a wallet's [HSKswap](https://app.hskswap.com) positions and P&L on HSK Chain. It runs on your
own computer in testnet mode (chain 133) by default. Every tool call reads the chain live; nothing is cached between
calls except past prices, which never change.

It only reads. It holds no key, signs nothing and cannot trade.

Python 3.12, `uv`. Chain reads go through the public RPC. History comes from the network's Blockscout API.

| | Testnet (default) | Mainnet |
|---|---|---|
| RPC | `https://testnet.hsk.xyz` | `https://mainnet.hsk.xyz` |
| Explorer + API | `https://testnet-explorer.hskchain.net` | `https://hsk.blockscout.com` |

HSKswap's own docs give the testnet explorer as `testnet-explorer.hsk.xyz`. That host does not resolve; use the
`hskchain.net` one above.

## Commands

```sh
cp .env.example .env          # set MCP_AUTH_TOKEN: openssl rand -hex 24
uv sync
uv run hsk-swap-mcp           # http on 127.0.0.1:8390/mcp (per .env); GET /healthz is open
uv run pytest -q              # offline, fake chain and explorer
uv run ruff check src tests
```

## Connecting an agent

The agent sends `Authorization: Bearer <MCP_AUTH_TOKEN>`. On the agent, go to **Capabilities** → **MCP servers** →
**Add an MCP server**. Choose **API key**, header `Authorization`, value `Bearer <token>`.

- **Agent running locally** (`wrangler dev`): URL `http://localhost:8390/mcp`. The agent accepts plain http only for
  `localhost`.
- **Deployed agent** (staging or production): it needs an https address that reaches your computer. Open a quick tunnel:

  ```sh
  cloudflared tunnel --url http://localhost:8390 --http-host-header localhost:8390
  ```

  Then use `https://<name>.trycloudflare.com/mcp` as the URL. `--http-host-header` is required: the MCP SDK refuses any
  Host other than localhost, as protection against DNS rebinding. A quick tunnel gets a new name every time it starts,
  so update the URL on the agent when it does.

## Tools

| Tool | What it answers |
|---|---|
| `get_positions {wallet}` | What the wallet holds now, all read at one block. Native HSK and every ERC-20 it holds, with price and value. Its HSKswap liquidity positions, each with pair, fee tier, price range, whether the price is in range, token amounts, uncollected fees and value. Also the totals, and which tokens have no price. |
| `get_pnl {wallet}` | Value now, net deposits and total P&L. Per token: amount, average cost, price, value, realized and unrealized P&L. Per liquidity position: what went in, what came out, value now and P&L. Also gas spent, the 10 latest trades, and warnings. |

`wallet` is any EVM address. For the agent's own wallet, use its EVM address from the Wallet capability (`wallet_address`).
About 5–15 s per call on testnet: the public RPC throttles bursts, and the server backs off and retries.

## How the numbers are worked out

**Prices.**
- USDT and USDC are $1.
- HSK (as WHSK) is priced from its deepest stablecoin pool on HSKswap.
- Any other token is priced from its deepest pool with WHSK or a stablecoin. "Deepest" means the most quote-token
  value in the pool today.
- The price is the pool's mid price (`slot0`), not what selling the whole balance would fetch. A large balance in a
  thin pool shows a value it could never be sold for.
- A token with no pool has no price. It is listed with a null price and left out of the totals.
- On testnet the pools hold test liquidity at made-up prices.

**Positions.** Balances and positions are read through Multicall3 at one block. For each position NFT, the server
simulates `decreaseLiquidity` and `collect` as the owner. This gives the exact amounts the position manager would pay
out, uncollected fees included, without reproducing V3's tick math.

**P&L.** The server reads the wallet's full history from the explorer: transactions, ERC-20 transfers and internal
transactions. It works out the net flow of each asset in each transaction; native HSK and WHSK count as one asset.
It values each flow at the pool price *at that transaction's block*, which the RPC can read for past blocks. Then it
goes through them in order, at average cost:

- Gas is HSK spent for nothing, booked as a realized loss.
- A liquidity transaction is one sent to the position manager. Tokens going in count as sold at market into that
  position. Tokens coming back count as bought at market from it. The position is found from the manager's
  `IncreaseLiquidity`, `DecreaseLiquidity` and `Collect` events in the receipt.
- A trade is a transaction with some assets out and some in. It is worth what came in at market. That amount is both
  the proceeds of what went out and the cost of what came in, so slippage and pool fees show up as realized P&L.
- A transaction with assets only coming in is a deposit, at market. One with assets only going out is a withdrawal.
- Wrapping or unwrapping HSK moves nothing.

Total P&L = value now − net deposits, which equals realized + unrealized + liquidity P&L. A token without a price
breaks that equality by its cost basis.

**Warnings** the result can carry:
- some flows had no price at their block, so they count as $0
- the wallet spent more of a token than its history shows arriving; the gap is counted as a deposit at market
- the history is longer than `MAX_HISTORY_PAGES` × 50 items per list, so older transactions are left out
- the explorer and the chain disagree on an amount; the explorer indexes a few seconds behind the chain

## Settings (`.env`)

`HSK_NETWORK` (`testnet` | `mainnet`), `RPC_URL` and `EXPLORER_API` to override the endpoints, `MCP_TRANSPORT`
(`stdio` | `http`), `MCP_HOST`, `MCP_PORT` (8390), `MCP_AUTH_TOKEN` (required for http), `MAX_HISTORY_PAGES` (40),
`HTTP_TIMEOUT_SECONDS` (20).

## Layout (`src/hsk_swap_mcp`)

| File | Role |
|---|---|
| `server.py` | The two tools, `{code, message}` errors, `/healthz`, transports |
| `networks.py` | Per network: RPC, explorer, factory, position manager, WHSK, stablecoins |
| `chain.py` | JSON-RPC with retries, ABI encoding by signature, Multicall3, `eth_call` as a sender |
| `explorer.py` | Blockscout API, paged |
| `prices.py` | Pool choice per token and price at any block |
| `positions.py` | Live holdings and liquidity positions |
| `pnl.py` | Flows per transaction, the average-cost ledger, the P&L result |
