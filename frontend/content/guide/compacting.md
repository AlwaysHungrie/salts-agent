---
title: Why and when to compact
section: Managing costs
order: 2
summary: Long conversations get slower and more expensive with every reply. Compacting is how you keep them cheap.
---

Your agent does not remember a conversation the way you do. Every time you send a message, the whole conversation so far is sent to the model again, from the first message to the last. The model reads all of it before it writes a single word.

That has three consequences:

- **Every reply costs more than the one before.** You pay for everything the model reads. A conversation with a hundred messages in it costs far more per reply than one with ten, even if you only ask a short question.
- **Replies get slower.** More to read means a longer wait.
- **Answers can get worse.** Old, unrelated messages distract the model. At some point the conversation is longer than the model can read at all.

Compacting fixes this. It replaces the older part of the conversation with a short summary. From then on your agent reads the summary instead of every old message, and your costs drop back down.

## What compacting keeps and what it loses

The summary keeps what the conversation was about, what was decided, and what is still open. It loses exact detail: the precise wording of a message, a long list of numbers, a file you sent twenty messages ago.

Nothing is deleted. Every message is still in your browser, word for word. Only what the model reads gets shorter.

If you need an exact detail after compacting, paste it again.

## It happens on its own

Your agent compacts automatically. Before each reply it checks how much the model had to read for the last one. If that has grown past a set size, it summarises the older messages first, and keeps the first few messages and the most recent part of the conversation in full.

You do not have to do anything for this. The summary is a model call, so it is billed to your OpenRouter key like any other reply.

## When to compact yourself

Send `!compact` when:

- You want to carry on with the same subject, but the conversation has become long.
- The cost shown under each reply keeps climbing.
- Your agent starts forgetting what you told it earlier, or mixing up old and new instructions.

A manual `!compact` summarises everything except your latest message. You can send it again later. The new summary includes the old one.

## Compact or start again

| If you are | Do this |
|---|---|
| Carrying on with the same thing | `!compact` |
| Changing subject | `!new`, or a new session in the browser |
| Done with the conversation for good | `!clear` |

When in doubt, start a new session. A fresh session is always the cheapest one, and nothing your agent saved to its memory is lost.

## Footnotes

1. **Context window** in your agent's settings is another way to keep replies cheap. It makes the agent read only the last few messages. Unlike compacting, it throws everything older away instead of summarising it.
2. `!compact` replies `Nothing to compact yet` when there is only one message in the conversation.
