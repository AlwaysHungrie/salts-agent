---
title: Set up web search
section: Advanced use
order: 1
summary: Give your agent the live web, for free, with a private search engine that runs on your Mac.
---

Without web search, your agent only knows what its model learned before it was released. It cannot tell you today's news, a current price or whether a shop is open. With web search, it looks things up and tells you where the answer came from.

This guide will help you run your own search engine, SearXNG, on your Mac and connect it to your agent. It costs nothing, needs no account with a search company, and your searches are not tied to you. You will need to use the Terminal app, but every command you need is on this page.

> What to expect:
>
> - This only works on a Mac.
> - Your agent can only search while your Mac is on, awake and connected to the internet. When it is asleep, searches fail and your agent answers from what it already knows.
> - You will install three free tools: Docker, ngrok and Node.js. You will need a free ngrok account.
> - A small program called salts-web does the rest. It starts the search engine, makes it reachable from the internet, and keeps your agent pointed at it.

## 1. Install the tools

1. Install [Docker Desktop](https://www.docker.com/products/docker-desktop/). It runs the search engine. OrbStack or Colima work too, if you already use one of them.
2. Install [Node.js](https://nodejs.org), version 20 or later.
3. Install ngrok. It makes the search engine on your Mac reachable by your agent. If you use Homebrew, run this in Terminal:

   ```
   brew install ngrok
   ```

   Otherwise, download it from [ngrok.com/download](https://ngrok.com/download).

4. Create a free account on [ngrok.com](https://ngrok.com) and open [your authtoken page](https://dashboard.ngrok.com/get-started/your-authtoken). Keep it open. You will need the authtoken in step 3.

## 2. Download salts-web

In Terminal, run these three commands, one at a time:

```
git clone https://github.com/AlwaysHungrie/serverless-agent.git
cd serverless-agent/salts-web
npm link
```

The last command adds the `salts-web` command to your Mac.

## 3. Start it

Before you start, open your agent in the browser and copy its agent ID. It is the part of the address after `/a/`:

```
https://salts-agent-app.vercel.app/a/<your-agent-id>
```

Then run:

```
salts-web start
```

It asks you a few questions, in this order:

1. **ngrok authtoken**: paste the authtoken from step 1. It only asks this once.
2. **Agent ID**: paste your agent ID.
3. salts-web shows you a **token**, once. Copy it. Leave Terminal open and do step 4 before you go on.

## 4. Give the token to your agent

Open your agent, then **Capabilities**, then **Web search**.

1. Switch **Web search** on.
2. Paste the token into **SearXNG token**.
3. Leave **Brave Search API key** empty. If it has a key in it, your agent uses Brave and ignores SearXNG.
4. Leave **SearXNG URL** empty. salts-web fills it in for you.

Go back to Terminal and press **Enter**.

salts-web starts the search engine, connects it to the internet, and sends the address to your agent. When it is done, you will see three green ticks, ending with `agent <your-agent-id> now searches through it`.

Finally, it asks whether to start salts-web automatically when you log in. Say yes. Otherwise your agent loses web search every time you restart your Mac.

## You are done

Ask your agent something that needs the web, for example "What is the weather in Mumbai today?". It searches on its own when a question needs it. You do not have to say "search".

To have your agent open a result and read the whole page, not just the short preview, also switch on **Read a URL** in **Capabilities**.

## Everyday commands

| Command | What it does |
|---|---|
| `salts-web start` | Starts everything. The first time, it also asks the setup questions. |
| `salts-web stop` | Stops the search engine and disconnects it from the internet. |
| `salts-web restart` | Reconnects to the internet with a new address, and sends it to your agent. |
| `salts-web setup` | Asks the setup questions again, for example to switch to a different agent. |
| `salts-web reset` | Forgets the token and your agent ID. Run `salts-web stop` first. The next `start` begins from step 3. |
| `salts-web autostart on` | Starts salts-web when you log in. `off` stops that. |

## If you would rather not run anything

Brave sells access to its search engine, and has a free plan that covers one person's use. Create an account at [brave.com/search/api](https://brave.com/search/api/), subscribe to the free plan, and paste the key into **Brave Search API key**. Nothing needs to run on your Mac. Brave asks for a card, and searches beyond the free plan are billed by Brave.

## Footnotes

1. If your agent stops searching, check that your Mac is awake and online, then run `salts-web restart`. salts-web also checks every 30 seconds and fixes most problems on its own.
2. If salts-web says the agent refused the token, the token was not saved in your agent. Paste it into **SearXNG token** again, save, and choose **retry**.
3. The token keeps strangers from using your search engine. salts-web keeps it in your Mac's Keychain and never writes it to a file.
4. If your agent should have searched and did not, add this to **Custom instructions** in **Settings**: "Search the web for anything about current events, prices or dates." A stronger model also helps. See [Choose the right model](/guide/choosing-a-model).
