---
title: Commands
section: Everyday use
order: 3
summary: Six things you say to the session itself rather than to the agent, and why they still work when nothing else does.
---

Commands are handled by the conversation, not by the model. That matters: a session that
has got itself stuck cannot answer a question about itself, and a Telegram chat has no
buttons to press. Commands work in both cases, because they never reach the model at
all.

They cost nothing, with one exception: `!compact` asks the model for a summary, and that
call is billed like any other.

## The six commands

| Command | What it does |
|---|---|
| `!new` | Hands this chat to a brand new session. Scheduled tasks move across |
| `!clear` | The same, but the old conversation is deleted rather than kept |
| `!stop` | Stops the reply being written right now |
| `!compact` | Summarises the older part of the conversation so the agent reads less |
| `!unstick` | Clears a stuck turn. The conversation and everything in it is kept |
| `!delete` | Deletes this session and everything in it |

## How to type one

The command has to be the **whole message**. `!delete` deletes the session; "should I
use !delete here?" does not. That is deliberate: finding out how the feature works
should not cost you the conversation.

In a group chat you have to mention the bot to reach it at all, so a leading or trailing
`@yourbot` is fine and is ignored:

```
@ada_salt_bot !new
```

## `!new` — start a clean conversation

Use this on Telegram when you change subject. The chat stays where it is; what changes
is the session behind it. The old transcript stops being re-sent, so the next answer is
cheaper, faster and more focused.

Anything you had scheduled in that chat is moved onto the new session, so a daily
reminder keeps arriving.

In the web app there is a new-chat button, so `!new` is mostly a Telegram tool. Sent in
a web session that is not tied to a chat, it says so and does nothing.

## `!clear` — start clean and leave nothing behind

`!clear` does everything `!new` does — the chat carries on in the same place on a fresh
session, and scheduled tasks move across — and then deletes the conversation it just
left, with its messages, its uploaded files and its stored bytes. It cannot be undone.

Use it instead of `!new` when you do not want the old transcript readable in the
browser afterwards, or when you are near the session limit: `!clear` frees the slot it
uses, so it keeps working where `!new` is refused.

Like `!new`, it is a chat command. Sent in a web session that is not tied to a chat, it
says so and does nothing.

## `!stop` — stop a reply being written

The web app has a Stop button beside the message box. Telegram and WhatsApp have
nowhere to put one, so they have this instead: send `!stop` while the agent is
answering and it stops.

What it had written by then is kept in the transcript and readable in the browser; it
is not sent to the chat, because half an answer to a question you have just withdrawn
is worse than none. The stopped turn says nothing of its own — the only reply you get
is the one confirming the stop.

You are told which of the two things happened, because a chat has no spinner to look
at: `Stopped.` if something was running, and `Nothing to stop` if nothing was.

Use it when you asked the wrong question, or when an answer is clearly going the wrong
way and you would rather not pay for the rest of it.

## `!compact` — shrink what the agent re-reads

Every turn re-sends the conversation to the model. A long session gets slower and more
expensive per answer, and eventually longer than the model can read. `!compact` replaces
the older messages, as the agent sees them, with a summary. The first few messages and
the last exchange are still sent in full.

The transcript is not changed. Every message stays readable in the browser; only what
the model is sent gets shorter. Running `!compact` again folds the earlier summary into
a new one.

A session also compacts on its own before a turn when the previous turn's prompt went
past the deployment's `compact_after_tokens` setting. Setting it to `0` turns the
automatic compaction off. `!compact` works either way.

It is refused while a reply is being written. Wait for the reply, or `!stop` it, then
send `!compact`. It says `Nothing to compact yet` when the conversation is too short to
summarise.

Use it when you want to keep going in the same session but the conversation has grown
long. Use `!new` instead when you are changing subject.

## `!unstick` — get a wedged session moving

Very occasionally a turn does not finish. A model call never returns, or a network
failure hits at the wrong moment, and the session believes it is still busy. `!unstick`
clears that state.

Nothing is lost: the transcript, the attachments, the scheduled tasks and the memories
are all still there. Ask your question again.

Try this before `!delete`. It solves the same symptom without the cost.

## `!delete` — remove the session

This deletes the conversation, its messages, its uploaded files and its scheduled tasks.
It cannot be undone.

On Telegram, the next message you send starts a fresh conversation in the same chat, as
if the bot had just met you. Memories the agent stored about you are not touched:
those belong to the agent, not the session.

Use it for a conversation you would rather did not exist, or to free a slot when you are
near the session limit.

## What next

- [Sessions, and when to start a new one](/docs/sessions)
- [When something breaks](/docs/troubleshooting)
