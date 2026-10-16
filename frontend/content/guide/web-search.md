---
title: Set up web search
section: Using your agent
order: 3
summary: Give your agent the live web, either free with a private search engine on your own computer (salts-tools), or with a Brave Search API key and no installing.
---

Without web search, your agent only knows what its model learned when it was trained, so it cannot tell you today's news, a current price or whether a shop is open. With web search switched on, your agent can look things up and tell you where the answer came from.

Your agent needs a search engine to search with, and there are two ways to give it one:

| Option | Good for | What you need |
|---|---|---|
| **salts-tools** | Free searching with no limits | A computer that stays on, and about fifteen minutes in a terminal |
| **Brave** | No installing at all | A Brave account and a card. The free plan is enough for one person |

If you have never used a terminal before, we recommend starting with Brave. You can switch to salts-tools later.

## Using Brave

1. Create an account at [brave.com/search/api](https://brave.com/search/api/) and subscribe to the free plan. Brave asks for a card, and any searches beyond the free plan are billed by Brave.
2. Copy your API key.
3. Open your agent, go to **Capabilities** and switch on **Web search**.
4. Paste your key into **Brave Search API key**.

That is all. When a Brave key is set, your agent always uses Brave, even if salts-tools is also running.

## Using salts-tools

salts-tools is a small program that runs a private search engine called SearXNG on your computer and connects it to your agent. It works on Mac, Windows and Linux. If you are not sure what it is yet, read [What is salts-tools](/guide/salts-tools) first.

> What to expect:
>
> - Your agent can only search while your computer is on, awake and connected to the internet.
> - You will install three free tools: Docker, Node.js and cloudflared. You do not need an account for any of them.

1. Follow [Install salts-tools](/guide/salts-tools-install). Make sure you install Docker in step 1, since the search engine needs it.
2. In the salts-tools screen, open your agent in the **Agents** tab and press **Enter** on **Web search**. salts-tools connects it to that agent within a few seconds.
3. If **Web search** is switched off in the agent's **Capabilities**, the agent shows it as **to do**: press **Enter** on it to switch it on.
4. Leave **Brave Search API key** empty in **Capabilities**. When a Brave key is set, your agent uses Brave instead, and salts-tools reminds you of that.

## You are done

Ask your agent something that needs the web, for example "What is the weather in Mumbai today?". Your agent will search on its own whenever a question needs it, so you do not have to ask it to search.

If you also want your agent to open search results and read the full page, switch on **Read a URL** in **Capabilities**.

## Footnotes

1. If your agent stops searching with salts-tools, check that your computer is awake and online, then run `npx salts-tools restart`. See [Everyday use](/guide/salts-tools-everyday) for the other commands.
2. If the salts-tools screen says `disconnected`, run `npx salts-tools` to connect your computer again.
3. If your agent is not searching when it should, add this to **Custom instructions** in **Settings**: "Search the web for anything about current events, prices or dates." A stronger model also helps.
