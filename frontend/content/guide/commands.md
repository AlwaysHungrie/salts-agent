---
title: Commands
section: Advanced use
order: 2
summary: Short messages that control the conversation itself. They work in the browser, on Telegram and on WhatsApp.
---

A command is a message that starts with `!`. It is not sent to the model. Your agent handles it on its own and replies with one line saying what it did.

This is why commands still work when nothing else does. A session that is stuck cannot answer a question about itself, and a Telegram or WhatsApp chat has no buttons to press. A command needs neither.

Commands are free, with one exception: `!compact` asks the model for a summary, and that is billed like any other reply.

## The commands

| Command | What it does |
|---|---|
| `!new` | Moves this chat to a new, empty session. The old conversation is kept. |
| `!clear` | The same as `!new`, but the old conversation is deleted. |
| `!stop` | Stops the reply that is being written right now. |
| `!compact` | Replaces the older part of the conversation with a short summary, so every reply after it is cheaper. |
| `!unstick` | Gets a stuck session working again. Nothing is deleted. |
| `!delete` | Deletes this session and everything in it. |
| `!enable-mcp <name>` | Switches on the MCP server with that name, with all of its tools. |
| `!disable-mcp <name>` | Switches off the MCP server with that name. |

## How to send one

The command has to be the **whole message**. `!delete` deletes the session. "Should I use !delete here?" does not. You can ask about a command without running it.

In a Telegram group you have to mention the bot to reach it, so the mention is allowed:

```
@your_agent_bot !new
```

## !new

Use this whenever you change subject. The chat stays where it is, but the conversation behind it starts again from nothing. The old conversation is no longer sent to the model, so the next reply is cheaper, faster and not confused by what came before.

Anything you scheduled in the old conversation moves to the new one, so a daily reminder keeps arriving. The old conversation is still readable in your browser.

`!new` is for Telegram and WhatsApp. In the browser, click the new session button in the sidebar instead.

## !clear

`!clear` does everything `!new` does, then deletes the conversation it just left, with its messages and files. It cannot be undone.

Use it when you do not want the old conversation readable afterwards. Also use it when your agent has reached its limit of sessions: `!clear` frees a slot, so it works when `!new` is refused.

## !stop

Send `!stop` while your agent is still writing and it stops. Use it when you asked the wrong question, or when a reply is clearly going the wrong way and you do not want to pay for the rest of it.

What was written before the stop is kept in the conversation in your browser. It is not sent to the chat. The only reply you get is `Stopped.`, or `Nothing to stop` if nothing was being written.

In the browser, the stop button next to the message box does the same thing.

## !compact

A long conversation gets slower and more expensive with every reply. `!compact` summarises the older part of it, and your agent reads the summary instead of the full messages from then on. Your latest message is kept word for word.

It does not delete anything. Every message is still readable in your browser.

This one matters more than it looks. Read [Why and when to compact](/guide/compacting).

## !unstick

Very rarely, a reply never finishes. The session thinks it is still busy and ignores everything you send. `!unstick` clears that.

Nothing is lost. Your messages, files, scheduled tasks and memories are all still there. Ask your question again.

Always try `!unstick` before `!delete`.

## !delete

This deletes the conversation, its messages, its files and its scheduled tasks. It cannot be undone.

On Telegram or WhatsApp, your next message starts a new conversation in the same chat. Memories your agent saved about you are not deleted. They belong to the agent, not to the session.

## !enable-mcp and !disable-mcp

MCP servers connect your agent to other apps, such as Notion or GitHub. Every tool a server brings is sent to the model on every turn, which costs money even when the tool is not used. These two commands let you switch a server on only when you need it.

Use the name the server has on your **Capabilities** page:

```
!enable-mcp Notion
```

Enabling a server switches on all of its tools. To switch on only some of them, use the **Capabilities** page.

## Footnotes

1. `!compact` is refused while a reply is being written. Wait for the reply, or `!stop` it, then send `!compact` again.
2. A server has to be connected on the **Capabilities** page before `!enable-mcp` can switch it on.
