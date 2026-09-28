---
title: Why and when to compact
section: Managing costs
order: 2
summary: Long conversations get slower and more expensive with every reply. Compacting is how you keep them cheap.
---

Every time you send your agent a message, it reads the whole conversation again from the start before it replies. You pay for everything it reads, so the longer a conversation gets, the more each reply costs. Long conversations also make replies slower, and old messages can confuse your agent.

Compacting solves this by replacing the older part of the conversation with a short summary. From then on, your agent reads the summary instead of every old message, and your replies become cheaper again.

## What compacting keeps

The summary keeps what the conversation was about, what was decided and what is still open. It does not keep exact details, such as the precise wording of a message or a long list of numbers. If you need one of those details later, paste it into the chat again.

Compacting does not delete anything. Every message is still in your browser, exactly as it was sent.

## Your agent compacts on its own

When a conversation grows past a certain size, your agent automatically summarises the older messages before it replies. You do not need to do anything. The summary is written by the model, so it is billed to your OpenRouter key like any other reply.

## When to compact yourself

You can also send `!compact` at any time. We recommend doing this when:

- You want to keep talking about the same thing, but the conversation has become long.
- The cost shown under each reply keeps going up.
- Your agent starts forgetting what you told it earlier, or mixes up old and new instructions.

## Compact or start again

If you are changing the subject, it is better to start a new conversation than to compact. Send `!new` on Telegram or WhatsApp, or start a new session in your browser. A new conversation is always the cheapest, and your agent does not lose anything it saved to its memory.

| If you are | Do this |
|---|---|
| Carrying on with the same thing | Send `!compact` |
| Changing the subject | Send `!new`, or start a new session in the browser |
| Done with the conversation for good | Send `!clear` |

See [Commands](/guide/commands) for everything these commands do.
