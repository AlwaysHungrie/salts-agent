---
title: Chat session hygiene
section: Managing costs
order: 3
summary: How to keep your conversations short and your replies cheap, especially on Telegram and WhatsApp.
---

Every time you send your agent a message, it reads the whole conversation again from the start before it replies, and you pay for everything it reads. A conversation that has been going on for weeks can make even a one-word reply expensive. Good session hygiene simply means starting a fresh conversation often, so your agent only reads what matters.

## In the browser

In the browser, every chat is a separate session, and you can start a new one from the sidebar at any time. We recommend starting a new session whenever you change the subject.

## On Telegram and WhatsApp

> [!warning]
> On Telegram and WhatsApp, your chat with your agent is **one conversation that never ends on its own**. Every message you have ever sent in that chat is part of it, so unless you use commands, each reply costs more than the one before, and your costs will keep growing.

This is easy to miss, because a Telegram or WhatsApp chat looks the same as any other chat on your phone. There is no button to start a new conversation, so you need to use commands instead. Send them as the whole message:

| Command | When to use it |
|---|---|
| `!new` | Whenever you change the subject. Your agent starts a fresh conversation in the same chat. |
| `!compact` | When you want to carry on with the same subject, but the conversation has become long. |
| `!clear` | When you are done with a conversation and do not want to keep it. |

In a Telegram group, mention the bot before the command, for example `@ada_salt_bot !new`. The whole group shares one conversation, so it grows even faster than a private chat.

A good habit is to send `!new` at the start of each day, or every time you ask about something unrelated to what you were talking about before.

Your agent does compact long conversations on its own, but only once they have become very long. Until then, you are paying for all of it on every reply.

## Starting fresh does not lose anything important

- Old conversations are still available in your browser, unless you used `!clear`.
- Anything your agent saved to its memory is still there in the new conversation.
- Reminders and scheduled tasks carry over to the new conversation when you send `!new`.

## Signs that it is time to start fresh

- The cost shown under each reply keeps going up.
- Replies are getting slower.
- Your agent mixes up old and new instructions, or brings up things you talked about a long time ago.

See [Commands](/guide/commands) for everything commands can do, and [Why and when to compact](/guide/compacting) for more on compacting.
