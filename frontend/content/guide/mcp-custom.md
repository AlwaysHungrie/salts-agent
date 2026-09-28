---
title: Adding a custom MCP server
section: MCP servers
order: 5
summary: Connect your agent to any app that offers an MCP server, even if it is not in the list.
---

The app icons on the **Capabilities** page are only a few of the apps you can connect. Many other apps offer an MCP server, and you can add any of them yourself as long as you know its address.

## What you need

Look in the app's documentation for its MCP server. You need two things:

- **The server URL**, usually something like `https://mcp.example.com/mcp`. Your agent runs online, so it needs a server that is reachable over the internet. Servers that you are asked to install and run on your own computer will not work.
- **How to sign in.** The documentation will usually say whether you sign in with your account (OAuth), or with an API key or token.

## Add the server

Open your agent, go to **Capabilities**, scroll down to **MCP servers** and click **Add an MCP server**.

1. Enter a name for the server. This is the name you will use with `!enable-mcp` and `!disable-mcp`, so we recommend keeping it short, for example `Linear`.
2. Enter the server URL.
3. Choose how to sign in:
   - **OAuth** if the app lets you sign in with your account. After you click **Add**, click **Connect** on the new card and sign in.
   - **API key** if the app gives you a key or token. Enter the header name and value from the app's documentation. Most apps use `Authorization` as the name and `Bearer` followed by your key as the value.
   - **None** if the server does not need you to sign in.
4. Click **Add**.

Once your agent is connected, the card shows how many tools the server has. We recommend clicking **Select recommended** straight away. See [Must read: Managing costs and MCP tools](/guide/mcp-costs).

## If it does not connect

- Check the URL for typos, and make sure it is the MCP server's address, not the app's website.
- If **OAuth** fails, the app may not support the kind of sign-in Salts uses. Check whether the app offers an API key instead, and use **API key**.
- If the app asks you for a redirect URL, use the one shown at the bottom of the **MCP servers** section.
- After fixing anything, click **Refresh tools** on the card.
- If the card shows **Last failed tool call**, the message under it says what went wrong.
