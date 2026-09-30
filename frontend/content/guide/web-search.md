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
> - You will install three free tools: Docker, Node.js and ngrok. You will also need a free ngrok account.

## 1. Install the tools

1. Install [Docker Desktop](https://www.docker.com/products/docker-desktop/). If you already use OrbStack or Colima, those work too. On Linux you can use Docker Engine instead; we recommend starting it with `sudo systemctl enable --now docker` and adding yourself to the `docker` group, so salts-tools can use it without asking for your password.
2. Install [Node.js](https://nodejs.org), version 20 or later.
3. Install ngrok. On a Mac with Homebrew, run this in Terminal:

   ```
   brew install ngrok
   ```

   On Windows, run this in PowerShell:

   ```
   winget install ngrok.ngrok
   ```

   Otherwise, download it from [ngrok.com/download](https://ngrok.com/download).

4. Create a free account on [ngrok.com](https://ngrok.com) and open [your authtoken page](https://dashboard.ngrok.com/get-started/your-authtoken). Keep this tab open, since you will need the authtoken in step 3.

## 2. Download salts-tools

salts-tools is a small program that starts the search engine and connects it to your agent. In your terminal, run these three commands one at a time:

```
git clone https://github.com/AlwaysHungrie/salts-agent.git
cd salts-agent/salts-tools
npm link
```

## 3. Start salts-tools

First, open your agent in the browser and copy its agent ID. It is the part of the address after `/a/`:

```
https://salts-agent-app.vercel.app/a/<your-agent-id>
```

Then run:

```
salts-tools start
```

salts-tools will ask you a few questions:

1. **ngrok authtoken**: paste the authtoken from step 1. You only need to do this once.
2. **Agent ID**: paste your agent ID.
3. salts-tools will then show you a **token**. Copy it, and leave your terminal open while you do the next step.

## 4. Add the token to your agent

Open your agent, go to **Capabilities**, and find **Web search**.

1. Switch **Web search** on.
2. Paste the token into **SearXNG token** and save.
3. Leave **Brave Search API key** and **SearXNG URL** empty. salts-tools fills in the URL for you.

Go back to your terminal and press **Enter**. When salts-tools is done, you will see three green ticks, ending with `SearXNG: agent <your-agent-id> reaches it at …`.

Finally, salts-tools asks whether it should start automatically when you log in. We recommend saying yes, otherwise your agent loses web search every time you restart your computer.

## You are done

Ask your agent something that needs the web, for example "What is the weather in Mumbai today?". Your agent will search on its own whenever a question needs it, so you do not have to ask it to search.

If you also want your agent to open search results and read the full page, switch on **Read a URL** in **Capabilities**.

## Everyday commands

| Command | What it does |
|---|---|
| `salts-tools start` | Starts the search engine. |
| `salts-tools stop` | Stops the search engine. |
| `salts-tools restart` | Restarts the search engine and reconnects it to your agent. |
| `salts-tools setup` | Asks the setup questions again, for example to connect a different agent. |
| `salts-tools reset` | Forgets the token and agent ID. Run `salts-tools stop` first. |
| `salts-tools autostart on` | Starts salts-tools when you log in. Use `off` to turn this off. |

## Using Brave instead

If you would rather not run anything on your computer, you can use Brave's search API instead. Brave has a free plan that is enough for one person. Create an account at [brave.com/search/api](https://brave.com/search/api/), subscribe to the free plan, and paste your key into **Brave Search API key** under **Web search** in your agent's **Capabilities**. Brave asks for a card, and any searches beyond the free plan are billed by Brave.

## Footnotes

1. If your agent stops searching, check that your computer is awake and online, then run `salts-tools restart`.
2. If salts-tools says your agent refused the token, paste the token into **SearXNG token** again, save, and choose **retry**.
3. If your agent is not searching when it should, add this to **Custom instructions** in **Settings**: "Search the web for anything about current events, prices or dates." A stronger model also helps.
