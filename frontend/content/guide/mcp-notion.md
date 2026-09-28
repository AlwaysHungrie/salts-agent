---
title: Adding your first MCP server
section: MCP servers
order: 1
summary: Connect your agent to Notion, so it can read, search and add to your Notion pages for you.
---

This guide will help you connect your agent to Notion. Once it is done, you can ask your agent to find something in your notes, summarise a page or add a task to your to-do list, from your browser, Telegram or WhatsApp. It takes about five minutes, and no technical skills are required.

You will need a Notion account. A free one works.

## 1. Open the MCP servers section

Open your agent and go to **Capabilities**. Scroll down to **MCP servers** and make sure it is switched on. It is on by default.

Below it, you will see a row of app icons. These are ready-made MCP servers that you can add with one click.

## 2. Add Notion

Click the **Notion** icon. A form opens with everything already filled in for you:

- The server name is **Notion**.
- The server URL is `https://mcp.notion.com/mcp`.
- **OAuth** is selected, which means you will sign in to Notion with your own account instead of pasting a key.

Click **Add**. Notion now shows up as a card in the list, marked **Not connected**.

## 3. Connect your Notion account

Click **Connect** on the Notion card. You will be taken to Notion, where you sign in and choose which workspace your agent is allowed to use. Allow access, and Notion sends you back to your agent's **Capabilities** page.

The Notion card now shows how many tools Notion offers your agent. Each tool is one thing your agent can do in Notion, such as searching your workspace, reading a page or creating a new one.

## 4. Choose which tools to keep

Before you start using Notion, click **Select recommended** on the Notion card. Your agent looks at the list of tools and keeps only the ones it is likely to need.

This step is important. Every tool you leave switched on makes every reply more expensive, even when the tool is not used. Read [Must read: Managing costs and MCP tools](/guide/mcp-costs) to understand why.

To see which tools are on, click the name of the card. Tools that are switched off are faded out, and you can click any tool to switch it on or off yourself.

## 5. Try it

Go back to the chat and ask your agent something about your Notion, for example:

- "What is on my reading list in Notion?"
- "Summarise my meeting notes from last week."
- "Add 'book flights' to my to-do list in Notion."

Your agent decides on its own when to use Notion, so you do not need to tell it which tool to use.

## You are done

Your agent can now use Notion with your account. Next, read [Must read: Managing costs and MCP tools](/guide/mcp-costs) to keep your replies cheap, or connect another app such as [GitHub](/guide/mcp-github).

## Footnotes

1. To stop your agent from using Notion, switch the Notion card off. To remove the connection completely, click **Disconnect**.
2. If Notion stops working, click **Refresh tools** on the card. If that does not help, click **Disconnect** and then **Connect** again.
3. Anyone who can talk to your agent can ask it to use Notion on your behalf. If your agent is in a Telegram group, read [Telegram safety tips](/guide/telegram-safety) first.
