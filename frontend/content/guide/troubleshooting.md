---
title: My agent is not replying
section: Help
order: 1
summary: What to do when your agent does not answer, shows an error, forgets things, ignores a photo, does not search or misses a reminder. Find the message or the problem you see, and follow the fix.
featured: true
---

Most problems with an agent come down to a handful of causes, such as an empty OpenRouter account, a setting that is switched off, or a conversation that has grown too long. This page lists what you might see, and what to do about it.

If your agent is replying in the browser, you can also just ask it what is wrong. It reads this guide and can check its own settings.

## When the reply is an error message

| If the reply says | Do this |
|---|---|
| "OpenRouter API key is missing" | Your agent has no key to pay for replies. Paste one into **OpenRouter** in your agent's **Settings**. See [Get an OpenRouter API key](/guide/openrouter). |
| "The provider rejected the call for credits or quota" | Your OpenRouter account is out of credit, or your key has reached its credit limit. Buy more credit on OpenRouter, or raise the limit on your key. |
| "The provider is rate limiting this key" | Too many requests were sent in a short time. Wait a minute and try again, or pick a different model in **Settings**. |
| "That turn was too large for the model's context" | The conversation has grown longer than the model can read. Send `!compact`, or start a new conversation with `!new`. |
| "This agent has reached its spending limit for this month" | Your agent is part of a fleet, and you have used this month's allowance. It starts working again next month, or as soon as the person who runs the fleet raises your limit. |
| "That turn did not finish" | Try again. If it keeps happening, send `!unstick`. |
| "I ran out of steps before finishing this" | The task needed more steps than one reply allows. Reply with "continue" and your agent carries on from where it stopped. |

## When there is no reply at all

**On Telegram**, check these in order:

1. You are in the **DM whitelist** in your agent's **Settings**. Your agent stays silent for anyone who is not.
2. In a group, you mentioned the bot, for example `@ada_salt_bot what did we decide?`, and the group is in the **Groups whitelist**.
3. The bot token in **Settings** is the latest one. If you sent `/revoke` to BotFather, the old token stopped working.

See [Connect your agent to Telegram](/guide/telegram) for how to set these up.

**On WhatsApp**, the reason is usually one of the rules Meta sets, such as the 24-hour window or a model that does not work on WhatsApp. See [WhatsApp gotchas](/guide/whatsapp-gotchas).

**In the browser**, or anywhere else, if your agent was working and has gone quiet, send `!unstick`. It fixes a reply that never finished, without deleting anything. Then ask your question again.

## When your agent does not do what you asked

| If your agent | Do this |
|---|---|
| Ignores a photo or screenshot | Switch on **Image input** in **Capabilities**, and pick a model that is not marked **(no image)** in **Settings**. |
| Ignores a file | Switch on **File ingest** in **Capabilities**. For Excel files, see [Add the spreadsheet analyst](/guide/salts-tools-analyst). |
| Ignores a voice note | Switch on **Audio input** in **Capabilities**. |
| Does not search the web, or says it cannot | Switch on **Web search** and set up a search engine. See [Set up web search](/guide/web-search). If you use salts-tools, check that your computer is on and awake. |
| Forgets what you told it in an earlier conversation | Switch on **Private Memory** in **Capabilities**. Without it, every new conversation starts from nothing. |
| Mixes up old and new instructions | The conversation has become long. Send `!new` to start fresh. See [Chat session hygiene](/guide/session-hygiene). |
| Does not use a connected app | Check that the app's card is switched on in **Capabilities**, and click **Refresh tools** on it. If it still fails, click **Disconnect** and then **Connect** again. A stronger model also helps. |
| Gets hard questions wrong | Pick a stronger model, or turn on **Extended reasoning**. See [Choose the right model](/guide/choosing-a-model). |

## When a reminder did not arrive

- Check that **Schedule tasks** is switched on in **Capabilities**.
- Ask your agent to list its scheduled tasks. A task belongs to the conversation it was set up in, so deleting that conversation also deletes the task.
- On WhatsApp, a reminder cannot reach you if you have not messaged your agent in the last 24 hours.

## When you cannot start a new conversation

Your agent has reached its limit of sessions. Delete a few old ones from the sidebar in your browser, or send `!clear`, which deletes the current conversation as it starts a new one. See [Usage limits](/guide/usage-limits).

## When replies cost more than you expected

Long conversations and connected apps are the usual reasons. See [What your agent costs](/guide/costs) to understand why, and [Must read: Managing costs and MCP tools](/guide/mcp-costs) to fix it.
