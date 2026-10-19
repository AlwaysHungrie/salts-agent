---
title: What your agent costs
section: Managing costs
order: 1
summary: How much a reply, a day and a month of using your agent costs, why some replies cost more than others, and where to see what you have spent.
featured: true
---

Salts has no subscription. Every reply your agent writes is paid for from the credit in your OpenRouter account, and you pay only for what your agent actually uses. This page gives you a feel for what that comes to.

## What you pay for

Models are paid by the token, and a token is roughly three quarters of a word. For every reply, you pay for:

- **Everything the model reads.** This is not just your latest message. It is the whole conversation so far, your custom instructions, and a description of every tool your agent has switched on.
- **Everything the model writes.** This is the reply itself, plus any thinking if **Extended reasoning** is on.

Reading is usually much cheaper per token than writing, but your agent reads far more than it writes. That is why a long conversation, or an agent with many apps connected, costs more per reply even when the reply is short.

## Some examples

These are rough figures for a reply in a short conversation, with a few capabilities switched on. They are based on OpenRouter's prices at the time of writing, and you can check today's prices on [openrouter.ai/models](https://openrouter.ai/models).

| Model | One everyday reply | 20 replies a day for a month |
|---|---|---|
| **DeepSeek V4 Flash (ds)**, the model your agent starts with | about $0.0005 | about $0.30 |
| **Claude Haiku 5.5 (haiku)** | about $0.0007 | about $0.40 |
| **Claude Sonnet 5.5 (sonnet)** | about $0.013 | about $8 |
| **Claude Opus 5.5 (opus)** | about $0.026 | about $16 |

The same reply can cost ten times as much in a conversation that has been going on for weeks, or with a large app such as Notion connected with every tool switched on. Images, voice notes and spreadsheet work use other models and are billed on top.

For most people, the $10 we recommend starting with lasts several months on the default model.

## Where to see what you spent

- **Under every reply.** Each reply in your browser shows what it cost.
- **On OpenRouter.** The **Activity** page in your OpenRouter account lists every call your agent made, what it cost and which model it used.
- **In Settings, for fleet agents.** If your agent is part of a fleet, its **Settings** shows how much of this month's spending limit is left.

## Keeping costs down

1. Set a credit limit on your OpenRouter key, so your spending can never go past it. See [Get an OpenRouter API key](/guide/openrouter).
2. Start a new conversation whenever you change the subject. See [Chat session hygiene](/guide/session-hygiene).
3. Switch on only the capabilities and app tools you use. See [Must read: Managing costs and MCP tools](/guide/mcp-costs).
4. Start with the default model, and only move to a stronger one when you need it. See [Choose the right model](/guide/choosing-a-model).
