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

## 2. Get salts-tools

There is nothing else to download. Node.js comes with `npx`, which fetches salts-tools the first time you run it, so every command in these guides starts with `npx salts-tools`.

## 3. Connect your computer

In your terminal, run:

```
npx salts-tools
```

salts-tools checks that cloudflared is installed, then shows a short code and opens this site in your browser. Check that the code on the page matches the one in your terminal, and click **Connect**. That is the only step in the browser, and there is nothing to copy or paste.

## 4. Choose your tools

Back in your terminal, salts-tools opens its screen on the **Agents** tab. It only lists the agents you add to this computer, so if you have many agents you only see the ones it works for. To add one, press **a**, paste the agent's ID and press **Enter**. The ID is the part after `/a/` in the agent's address on this site, and you can paste the whole link instead.

salts-tools then opens the agent. Press **Enter** on each tool you want for it, and salts-tools connects it to that agent within a few seconds. Press **Esc** to go back to the list.

If a tool needs something more, the agent shows it as **to do**: press **Enter** on it to fix it. For example, the analyst needs **File ingest** switched on, which salts-tools does for you, and the matchmaker needs your OpenRouter key, which you type in right there. If something is missing on your computer, such as Docker for web search, the **Services** tab shows that tool as `error` and says what to install.

## 5. Start at login

Finally, salts-tools asks in the terminal whether it should start automatically when you log in. We recommend saying yes, otherwise your agent loses its tools every time you restart your computer. You can change this later with `npx salts-tools autostart on` or `off`.

## You are done

Your computer is connected. To give another agent these tools, press **a** in the **Agents** tab to add it, then switch them on.

Next, read [Everyday use](/guide/salts-tools-everyday) to learn the salts-tools screen and the commands you will use day to day.
