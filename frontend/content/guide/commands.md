---
title: Commands
section: Advanced use
order: 2
summary: Short messages that control the conversation itself. They work in the browser, on Telegram and on WhatsApp.
---

Commands are short messages that start with `!` and control the conversation itself, such as starting a new one or stopping a reply. They are most useful on Telegram and WhatsApp, where there are no buttons to press. Commands are free, except for `!compact`, which is billed like a normal reply.

To use a command, send it as the whole message, for example `!new`. In a Telegram group, mention the bot first, for example `@ada_salt_bot !new`.

| Command | What it does |
|---|---|
| `!new` | Starts a new conversation. The old one is kept in your browser. |
| `!clear` | Starts a new conversation and deletes the old one. |
| `!stop` | Stops the reply your agent is writing right now. |
| `!compact` | Summarises the older part of the conversation, so replies become cheaper. |
| `!unstick` | Fixes a conversation where your agent has stopped responding. |
| `!delete` | Deletes this conversation and everything in it. |
| `!enable-mcp <name>` | Switches on a connected app. |
| `!disable-mcp <name>` | Switches off a connected app. |
| `!model <nickname>` | Switches your agent to another model. |

## !new

We recommend sending `!new` whenever you change the subject. Your agent starts fresh, which makes replies cheaper, faster and less likely to get confused by the earlier conversation. The old conversation is still available in your browser, and anything you scheduled in it, such as a daily reminder, carries over to the new one.

In the browser, you can start a new session from the sidebar instead.

## !clear

`!clear` does the same as `!new`, but also deletes the old conversation along with its messages and files. This cannot be undone.

If your agent has reached its limit of sessions and refuses `!new`, `!clear` will still work, since it frees up a slot.

## !stop

Send `!stop` while your agent is still writing to stop the reply. This is useful when you asked the wrong question, or the reply is going in the wrong direction and you do not want to pay for the rest of it. In the browser, you can use the stop button next to the message box instead.

## !compact

`!compact` replaces the older part of the conversation with a short summary, so every reply after it is cheaper. Nothing is deleted from your browser. Read [Why and when to compact](/guide/compacting) to learn when to use it.

## !unstick

Very rarely, a reply never finishes and your agent stops responding to anything you send. `!unstick` fixes this without deleting anything. Afterwards, ask your question again. We recommend always trying `!unstick` before `!delete`.

## !delete

`!delete` deletes the conversation, along with its messages, files and scheduled tasks. This cannot be undone. Anything your agent saved to its memory is not deleted.

## !enable-mcp and !disable-mcp

Apps you connect to your agent, such as Notion or GitHub, make every reply a little more expensive, even when they are not used. These commands let you switch an app on only when you need it. Use the name the app has on your **Capabilities** page, for example:

```
!enable-mcp Notion
```

The app must already be connected on the **Capabilities** page before you can switch it on this way.

## !model

`!model` switches your agent to another model from the list in **Settings** under **Model**. It uses the model's nickname, which is the part of its name in brackets. For example, a model named **DeepSeek V4.1 Flash (ds)** has the nickname `ds`, so this switches to it:

```
!model ds
```

The switch is the same as picking the model in **Settings**, so it applies to the whole agent, not just this conversation. The next reply uses the new model.

A model without brackets in its name has no nickname and can only be picked in **Settings**. If the model is locked by whoever manages your agent, `!model` does not work.
