---
title: Add the matchmaker
section: salts-tools
order: 3
summary: Let your agent read resumes and match candidates to job descriptions, using a tool that runs on your computer.
---

The matchmaker is a tool for recruiters. It reads resumes, remembers every candidate, and matches them against a job description, so you can ask your agent "Who are the best five candidates for this backend role?" and get an answer from your own pool of resumes. The resumes stay on your computer.

This guide will help you start the matchmaker and connect it to your agent. You will need salts-tools installed with Docker and uv (see [Install salts-tools](/guide/salts-tools-install)), and an [OpenRouter API key](/guide/openrouter), since the matchmaker uses a model to read resumes.

## 1. Start the matchmaker

In your terminal, run:

```
salts-tools start matchmaker
```

The first start takes a few minutes, because salts-tools downloads and sets up everything the matchmaker needs. If salts-tools is already running another tool, the matchmaker joins it and nothing else changes.

Once it is live, open your agent's **Capabilities** page and look under **MCP servers**. You will find a new server called **matchmaker**, already connected with your token.

## 2. Add your key and spending limits

The matchmaker pays for its model calls with your OpenRouter key, and it only spends up to the limits you set. Click the **matchmaker** card to open it, click **+ Add header** for each row below, enter the **Header name** and **Header value**, and then click **Save headers**.

| Header name | Value we recommend | What it covers |
|---|---|---|
| `X-OpenRouter-Api-Key` | your OpenRouter key | Pays for the matchmaker's model calls |
| `X-Cost-Approved-Resume-Ingestion` | `0.01` | Reading one resume, which usually costs about $0.002 |
| `X-Cost-Approved-Job-Match` | `0.10` | Matching one job, which usually costs $0.01 to $0.04 |
| `X-Cost-Approved-Search` | `0.001` | Searching your candidates, which is almost free |
| `X-Cost-Approved-Folder-Ingestion` | `5.00` | Reading a whole folder of resumes, about $0.004 a file |

Each limit is the most one request may spend, in US dollars. Setting a limit to `0` switches that tool off, so you can block anything you do not want your agent to do. You only need to add these once, since they stay in place when salts-tools reconnects.

You do not have to type these out by hand. In the salts-tools screen, open **matchmaker** on the **Services** tab and press **Enter** on a header to copy its name.

## You are done

Try it by sending your agent a resume, or asking it to read a folder of resumes on your computer, and then paste in a job description and ask who fits best.

As with every MCP server, keep only the tools you use switched on, since each one makes every reply a little more expensive. See [Must read: Managing costs and MCP tools](/guide/mcp-costs).

## Footnotes

1. If the **Services** tab says `name taken`, your agent already has a different MCP server called **matchmaker**. Delete it from **MCP servers**, and salts-tools adds its own within a minute.
2. If the matchmaker stays on `starting` for a long time on the first run, it is still installing. Check that Docker is running if it does not finish.
