---
title: Set up web search
section: Advanced use
order: 1
summary: Give your agent the live web, for free, with a private search engine that runs on your Mac.
---

Without web search, your agent only knows what its model learned when it was trained, so it cannot tell you today's news, a current price or whether a shop is open. With web search switched on, your agent can look things up and tell you where the answer came from.

This guide will help you run your own free search engine, called SearXNG, on your Mac and connect it to your agent. You will need to use the Terminal app, but every command you need is on this page. If you would rather not run anything on your Mac, skip to [Using Brave instead](#using-brave-instead).

> What to expect:
>
> - This only works on a Mac.
> - Your agent can only search while your Mac is on, awake and connected to the internet.
> - You will install three free tools: Docker, Node.js and ngrok. You will also need a free ngrok account.

## 1. Install the tools

1. Install [Docker Desktop](https://www.docker.com/products/docker-desktop/). If you already use OrbStack or Colima, those work too.
2. Install [Node.js](https://nodejs.org), version 20 or later.
3. Install ngrok. If you use Homebrew, run this in Terminal:

   ```
   brew install ngrok
   ```

   Otherwise, download it from [ngrok.com/download](https://ngrok.com/download).

4. Create a free account on [ngrok.com](https://ngrok.com) and open [your authtoken page](https://dashboard.ngrok.com/get-started/your-authtoken). Keep this tab open, since you will need the authtoken in step 3.

## 2. Download salts-web

salts-web is a small program that starts the search engine and connects it to your agent. In Terminal, run these three commands one at a time:

```
git clone https://github.com/AlwaysHungrie/serverless-agent.git
cd serverless-agent/salts-web
npm link
```

## 3. Start salts-web

First, open your agent in the browser and copy its agent ID. It is the part of the address after `/a/`:

```
https://salts-agent-app.vercel.app/a/<your-agent-id>
```

Then run:

```
salts-web start
```

salts-web will ask you a few questions:

1. **ngrok authtoken**: paste the authtoken from step 1. You only need to do this once.
2. **Agent ID**: paste your agent ID.
3. salts-web will then show you a **token**. Copy it, and leave Terminal open while you do the next step.

## 4. Add the token to your agent

Open your agent, go to **Capabilities**, and find **Web search**.

1. Switch **Web search** on.
2. Paste the token into **SearXNG token** and save.
3. Leave **Brave Search API key** and **SearXNG URL** empty. salts-web fills in the URL for you.

Go back to Terminal and press **Enter**. When salts-web is done, you will see three green ticks, ending with `agent <your-agent-id> now searches through it`.

Finally, salts-web asks whether it should start automatically when you log in. We recommend saying yes, otherwise your agent loses web search every time you restart your Mac.

## You are done

Ask your agent something that needs the web, for example "What is the weather in Mumbai today?". Your agent will search on its own whenever a question needs it, so you do not have to ask it to search.

If you also want your agent to open search results and read the full page, switch on **Read a URL** in **Capabilities**.

## Everyday commands

| Command | What it does |
|---|---|
| `salts-web start` | Starts the search engine. |
| `salts-web stop` | Stops the search engine. |
| `salts-web restart` | Restarts the search engine and reconnects it to your agent. |
| `salts-web setup` | Asks the setup questions again, for example to connect a different agent. |
| `salts-web reset` | Forgets the token and agent ID. Run `salts-web stop` first. |
| `salts-web autostart on` | Starts salts-web when you log in. Use `off` to turn this off. |

## Using Brave instead

If you would rather not run anything on your Mac, you can use Brave's search API instead. Brave has a free plan that is enough for one person. Create an account at [brave.com/search/api](https://brave.com/search/api/), subscribe to the free plan, and paste your key into **Brave Search API key** under **Web search** in your agent's **Capabilities**. Brave asks for a card, and any searches beyond the free plan are billed by Brave.

## Footnotes

1. If your agent stops searching, check that your Mac is awake and online, then run `salts-web restart`.
2. If salts-web says your agent refused the token, paste the token into **SearXNG token** again, save, and choose **retry**.
3. If your agent is not searching when it should, add this to **Custom instructions** in **Settings**: "Search the web for anything about current events, prices or dates." A stronger model also helps.
