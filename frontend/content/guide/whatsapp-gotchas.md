---
title: WhatsApp gotchas
section: WhatsApp
order: 2
summary: The rules WhatsApp plays by, and the mistakes that make an agent go quiet.
---

WhatsApp is stricter than Telegram. Meta decides who your agent may talk to, when it may talk, and which models may read your messages. Most problems people have on WhatsApp come from one of the rules on this page.

## Your agent only answers your number

Your agent answers one WhatsApp number, and it is the one in **Your WhatsApp number** in your agent's settings. Messages from every other number are ignored without a reply.

Enter the full number with the country code, digits only. `919876543210` is right. `+91 98765 43210` is not.

This is not something you can change. Letting anyone else talk to your agent breaks Meta's terms of use, and ours. Your agent will not work in WhatsApp groups either.

## The 24-hour window

WhatsApp only lets your agent send you a message within 24 hours of the last message you sent it. After that, your agent cannot reach you until you message it again.

This matters most for scheduled tasks and reminders:

- A reminder that comes due while the window is closed is **not delivered**. It is not saved for later.
- When you schedule something on WhatsApp, your agent tells you about this rule in the same chat.
- To keep the window open, send your agent at least one message every 24 hours. Any message works.

If you rely on reminders, Telegram has no such rule. See [Connect your agent to Telegram](/guide/telegram).

## Some models do not work on WhatsApp

Meta does not allow WhatsApp messages to be used to train AI models. So when a message comes from WhatsApp, your agent only sends it to providers that promise not to train on it.

Some models are not offered by any provider that makes that promise. Those models work in your browser and on Telegram, but fail on WhatsApp.

If your agent answers in the browser but not on WhatsApp, pick a different model in **Settings** and try again. See [Choose the right model](/guide/choosing-a-model).

## It worked yesterday and stopped today

Check these in order:

1. **The access token expired.** The token you generate on the **Try it out** page lasts only 24 hours. The one in your agent's settings must be the system user token from step 5 of the setup guide, with the expiry set to **Never**.
2. **The 24-hour window closed.** Send your agent a message. It can only reply to you from then on.
3. **Your account was suspended.** Check [business.facebook.com](https://business.facebook.com) for notices.
4. **Meta took back the test number.** The test number is a free service and Meta can change or remove it at any time. If it is gone, you have to set up a new number.

## Before it works at all

- **Switch WhatsApp on.** It is off on a new agent. Turn it on in the **WhatsApp** section of your agent's settings.
- **Fill in all six fields.** Your WhatsApp number, phone number ID, WhatsApp Business account ID, access token, app secret and verify token. A missing one stops everything.
- **Save the verify token in your agent first.** Meta checks it the moment you click **Verify and save**. If your agent does not have the same token yet, Meta says the token is wrong.
- **Check the callback URL.** It contains your agent's ID. If it points at a different agent, nothing arrives.

## Footnotes

1. One Meta app sends messages to one callback URL, so it can only serve one agent. For a second agent, create a second app.
2. Creating more than one unverified business portfolio gets the newer ones suspended. Reuse the one you already have.
3. Commands work on WhatsApp the same way they work anywhere else. Send `!new` when you change subject. See [Commands](/guide/commands).
4. Your agent can reply with voice notes on WhatsApp if **Voice notes** is switched on in **Capabilities**.
