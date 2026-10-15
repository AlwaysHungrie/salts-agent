---
title: Add the spreadsheet analyst
section: salts-tools
order: 4
summary: Send your agent Excel and CSV files and ask questions about them, get charts and receive finished workbooks back.
---

The analyst lets your agent work with spreadsheets. You attach an Excel or CSV file in the chat and ask about it in plain words, for example "What was the total for June?" or "Make me a sheet comparing these three months, with a chart". Your agent shows you a preview of the tables and charts before it builds anything, and then sends you the finished workbook to download. You can also ask for the same tables and charts as a PDF report to share with a client; for that, your computer needs Google Chrome or Microsoft Edge. Your original file is never changed.

This guide will help you start the analyst and connect it to your agent. You will need salts-tools installed with uv (see [Install salts-tools](/guide/salts-tools-install)). The analyst does not need Docker.

## 1. Start the analyst

In your terminal, run:

```
salts-tools start analyst
```

The first start takes a minute or two while salts-tools sets the analyst up. If salts-tools is already running another tool, the analyst joins it and nothing else changes.

## 2. Switch on files and MCP servers

Open your agent and go to **Capabilities**.

1. Switch on **File ingest**, so you can attach files in the chat.
2. Switch on **MCP servers**. You will find a new server called **analyst** there, already connected with your token.

If you remove the **analyst** server, salts-tools leaves it removed. To bring it back, click the **analyst** icon at the top of **MCP servers**, replace `SALTS-TOOLS-TOKEN` with your token and click **Add**. salts-tools fills in the real address within a minute.

## You are done

Attach an .xlsx or .csv file in the chat and ask your agent a question about it.

The analyst keeps related files together in a **project**, for example a rate sheet and three months of data, so you can ask questions across all of them at once. Just tell your agent which project you are working on, such as "switch to the dialysis project", and it will keep using those files.

You can also drop files straight into the analyst's inbox folder on your computer, instead of attaching them in the chat. The folder is `local-mcps/analyst-mcp/data/inbox` inside the salts-agent folder you downloaded, and the salts-tools screen shows the full path when you open **analyst** on the **Services** tab.
