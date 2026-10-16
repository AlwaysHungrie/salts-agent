---
title: Set up web search
section: Advanced use
order: 1
summary: Give your agent the live web, for free, with a private search engine that runs on your own computer.
---

Without web search, your agent only knows what its model learned when it was trained, so it cannot tell you today's news, a current price or whether a shop is open. With web search switched on, your agent can look things up and tell you where the answer came from.

This guide will help you run your own free search engine, called SearXNG, on your computer and connect it to your agent. It works on Mac, Windows and Linux. You will need to use a terminal (the Terminal app on a Mac, PowerShell on Windows), but every command you need is on this page. If you would rather not run anything on your computer, skip to [Using Brave instead](#using-brave-instead).

> What to expect:
>
> - Your agent can only search while your computer is on, awake and connected to the internet.
> - You will install three free tools: Docker, Node.js and cloudflared. You do not need an account for any of them.

## 1. Install the tools

1. Install [Docker Desktop](https://www.docker.com/products/docker-desktop/). If you already use OrbStack or Colima, those work too. On Linux you can use Docker Engine instead; we recommend starting it with `sudo systemctl enable --now docker` and adding yourself to the `docker` group, so salts-tools can use it without asking for your password.
2. Install [Node.js](https://nodejs.org), version 20 or later.
3. Install cloudflared. On a Mac with Homebrew, run this in Terminal:

   ```
   brew install cloudflared
   ```

   On Windows, run this in PowerShell:

   ```
   winget install --id Cloudflare.cloudflared
   ```

   Otherwise, download it from [Cloudflare's downloads page](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/).

## 2. Get salts-tools

salts-tools is a small program that starts the search engine and connects it to your agent. There is nothing else to download: Node.js comes with `npx`, which fetches salts-tools the first time you run it, so every command below starts with `npx salts-tools`.

## 3. Connect your computer

In your terminal, run:

```
npx salts-tools
```

salts-tools shows a short code and opens this site in your browser. Check the code matches, tick the agents that should get web search, and click **Connect**. There is nothing to copy or paste.

## 4. Switch web search on

Open the [salts-tools page](/salts-tools) and switch on **Web search** for each agent. salts-tools starts the search engine and connects it to those agents. If **Web search** is switched off in an agent's **Capabilities**, the page shows a **Turn on** button for it.

Leave **Brave Search API key** empty in **Capabilities**. When a Brave key is set, your agent uses Brave instead, and the salts-tools page reminds you of that.

Finally, salts-tools asks in the terminal whether it should start automatically when you log in. We recommend saying yes, otherwise your agent loses web search every time you restart your computer.

## You are done

Ask your agent something that needs the web, for example "What is the weather in Mumbai today?". Your agent will search on its own whenever a question needs it, so you do not have to ask it to search.

If you also want your agent to open search results and read the full page, switch on **Read a URL** in **Capabilities**.

## Everyday commands

| Command | What it does |
|---|---|
| `npx salts-tools` | Starts salts-tools if needed, then opens a screen that shows whether search is running. Use the arrow keys to move and **q** to quit. |
| `npx salts-tools stop` | Stops the search engine. |
| `npx salts-tools restart` | Gets a fresh address; your agents follow it on their own. |
| `npx salts-tools reset` | Disconnects this computer and forgets everything. |
| `npx salts-tools autostart on` | Starts salts-tools when you log in. Use `off` to turn this off. |

To choose which agents get web search, use the [salts-tools page](/salts-tools).

## Using Brave instead

If you would rather not run anything on your computer, you can use Brave's search API instead. Brave has a free plan that is enough for one person. Create an account at [brave.com/search/api](https://brave.com/search/api/), subscribe to the free plan, and paste your key into **Brave Search API key** under **Web search** in your agent's **Capabilities**. Brave asks for a card, and any searches beyond the free plan are billed by Brave.

## Footnotes

1. If your agent stops searching, check that your computer is awake and online, then run `npx salts-tools restart`.
2. If the salts-tools page shows your computer as **Offline**, run `npx salts-tools` on it.
3. If your agent is not searching when it should, add this to **Custom instructions** in **Settings**: "Search the web for anything about current events, prices or dates." A stronger model also helps.
