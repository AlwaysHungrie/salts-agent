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
npx salts-tools start matchmaker
```

The first start takes a minute or two, because salts-tools sets up everything the matchmaker needs. If salts-tools is already running another tool, the matchmaker joins it and nothing else changes.

Once it is live, open your agent's **Capabilities** page and look under **MCP servers**. You will find a new server called **matchmaker**, already connected with your token.

## 2. Add your key and spending limit

The matchmaker pays for its model calls with your OpenRouter key. Click the **matchmaker** card to open it. salts-tools has already added both headers below with empty values, so you only fill in each **Header value** and then click **Save**.

| Header name | Value we recommend | What it covers |
|---|---|---|
| `X-OpenRouter-Api-Key` | your OpenRouter key | Pays for the matchmaker's model calls |
| `Tool-Call-Max-Charge` | `0.25` | The most one request may spend, in US dollars |

The limit is optional, and we recommend it. Reading one resume costs about $0.001, and checking a page of 50 candidates against a job costs about $0.10. A request that would cost more than your limit is stopped before it spends anything, and your agent tells you what to raise. You only need to add these once, since they stay in place when salts-tools reconnects.

If you removed a header, salts-tools adds it back empty the next time it reconnects, and it never changes a value you have set.

If you remove the **matchmaker** server itself, salts-tools leaves it removed. To bring it back, click the **matchmaker** icon at the top of **MCP servers**, replace `SALTS-TOOLS-TOKEN` with your token and click **Add**. salts-tools fills in the real address within a minute.

## You are done

Try it by sending your agent a few resumes, and then paste in a job description and ask who fits best. Your agent shows you the best people first, with what each one has and lacks for the job. Ask for more when you want the next 50.

## Telling it more about someone

Anything you tell your agent about a person, such as "Asha is open to moving to Berlin" or "Ravi is available from March", goes into that person's notes in the matchmaker. Notes are kept with their resume, they count for more than the resume, and searches and job matches read them. A later note replaces an earlier one that says something different.

## Getting someone's resume

Ask your agent for a person's files, for example "send me Amir Soto's resume". Your agent replies with a link. Open it in your browser to see everything the matchmaker holds for that person: their original resume and cover letter, the text read from them, your notes and their profile. Click a file to open or download it.

Each link works for 24 hours and only opens that one person's files. Anyone you forward it to can open it too, so share it only with people who should see the resume.

## Adding many resumes at once

Ask your agent to add a batch of resumes, for example "I want to add a folder of resumes". Your agent replies with a link to an upload page. Open it in your browser, choose your files or a whole folder (PDF, Word `.docx` or text files, up to 10 MB each), and wait until the page says it is done. Then tell your agent you are done. The matchmaker reads them in the background, and your agent tells you how it is going.

The upload link works for 24 hours. If it runs out, ask your agent for a new one.

Each resume costs about $0.001 to read, so 500 resumes cost about $0.50. If your `Tool-Call-Max-Charge` is lower than that, your agent tells you the amount to raise it to. Files you have already added are skipped, so you can upload more later and ask again.

## Exporting everyone

Ask your agent to "export all people" or "export all jobs", and it replies with a download link. People come as a zip with a spreadsheet (`people.csv`, one row per person with their contact details and profile) and a folder for each person with their resume, cover letter, notes and profile. Jobs come as a zip with `jobs.csv` and the full text of each posting. Like every link from the matchmaker, it works for 24 hours.

## Starting again from empty

To delete everything the matchmaker holds, ask your agent to "reset the matchmaker". This removes every person and their files, every job and anything waiting in the upload inbox, and it cannot be undone. Your agent first tells you what would be deleted and gives you a code such as `RESET 4F7K2Q`. Nothing is deleted until you reply with that code yourself. The code works once, for 10 minutes. We recommend exporting people and jobs first if you might want them later.

As with every MCP server, keep only the tools you use switched on, since each one makes every reply a little more expensive. See [Must read: Managing costs and MCP tools](/guide/mcp-costs).

## Footnotes

1. If the **Services** tab says `name taken`, your agent already has a different MCP server called **matchmaker**. Delete it from **MCP servers**, and salts-tools adds its own within a minute.
2. If you used the matchmaker before this version, your earlier candidates are not carried over. Send the resumes to your agent again to add them.
