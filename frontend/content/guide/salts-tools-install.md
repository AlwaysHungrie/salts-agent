---
title: Install salts-tools
section: salts-tools
order: 2
summary: Install salts-tools on your computer, connect it to your agent and start your first tool.
---

salts-tools runs extra tools for your agent on your own computer, such as free web search. If you are not sure what it is yet, read [What is salts-tools](/guide/salts-tools) first.

This guide will help you install salts-tools, connect it to your agent and start your first tool. It takes about fifteen minutes, most of which is waiting for downloads. You will need your agent open in the browser and a terminal (the Terminal app on a Mac, PowerShell on Windows).

## 1. Install the tools salts-tools needs

1. Install [Node.js](https://nodejs.org), version 20 or later.
2. Install cloudflared, which gives your computer the secure address your agent uses. You do not need a Cloudflare account. On a Mac with Homebrew, run this in Terminal:

   ```
   brew install cloudflared
   ```

   On Windows, run this in PowerShell:

   ```
   winget install --id Cloudflare.cloudflared
   ```

   Otherwise, download it from [Cloudflare's downloads page](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/).

3. If you want **web**, install [Docker Desktop](https://www.docker.com/products/docker-desktop/). If you already use OrbStack or Colima, those work too. You do not need to start Docker yourself, since salts-tools starts it when it is needed. On Linux you can use Docker Engine instead; we recommend starting it with `sudo systemctl enable --now docker` and adding yourself to the `docker` group, so salts-tools can use it without asking for your password.
4. If you want **matchmaker** or **analyst**, install [uv](https://docs.astral.sh/uv/getting-started/installation/). salts-tools uses it to set these tools up the first time you start them.

If you only want the spreadsheet analyst, you can skip Docker.

## 2. Download salts-tools

In your terminal, run these three commands one at a time:

```
git clone https://github.com/AlwaysHungrie/salts-agent.git
cd salts-agent/salts-tools
npm link
```

The last command lets you type `salts-tools` from any folder.

## 3. Start salts-tools

First, open your agent in the browser and copy its agent ID. It is the part of the address after `/a/`:

```
https://salts-agent-app.vercel.app/a/<your-agent-id>
```

Then start salts-tools with the tool you want first. For web search, run:

```
salts-tools start web
```

Use `matchmaker` or `analyst` in place of `web` to start one of those instead. salts-tools checks that everything from step 1 is installed, and then asks you a few questions:

1. **Agent IDs**: paste your agent ID. To give several agents these tools from the same computer, paste all their IDs with a space between each one.
2. salts-tools will then show you a **token**. Copy it, and leave your terminal open while you do the next step.

## 4. Add the token to your agent

Open your agent, go to **Capabilities**, and find **Web search**. If you entered several agent IDs, do this for each of those agents, using the same token.

1. Paste the token into **SearXNG token** and save.
2. If you are setting up web search, switch **Web search** on, and leave **Brave Search API key** and **SearXNG URL** empty. salts-tools fills in the URL for you.

The token lives under **Web search** even if you only want the matchmaker or the analyst, since it is how your agent knows the tools really come from you.

Go back to your terminal and press **Enter**. salts-tools starts your tool and connects it to your agent. When it is done, you will see green ticks followed by `live for agent <your-agent-id>`.

## 5. Start at login

Finally, salts-tools asks whether it should start automatically when you log in. We recommend saying yes, otherwise your agent loses its tools every time you restart your computer. You can change this later with `salts-tools autostart on` or `off`.

## You are done

Your first tool is running. To add another one, run `salts-tools start` followed by its name, for example `salts-tools start analyst`. It joins the one that is already running, so you do not have to set anything up again.

Next, read [Everyday use](/guide/salts-tools-everyday) to learn the salts-tools screen and the commands you will use day to day.
