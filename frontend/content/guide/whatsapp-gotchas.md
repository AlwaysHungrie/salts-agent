---
title: WhatsApp gotchas
section: WhatsApp
order: 2
summary: The rules WhatsApp plays by, and the mistakes that make an agent go quiet.
---

WhatsApp has stricter rules than Telegram. Meta decides who your agent can talk to, when it can message you, and which models can read your messages. If your agent is not working on WhatsApp, the reason is usually one of the rules on this page.

## Your agent only answers your number

Your agent only replies to the number in **Your WhatsApp number** in your agent's settings. Messages from any other number are ignored.

Enter the full number with the country code, using digits only. For example, `919876543210` is correct, and `+91 98765 43210` is not.

Letting anyone else talk to your agent breaks Meta's terms of use and ours, so this cannot be changed. Your agent also does not work in WhatsApp groups.

## The 24-hour window

WhatsApp only allows your agent to message you within 24 hours of the last message you sent it. After that, your agent cannot reach you until you message it again.

This matters most for reminders and scheduled tasks. A reminder that comes due after the window has closed is not delivered. To keep the window open, we recommend sending your agent at least one message every day. If you rely on reminders a lot, Telegram does not have this rule.

## Some models do not work on WhatsApp

Meta does not allow WhatsApp messages to be used to train AI models, so your agent only sends WhatsApp messages to model providers that promise not to train on them. Some models are not available from any such provider. These models work in your browser and on Telegram, but not on WhatsApp.

If your agent replies in the browser but not on WhatsApp, pick a different model in **Settings** and try again.

## If it stopped working

Check these in order:

1. **The access token expired.** The token from the **Try it out** page only lasts 24 hours. The one in your agent's settings should be the system user token from step 5 of [Connect your agent to WhatsApp](/guide/whatsapp), with the expiry set to **Never**.
2. **The 24-hour window closed.** Send your agent a message, and it will be able to reply again.
3. **Your account was suspended.** Check [business.facebook.com](https://business.facebook.com) for any notices.
4. **Meta removed the test number.** The test number is a free service, and Meta can change or remove it at any time. If it is gone, you will need to set up a new number.

## If it never worked

- Check that **WhatsApp** is switched on in your agent's settings. It is off by default.
- Check that all six fields are filled in: your WhatsApp number, phone number ID, WhatsApp Business account ID, access token, app secret and verify token.
- Make sure you saved the verify token in your agent's settings before clicking **Verify and save** on Meta.
- Check that the callback URL in Meta matches the one shown in the setup guide for this agent.
- Each Meta app can only be connected to one agent. For a second agent, create a second app.
