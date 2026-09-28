---
title: Usage limits
section: Get started
order: 4
summary: How many agents, sessions and files you can have, and what to do when you reach a limit.
---

To keep Salts running smoothly for everyone, there are a few limits on how many agents you can create and how much each agent can hold. Most people never come close to them, but it is useful to know what they are.

## Your account

A Personal Account can create **1 agent**. If you need more, for example to create agents for your team, click **Need more agents?** on the home page and request a Fleet Account. See [Get a Fleet Account](/guide/fleet-account).

## Each agent

| Limit | How much |
|---|---|
| Sessions | 256 |
| File storage | 50 MB |
| People you can add under **Manage access** | 200 |

When your agent reaches its limit of sessions, it will not start a new one until you delete an old one. You can delete sessions from the sidebar in your browser, or send `!clear` on Telegram or WhatsApp, which deletes the old conversation as it starts a new one.

When your agent runs out of file storage, it will not accept new files until you make room. Deleting a session also deletes the files that were sent in it.

## Files you send

You can attach up to **4 files** to a single message. Each file can be up to:

| File type | Largest size |
|---|---|
| Text files | 1 MB |
| PDFs | 8 MB |
| Images | 10 MB |
| Audio and voice notes | 25 MB |

## Spending

Salts does not limit how much your agent spends. Every reply is paid for with your own OpenRouter API key, so the spending limit is the one you set on your key. See [Get an OpenRouter API key](/guide/openrouter).

If your agent is part of a fleet, the person who runs the fleet may have set a monthly spending limit for it. You can see how much of it is left in your agent's **Settings**.
