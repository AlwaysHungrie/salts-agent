---
title: What is an MCP server
section: MCP servers
order: 3
summary: MCP servers connect your agent to the apps you already use, so it can do things in them for you.
---

On its own, your agent can only talk. MCP servers let it do things in other apps, such as reading your Notion pages, opening a GitHub issue or checking your calendar. MCP, short for Model Context Protocol, is a standard way for an AI agent to use another app, and many apps now offer an MCP server of their own.

Once an app is connected, your agent uses it with your account and your permissions. You just ask in plain words, for example "add this to my Notion reading list", and your agent works out which tools to use.

## Adding an MCP server

MCP servers are added from the **MCP servers** section of your agent's **Capabilities** page. There are two ways to add one:

- **Ready-made servers**: click one of the app icons at the top of the section. Everything is filled in for you. [Adding your first MCP server](/guide/mcp-notion) walks you through Notion, and [Connect GitHub](/guide/mcp-github) walks you through GitHub.
- **Any other server**: click **Add an MCP server** and enter its details yourself. See [Adding a custom MCP server](/guide/mcp-custom).

## Signing in

Every server needs to know who you are, and there are three ways it can do that:

| Option | How it works | Example |
|---|---|---|
| **OAuth** | You click **Connect** and sign in to the app with your own account. | Notion |
| **API key** | You create a key or token in the app and paste it in. | GitHub |
| **None** | The server does not need you to sign in. | Public servers |

## Tools

Each server gives your agent a set of tools, and each tool is one thing your agent can do in that app, such as "search pages" or "create an issue". You can see a server's tools by clicking the name of its card, and switch each one on or off.

We strongly recommend only keeping the tools you need, since every tool that is switched on makes every reply more expensive. Read [Must read: Managing costs and MCP tools](/guide/mcp-costs) before you connect your first app.

## Keeping your accounts safe

Anyone who can talk to your agent can ask it to use the apps you connected, with your account. Only connect apps to an agent that you alone use, or that you share with people you trust. If your agent is in a Telegram group, read [Telegram safety tips](/guide/telegram-safety) first.

When you create an API key for an app, we recommend giving it only the access your agent actually needs, for example read-only access if you only want to ask questions.
