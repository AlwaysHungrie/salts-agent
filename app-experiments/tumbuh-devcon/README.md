# tumbuh-devcon

One page. Take a picture of a 1 L bottle after adding water, enter an email, get paid in USDC on Base.

1. The site keeps one picture (`data/reference.jpg`, a single overwritten file; no database). The first upload only seeds it.
2. A vision model (OpenRouter) compares the kept picture with the new one and estimates the extra ml. No bottle in either: "I couldn't verify you gave me any water." Near-identical pictures count as ~5 ml.
3. Price: ₹20 per litre (std Mumbai Bisleri 1 L) at a fixed 95 INR/USD, in `src/lib/pricing.ts`.
4. The email gets one agent in the fleet (looked up by email, never created twice). Its wallet is set to the Base network with USDC through the agent's API, then the funder wallet sends the USDC to the wallet's EVM address. The new picture replaces the kept one.

`CHAIN=base-sepolia` switches to Base Sepolia test USDC.

Setup: copy `.env.example` to `.env.local`, fill it, enable the **wallet capability** in the fleet settings, `pnpm dev` (port 3200).

Notes:
- Each submit issues the agent a fresh user API key (needed to set the wallet's network), replacing its previous one.
- The kept picture lives on local disk, so run it on a host with a writable filesystem (not Vercel serverless).
