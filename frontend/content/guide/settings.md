---
title: Your agent's settings
section: Using your agent
order: 2
summary: Every field on your agent's Settings page, from top to bottom, what each one does and where to learn more. Covers Telegram, WhatsApp, model, custom instructions, OpenRouter key, name, Manage access and API key.
---

Your agent has two pages for setting it up. **Settings** decides how your agent replies and who it talks to, and **Capabilities** decides what it can do. This page goes through **Settings** from top to bottom. For **Capabilities**, see [What your agent can do](/guide/capabilities).

To open it, open your agent and click **Settings** in the sidebar. Most changes are saved as soon as you make them. For a text box, click **Save** or anywhere outside the box. The top of the page shows **Saved** once everything is stored. A new setting applies from the next reply, even in the middle of a conversation.

## Monthly spend limit

Only shown if your agent is part of a fleet. It shows how much of this month's allowance is left. It is set by the person who runs the fleet, and resets at the start of every calendar month.

## Telegram

Lets you talk to your agent from Telegram. Paste your bot's token into **Bot token**, and list who your agent may reply to in **DM whitelist** and **Groups whitelist**. See [Connect your agent to Telegram](/guide/telegram), and read [Telegram safety tips](/guide/telegram-safety) before you change the whitelists.

## WhatsApp

Lets you talk to your agent from WhatsApp. It is off by default, and needs six fields filled in from your Meta account. See [Connect your agent to WhatsApp](/guide/whatsapp).

## Model

The AI model that writes your agent's replies. Models marked **(no image)** cannot see photos. The part of a name in brackets is its nickname, which you can use with `!model` on Telegram and WhatsApp. See [Choose the right model](/guide/choosing-a-model).

## Custom instructions

Instructions your agent reads before every reply. Use them to tell it how you want it to answer, what it is for, or what it should know about you, for example "Answer in short paragraphs" or "I live in Mumbai and work as a teacher." Keep them short, since they are read, and paid for, with every reply.

## Extended reasoning, Creativity, Reply length cap and Context window

These change how the model answers:

- **Extended reasoning** lets the model think before it answers. Better on hard problems, but slower and more expensive.
- **Creativity** controls how varied the answers are.
- **Reply length cap** is the longest a single reply can be.
- **Context window** is how much of the conversation your agent reads before every reply.

We recommend leaving all four as they are until you have a reason to change them. See [Choose the right model](/guide/choosing-a-model) for when to.

## OpenRouter

The OpenRouter API key that pays for your agent's replies. Your agent cannot reply without one. Choose a key from your OpenRouter wallet by its nickname, or click the wallet icon at the end of the dropdown to add one. See [Get an OpenRouter API key](/guide/openrouter).

## Name

What your agent is called on Salts. Changing it does not change your Telegram bot's name, which you change with BotFather.

## Manage access

The email addresses of other people who can use this agent. They sign in to Salts with that address and see the agent on their home page.

> [!warning]
> Anyone you add here can chat with your agent, change its settings and read every conversation in it, including yours. Only add people you trust. See [Who can see your conversations](/guide/privacy).

## API key

Lets a program talk to your agent, instead of a person. Most people never need this. See [API playground](/guide/api-playground).

## Admin settings

Only shown to the person who created the agent. It holds the agent's defaults, locks and limits, the same settings a fleet uses. See [Choose the fleet's settings](/guide/fleet-settings).

## Footnotes

1. If your agent is part of a fleet, some of these settings may be hidden. The person who runs the fleet has locked them.
