---
title: Get an OpenRouter key
section: Get started
order: 3
summary: Create an OpenRouter account, cap what it can spend, and give your agent its key.
featured: true
---

Your agent does not think on its own. Every reply is written by a model, and every model is reached through OpenRouter, using your key. OpenRouter bills you for exactly what your agent uses. There is no subscription.

Your agent cannot answer anything without this key.

> What to expect:
>
> - You will create an account on OpenRouter and add credit to it. Ten dollars is plenty to start with.
> - An idle agent costs nothing. Ordinary chatting on a cheap model costs a few cents a day.
> - The key is shown only once. Copy it before you close the page.

## 1. Create an account

Go to [openrouter.ai](https://openrouter.ai) and sign up. Open **Credits** and add a starting balance.

## 2. Set a spending limit

Do this before you create a key. Open **Settings**, find the limits for your account, and set a monthly cap.

This is the only limit nothing in Salts can go past. A scheduled task that runs more often than you meant, a very long conversation, or a stranger talking to your Telegram bot all spend your credit while you are asleep. The cap is what stops them.

## 3. Create the key

1. Open [openrouter.ai/settings/keys](https://openrouter.ai/settings/keys).
2. Click **Create key**. Name it after your agent, so you can tell it apart later.
3. If you run more than one agent, give each key its own credit limit. One agent then cannot use up another agent's budget.
4. Copy the key. It starts with `sk-or-v1-`.

## 4. Give it to your agent

Paste the key when you create the agent, or later in your agent's **Settings** under **OpenRouter**. The key is checked the moment you save it, so a mistyped key tells you straight away instead of failing on your first question.

A saved key is shown as dots. Leaving the dots as they are keeps the saved key.

## Keep an eye on the spend

Every reply in the chat shows what it cost. The **Activity** page on OpenRouter lists every call your key made, by model.

If a number surprises you, the usual cause is a long conversation, not an expensive model. Every reply sends the whole conversation to the model again. See [Why and when to compact](/guide/compacting).

## Footnotes

1. An error that mentions credits, or the code `402`, means your balance or a limit has run out. Top up, or raise the limit.
2. An error with the code `401` means the key was revoked or mistyped. Create a new key and paste it again.
3. Image generation, voice-note transcription and spoken replies each use a model of their own. They are billed to the same key.
