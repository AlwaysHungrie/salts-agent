---
title: Who can see your conversations
section: Help
order: 2
summary: Who can read your conversations, files and memories, what is sent to the AI model, what deleting removes, and how to keep your agent private.
---

Before you trust your agent with anything personal, it is worth knowing where your messages go and who else can see them. This page explains it in plain words.

## People who can read your conversations

| Who | What they can see |
|---|---|
| **You** | Every conversation in your agent, in your browser, wherever it started. |
| **People you add under Manage access** | Everything. They can read every conversation in the agent, including yours, change its settings and chat with it. Only add people you trust. |
| **People your agent replies to on Telegram** | Only the conversation they are in, such as their own private chat or a group they share with you, and anything your agent tells them. Your agent can repeat what it remembers, so anyone it replies to can ask it about you. |
| **The person who runs your fleet**, if your agent is part of one | Not your conversations. They can see that your agent exists and how much it spends, and they can change its settings. |

## What is sent to the AI model

Your agent does not write its replies itself. Every time you send it a message, the conversation, your custom instructions and anything your agent has read for you, such as a file or a web page, are sent through OpenRouter to the company that makes the model you picked, such as Anthropic, Google or DeepSeek.

Each of these companies has its own privacy policy. On OpenRouter, you can choose not to use providers that train their models on your data, under **Settings** → **Privacy** in your OpenRouter account. On WhatsApp, your agent already only uses providers that do not, since Meta requires it.

If you talk to your agent on Telegram or WhatsApp, your messages also pass through Telegram or Meta, as any other chat on those apps does.

## Memories

If **Private Memory** is switched on, your agent keeps facts you tell it and uses them in every future conversation. Memories belong to this one agent. Your other agents cannot see them.

Memories are not deleted when you delete a conversation. There is not yet a way to see or remove a single memory. Deleting the agent removes all of them. If there is something you would rather your agent did not keep, do not tell it while **Private Memory** is on.

## Files

Files you send are kept with the conversation they were sent in, so your agent can read them again later. Deleting the conversation also deletes its files.

The matchmaker and the spreadsheet analyst are different. They keep their files on your own computer, not online. See [What is salts-tools](/guide/salts-tools).

## Connected apps

When you connect an app such as Notion or GitHub, your agent uses it with your account. Anyone who can talk to your agent can ask it to read from or change things in that app. Only connect apps to an agent that you alone use, or that you share with people you trust. See [What is an MCP server](/guide/mcp).

## Deleting things

| To delete | Do this | What stays |
|---|---|---|
| One conversation | Delete it from the sidebar in your browser, or send `!delete` | Memories |
| The current conversation, and start a new one | Send `!clear` | Memories |
| Everything | Delete the agent. See [Delete an agent or start over](/guide/start-over) | Nothing |

Deleting cannot be undone.

## Keeping your agent private

1. Keep your **DM whitelist** and **Groups whitelist** on Telegram as short as you can. See [Telegram safety tips](/guide/telegram-safety).
2. Only add people under **Manage access** who you would let read all of your conversations.
3. Keep your API keys private, including your OpenRouter key, your Telegram bot token and any keys you created in your agent's **Settings**.
4. If you want an agent that other people can use, create a separate one for it, with **Private Memory** switched off.
