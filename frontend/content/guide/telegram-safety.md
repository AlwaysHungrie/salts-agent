---
title: Telegram safety tips
section: Telegram
order: 2
summary: Your bot is public. Here is how to make sure only the right people can use it.
---

Anyone on Telegram can search for your bot's username and send it a message. Your agent only replies to the people and groups in its whitelists, so keeping those lists right is what keeps your agent private.

This matters because anyone your agent replies to can spend your OpenRouter credit, use the apps you connected to your agent with your account, and hear anything your agent remembers about you.

## Keep your agent private

1. **Never leave a whitelist empty.** An empty **DM whitelist** allows every Telegram user, and an empty **Groups whitelist** allows every group. Replace the placeholders with your own entries instead of deleting them.
2. **Use numeric IDs for people.** Usernames can be changed, and a username someone gives up can be claimed by someone else. A numeric ID never changes. You can get one from [@userinfobot](https://t.me/userinfobot).
3. **Be careful with patterns.** An entry wrapped in slashes, like `/^team_/`, allows every username that matches it, and anyone can create a username that starts with `team_`.
4. **Only allow groups you control.** Everyone in an allowed group can talk to your agent, including people who join later.
5. **Keep your bot token private.** If it leaks, send `/revoke` to [@BotFather](https://t.me/BotFather) and save the new token in your agent's settings.
6. **Set a spending limit on your OpenRouter key.** Even if something goes wrong, the limit stops it from turning into a large bill. See [Get an OpenRouter API key](/guide/openrouter).

## Making a public agent

Sometimes you might want a bot that anyone can use, for example as a helper for a community or for your customers. If you do, we strongly recommend creating a separate agent for it, with its own bot and its own OpenRouter key. Never make your personal agent public.

For the public agent, we recommend that you:

- Give it its own OpenRouter key with a low credit limit.
- Turn off **Private Memory**, so it does not repeat what one person told it to the next.
- Do not connect any apps that use your own accounts.
- Turn off **Schedule tasks**.
- Pick a cheap model.
- Use **Custom instructions** to explain what the agent is for and what it should refuse to do.

Check its sessions in the browser every few days to see what people are asking it and how much it is costing you.
