---
title: Add the matchmaker
section: salts-tools
order: 3
summary: Let your agent read resumes and find the best people for a job, using a tool that runs on your computer.
---

The matchmaker is a tool for recruiters. It reads resumes and cover letters, remembers every person, and finds the best people in your pool for a job, so you can ask your agent "Who are the best candidates for this backend role?" and get an answer with reasons. The resumes stay on your computer.

This guide will help you start the matchmaker and connect it to your agent. You will need salts-tools installed with uv (see [Install salts-tools](/guide/salts-tools-install)), and an [OpenRouter API key](/guide/openrouter), since the matchmaker uses a model to read resumes and judge candidates.

## 1. Start the matchmaker

In your terminal, run:

```
salts-tools start matchmaker
```

The first start takes a minute or two, because salts-tools sets up everything the matchmaker needs. If salts-tools is already running another tool, the matchmaker joins it and nothing else changes.

Once it is live, open your agent's **Capabilities** page and look under **MCP servers**. You will find a new server called **matchmaker**, already connected with your token.

## 2. Add your key and spending limit

The matchmaker pays for its model calls with your OpenRouter key. Click the **matchmaker** card to open it. salts-tools has already added both headers below with empty values, so you only fill in each **Header value** and then click **Save headers**.

| Header name | Value we recommend | What it covers |
|---|---|---|
| `X-OpenRouter-Api-Key` | your OpenRouter key | Pays for the matchmaker's model calls |
| `Tool-Call-Max-Charge` | `0.25` | The most one request may spend, in US dollars |

The limit is optional, and we recommend it. Reading one resume costs about $0.001, and checking a page of 50 candidates against a job costs about $0.10. A request that would cost more than your limit is stopped before it spends anything, and your agent tells you what to raise. You only need to add these once, since they stay in place when salts-tools reconnects.

If you removed a header, salts-tools adds it back empty the next time it reconnects, and it never changes a value you have set.

If you remove the **matchmaker** server itself, salts-tools leaves it removed. To bring it back, click the **matchmaker** icon at the top of **MCP servers**, replace `SALTS-TOOLS-TOKEN` with your token and click **Add**. salts-tools fills in the real address within a minute.

## You are done

Try it by sending your agent a few resumes, and then paste in a job description and ask who fits best. Your agent shows you the best people first, with what each one has and lacks for the job. Ask for more when you want the next 50.

As with every MCP server, keep only the tools you use switched on, since each one makes every reply a little more expensive. See [Must read: Managing costs and MCP tools](/guide/mcp-costs).

## Footnotes

1. If the **Services** tab says `name taken`, your agent already has a different MCP server called **matchmaker**. Delete it from **MCP servers**, and salts-tools adds its own within a minute.
2. If you used the matchmaker before this version, your earlier candidates are not carried over. Send the resumes to your agent again to add them.
