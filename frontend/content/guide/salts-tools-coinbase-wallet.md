---
title: Add Coinbase Wallet
section: salts-tools
order: 5
summary: Give your agent Coinbase's non-custodial USDC wallet on your computer, so it can pay Coinbase Business checkouts and paid APIs for you, within limits you set.
---

Coinbase Wallet gives your agent a crypto wallet it can pay with. It is Coinbase's own non-custodial wallet app, which runs on your computer: you sign in to it with your email, and Coinbase does not hold your funds. It holds USDC on Base, Polygon and Solana. Your agent can then pay a shop that takes payments through Coinbase Business, or a paid API, in USDC, for example "pay this checkout link" or "buy the report from this API".

This guide will help you switch Coinbase Wallet on, sign in to the wallet and set the limits that keep your spending safe. You will need salts-tools installed (see [Install salts-tools](/guide/salts-tools-install)). Coinbase Wallet does not need Docker or uv.

## 1. Switch Coinbase Wallet on

Run `npx salts-tools`, open your agent in the **Agents** tab and switch on **Coinbase Wallet**. The first time, salts-tools installs Coinbase's wallet app on your computer, which takes a minute or two. Your agent then has a new MCP server called **coinbase-wallet**, already connected. It needs **MCP servers** switched on for your agent; if that is off, your agent in the salts-tools screen shows it as **to do**, and pressing **Enter** switches it on.

## 2. Sign in and set your limits

Ask your agent "show my wallet". The wallet opens in a window on your computer, where you sign in with your email and a one-time code. While it is open, we recommend that you:

- **Set a spending limit per payment and per session.** Your agent can never go above them, and only you can change them, in the wallet window.
- **Add only what you are happy for your agent to spend.** Think of it as a prepaid card rather than your savings.

Your agent can only use the wallet while your computer is on and salts-tools is running.

## 3. Switch off what you do not need

Open the **coinbase-wallet** card on your agent's **Capabilities** page by clicking its name. We recommend two changes there:

- **Switch off Use in Telegram groups**, so that only you, in your private chats, can ask your agent to pay. Anyone in a group your agent is in could otherwise ask it to spend from your wallet.
- **Switch off the `send` and `trade` tools** unless you need them. Your agent does not need them to pay a checkout or an API, and with them off it cannot send your money to another address or swap it for another coin.

## You are done

Send your agent the payment link a shop gave you and ask it to pay. A Coinbase Business shop that accepts agent payments gives an **x402** link for this, and your agent pays it in USDC on Base, which the wallet uses by default. Your agent tells you what it paid, and the payment appears in the wallet window.
