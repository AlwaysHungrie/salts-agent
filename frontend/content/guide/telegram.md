---
title: Connect your agent to Telegram
section: Telegram
order: 1
summary: Create a Telegram bot for your agent and talk to it from your phone, in a private chat or in a group.
featured: true
---

This guide will help you create a Telegram bot and connect it to your agent. Once it is done, you can message your agent from Telegram the same way you message a friend. It takes about five minutes. No technical skills are required.

> What to expect:
>
> - You will create a bot using @BotFather, Telegram's own bot for making bots. It is free.
> - Your bot is public. Anyone on Telegram can find it by its username. Your agent only answers the people and groups you allow, and this guide shows you how.
> - Your Telegram chats show up in your sessions in the browser, with the full conversation and what every reply cost.

## 1. Create a bot

Open Telegram and start a chat with [@BotFather](https://t.me/BotFather).

1. Send `/newbot`.
2. Enter a display name for your bot. This is the name people see in their chat list. Use your agent's name.
3. Enter a username for your bot. It must be unique on Telegram and must end in `bot`, for example `ada_salt_bot`.
4. BotFather replies with a token that looks like `8412345678:AAH…`. Copy it.

> [!warning]
> Keep the token private. Anyone who has it can control your bot and read every message sent to it. If you think someone else has seen it, send `/revoke` to BotFather and paste the new token into your agent's settings.

## 2. Add the bot to your agent

Open your agent, then **Settings**. In the **Telegram** section:

1. Paste the token into **Bot token**.
2. Enter your bot's username into **Bot username**, starting with `@`. Your agent needs it to know when it is being mentioned in a group.

There is nothing else to set up. Your agent connects to Telegram on its own as soon as the token is saved.

## 3. Let yourself in

Your agent will not answer anyone yet. This is on purpose.

A new agent starts with a placeholder in **DM whitelist**, `@no-user`, which matches nobody. Remove it and add your own Telegram username instead, for example `@alice`.

You can find your username in Telegram under **Settings**. If you do not have one, you can set one there, or use your numeric Telegram ID instead. To find your ID, send any message to [@userinfobot](https://t.me/userinfobot).

> [!warning]
> Do not leave the list empty. An empty list lets **everyone** on Telegram talk to your agent, and every reply is billed to your OpenRouter key. Read [Telegram safety tips](/guide/telegram-safety) before you change this.

## 4. Say hello

Open a chat with your bot on Telegram, press **Start**, and send a message. Your agent answers in the same chat.

## Using your agent in a group

1. Add your bot to the group like any other member.
2. Find the group's ID using [@userinfobot](https://t.me/userinfobot). It is a negative number like `-1001234567890`.
3. In your agent's settings, remove the placeholder `-1000000000000` from **Groups whitelist** and add the group's ID.

In a group, your agent only answers messages that mention it, for example `@ada_salt_bot what did we decide?`. It ignores everything else, so it does not spend your money on every message in a busy group.

If you reply to someone's message and mention the bot, your agent also reads the message you replied to.

Groups with topics work too. Every topic is a separate conversation with its own history. To allow only one topic, add it as `group_id:topic_id`, for example `-1001234567890:42`.

## How chats become sessions

| Where you talk | What your agent keeps |
|---|---|
| A private chat | One session, until you send `!new` |
| A group | One session for the whole group |
| A group with topics | One session for each topic |

Everyone in a group shares the same session. Your agent sees what everyone in the group says to it.

## Footnotes

1. One bot belongs to one agent. If you have two agents, create two bots. The same token in two agents only works in the one you saved it in last.
2. Telegram does not allow messages over 4096 characters, so long replies arrive as several messages. Nothing is cut.
3. Your agent can read photos, files and voice notes you send on Telegram only if the matching capability is switched on in **Capabilities**.
4. If your bot does not answer, check the whitelists first. In a group, check that you mentioned the bot.
