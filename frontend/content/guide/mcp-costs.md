---
title: Must read: Managing costs and MCP tools
section: MCP servers
order: 2
summary: Every MCP tool you leave switched on makes every reply more expensive. Here is how to keep that under control.
---

Connecting apps to your agent is one of the most useful things you can do with it, but it is also the easiest way to make your agent expensive without noticing. This page explains why, and what you can do about it.

## Why MCP tools cost money

Every MCP server gives your agent a list of tools, and each tool comes with a description of what it does and how to use it. So that your agent knows what it can do, this whole list is sent to the model with **every message**, whether your agent uses any of the tools or not.

You pay for everything the model reads. A large server like Notion comes with a long list of tools, and if every one of them is switched on, it can add tens of thousands of tokens to every single reply. That can make a simple "thank you" cost many times more than it should.

## Keep only the tools you need

The most effective thing you can do is switch off the tools your agent does not need.

**Select recommended** does this for you. Click it on any MCP server's card in **Capabilities**, and your agent reads the list of tools and keeps only the ones that match what you use it for, up to 12. It uses your agent's name and custom instructions to decide, so writing good [custom instructions](/guide/choosing-a-model) helps it choose well. This costs one small reply.

You can also choose tools yourself. Click the name of the server's card to see all of its tools, then click a tool to switch it on or off. We recommend switching off anything to do with admin, settings or users, since you will rarely ask your agent to do those things.

## Switch servers off when you are not using them

If you only use an app now and then, switch its card off in **Capabilities** and switch it back on when you need it. A server that is switched off costs nothing.

On Telegram or WhatsApp, you can do the same with a command. Use the name the server has on your **Capabilities** page:

```
!enable-mcp Notion
!disable-mcp Notion
```

`!enable-mcp` switches on every tool the server has, so we recommend clicking **Select recommended** again the next time you are on the **Capabilities** page.

## Watch the cost of each reply

Every reply shows what it cost. If replies suddenly become more expensive after you connect an app, that is usually the reason. Check how many tools the server's card says are switched on, and trim the list.

What your agent reads back from an app also stays in the conversation. A long Notion page or a big list of GitHub issues makes every reply after it more expensive too. Compacting or starting a new conversation fixes this. See [Why and when to compact](/guide/compacting).
