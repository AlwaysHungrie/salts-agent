---
title: Add the spreadsheet analyst
section: salts-tools
order: 4
summary: Send your agent Excel and CSV files and ask questions about them, get charts and receive finished workbooks back.
---

The analyst lets your agent work with spreadsheets. You attach an Excel or CSV file in the chat and ask about it in plain words, for example "What was the total for June?" or "Make me a sheet comparing these three months, with a chart". Your agent shows you a preview of the tables and charts before it builds anything, and then sends you the finished workbook to download. You can also ask for the same tables and charts as a PDF report to share with a client; for that, your computer needs Google Chrome or Microsoft Edge. Your original file is never changed.

This guide will help you start the analyst and connect it to your agent. You will need salts-tools installed with uv (see [Install salts-tools](/guide/salts-tools-install)). The analyst does not need Docker.

## 1. Switch the analyst on

Open the [salts-tools page](/salts-tools) and switch on **Spreadsheet analyst** for your agent. The first start takes a minute or two while salts-tools sets the analyst up on your computer. Your agent then has a new MCP server called **analyst**, already connected.

## 2. Switch on files and MCP servers

The analyst needs **File ingest**, so you can attach files in the chat, and **MCP servers** switched on for your agent. If either is off, the salts-tools page shows it under your agent with a **Turn on** button.

If you delete the **analyst** server from your agent, salts-tools switches the analyst off for that agent. To bring it back, switch it on again on the salts-tools page.

## You are done

Attach an .xlsx or .csv file in the chat and ask your agent a question about it.

The analyst keeps related files together in a **project**, for example a rate sheet and three months of data, so you can ask questions across all of them at once. Just tell your agent which project you are working on, such as "switch to the dialysis project", and it will keep using those files.

You can also drop files straight into the analyst's inbox folder on your computer, instead of attaching them in the chat. The salts-tools screen (`npx salts-tools`) shows the folder when you open **Spreadsheet analyst** on the **Services** tab.
