---
title: Connect your agent to Telegram
section: Telegram
order: 1
summary: Create a Telegram bot for your agent and talk to it from your phone, in a private chat or in a group.
featured: true
---

This guide will help you create a Telegram bot and connect it to your agent, so you can message your agent from Telegram just like you would message a friend. It takes about five minutes, and no technical skills are required.

## 1. Create a bot

Telegram bots are created using [@BotFather](https://t.me/BotFather), Telegram's official bot for making bots. Open Telegram, start a chat with it and follow these steps.

1. Send `/newbot`.
2. Enter a display name for your bot. This is the name people see in their chat list, so we recommend using your agent's name.
3. Enter a username for your bot. It must be unique on Telegram and must end in `bot`, for example `ada_salt_bot`.
4. BotFather will reply with a token that looks like `8412345678:AAH…`. Copy it.

> [!warning]
> Keep this token private. Anyone who has it can control your bot. If you think someone else has seen it, send `/revoke` to BotFather and paste the new token into your agent's settings.

## 2. Add the bot to your agent

Open your agent and go to **Settings**. In the **Telegram** section:

1. Paste the token into **Bot token**.
2. Enter your bot's username into **Bot username**, starting with `@`, for example `@ada_salt_bot`.
3. Save your settings.

Your agent connects to Telegram as soon as the token is saved.

## 3. Allow yourself to talk to it

Your bot is public, which means anyone on Telegram can find it by its username. To make sure your agent only answers you, it only replies to the people listed in **DM whitelist**.

A new agent starts with a placeholder in this list, `@no-user`, which matches nobody. Replace it with your own Telegram username, for example `@alice`. You can find your username in Telegram under **Settings**. If you do not have one, you can either set one there, or use your numeric Telegram ID instead, which you can get by sending any message to [@userinfobot](https://t.me/userinfobot).

> [!warning]
> Do not leave the list empty. An empty list allows **everyone** on Telegram to talk to your agent, and you pay for every reply. See [Telegram safety tips](/guide/telegram-safety) for more.

## 4. Say hello

Open a chat with your bot on Telegram, press **Start** and send a message. Your agent will answer in the same chat, and the conversation will also show up in your sessions in the browser.

## Using your agent in a group

1. Add your bot to the group like any other member.
2. Find the group's ID using [@userinfobot](https://t.me/userinfobot). It is a negative number like `-1001234567890`.
3. In your agent's settings, replace the placeholder `-1000000000000` in **Groups whitelist** with the group's ID.

In a group, your agent only replies to messages that mention it, for example `@ada_salt_bot what did we decide?`. If you reply to someone else's message and mention the bot, your agent will also read the message you replied to.

Everyone in the group shares one conversation with the agent. If your group uses topics, each topic gets its own conversation. To allow only one topic, add it as `group_id:topic_id`, for example `-1001234567890:42`.

## Footnotes

1. Each agent needs its own bot. If you have two agents, create two bots.
2. Your agent can only read photos, files and voice notes you send on Telegram if the matching capability is switched on in **Capabilities**.
3. If your bot does not answer, first check that you are in the whitelist. In a group, also check that you mentioned the bot.
