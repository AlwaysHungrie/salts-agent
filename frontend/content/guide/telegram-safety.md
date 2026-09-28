---
title: Telegram safety tips
section: Telegram
order: 2
summary: Your bot is public. Here is what a stranger can do with it, and how to make sure they cannot.
---

Anyone on Telegram can search for your bot's username and press **Start**. Your whitelists are the only thing that decides whether your agent answers them. Get them wrong, and you have a public agent that runs on your money and knows things about you.

This can happen by accident, by emptying a whitelist to "see if it works". It can also be on purpose, because you want to share your agent with a group or with customers. This page covers both.

## What a stranger can do with your agent

If your agent answers someone it should not, that person can:

- **Spend your money.** Every reply is billed to your OpenRouter key. A script can send thousands of messages in an hour.
- **Use your tools.** If you connected an MCP server, such as Notion or GitHub, your agent uses it with your account and your permissions. A stranger can ask it to read, change or delete what is in there.
- **Read what your agent remembers.** Memory belongs to the agent, not to a conversation. Anything your agent saved about you can be repeated to anyone it talks to.
- **Fill up your agent.** Every new chat creates a session. When your agent reaches its limit of sessions, it stops accepting new chats, including yours.

You will see every one of these conversations in your sessions in the browser. You will usually see them after the money is spent.

## Keep it private

1. **Never leave a whitelist empty.** An empty **DM whitelist** allows every Telegram user. An empty **Groups whitelist** allows every group. A new agent starts with placeholders that match nobody. Replace them, do not delete them.
2. **Use numeric IDs for people.** A username can be changed, and a username you gave up can be claimed by someone else. A numeric ID never changes. Get it from [@userinfobot](https://t.me/userinfobot).
3. **Be careful with patterns.** An entry wrapped in slashes, like `/^team_/`, allows every username that matches it. Anyone can create a username that starts with `team_`.
4. **Allow groups you control.** Everyone in an allowed group can use your agent, including people who join later. Only allow groups where you decide who gets in.
5. **Keep the token private.** Anyone with your bot token can read every message sent to your bot. If it leaks, send `/revoke` to [@BotFather](https://t.me/BotFather) and save the new token in your agent's settings.
6. **Set a spending limit on OpenRouter.** Even with perfect whitelists, a limit on your key is what stops a mistake from becoming a bill. See [Get an OpenRouter key](/guide/openrouter).

## If you want a public agent

Sometimes a public bot is the point: a helper for a community, or a bot for your customers. That is allowed on Telegram. Build it as a separate agent, and treat it as if everything it knows will be read by strangers.

> [!warning]
> Never make your personal agent public. Create a new agent for the public one, with its own bot and its own OpenRouter key.

For that agent:

- Give it its own OpenRouter key with a low credit limit. When the limit is reached, the agent stops. That is what you want.
- Turn off **Private Memory**. It should not remember one person and repeat it to the next.
- Do not connect any MCP server that has access to your own accounts.
- Turn off **Schedule tasks**, unless you want strangers setting reminders that run on your key.
- Pick a cheap model.
- Use **Custom instructions** to say what the agent is for and what it should refuse.
- Add only the groups it is meant for to **Groups whitelist**, even if you open up direct messages.

Check its sessions in the browser every few days. You will see what people are asking it and what it costs you.

## Footnotes

1. A message from someone who is not allowed gets no reply and creates no session. It costs nothing. To them, your bot looks switched off.
2. WhatsApp works differently. Your agent only ever answers your own number there. See [WhatsApp gotchas](/guide/whatsapp-gotchas).
