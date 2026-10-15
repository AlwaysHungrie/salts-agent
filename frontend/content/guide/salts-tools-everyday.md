---
title: Everyday use
section: salts-tools
order: 5
summary: The salts-tools screen, the commands you will use day to day, and what to do when something stops working.
---

Once salts-tools is installed, it mostly looks after itself. It checks on every tool every 30 seconds, restarts anything that has stopped, and reconnects your agent if your computer goes to sleep or changes network. This page covers the few things you might want to do yourself.

## The salts-tools screen

Run `salts-tools` on its own to open a screen that shows what is running and whether each agent is connected. It has four tabs:

| Tab | What it shows |
|---|---|
| **1 Services** | Each tool and whether it is `live`. Press **Enter** on a tool to see what to set on your agent for it. Press **s** to start or stop a tool. |
| **2 Agents** | Each agent salts-tools serves and whether it is `connected`. Press **a** to add an agent and **x** to remove one. Press **Enter** on an agent to choose which tools it gets: **Enter** switches a tool on or off for that agent only. |
| **3 Settings** | Your token, whether salts-tools starts at login, and where its files live. Press **n** to make a new token. |
| **4 Log** | What salts-tools has been doing, newest at the bottom. |

Use the arrow keys or the numbers **1** to **4** to move around, **c** to copy your token, and **q** to quit. When something is wrong, the line under the list tells you what to do about it. Quitting the screen leaves your tools running.

## Everyday commands

| Command | What it does |
|---|---|
| `salts-tools` | Opens the salts-tools screen. |
| `salts-tools start` | Starts the tools that were running last time. |
| `salts-tools start analyst` | Starts one tool, alongside any that are already running. You can name several, for example `salts-tools start web analyst`. |
| `salts-tools stop analyst` | Stops one tool and leaves the others running. |
| `salts-tools stop` | Stops everything. The next `salts-tools start` brings back the same tools. |
| `salts-tools restart` | Gets a fresh address and reconnects every agent. |
| `salts-tools setup` | Asks the setup questions again, for example to add or remove agents. Enter the full list of agent IDs each time. |
| `salts-tools autostart on` | Starts salts-tools when you log in. Use `off` to turn this off. |
| `salts-tools reset` | Forgets your token and agents, so you can start again from scratch. Run `salts-tools stop` first. The matchmaker's people and jobs are kept. |

## Making a new token

If you think someone else has seen your token, open the salts-tools screen, go to **3 Settings** and press **n**. Then paste the new token into **SearXNG token** under **Web search** in each agent's **Capabilities**, and save. Until you do, those agents cannot reach your tools.

## Footnotes

1. If your agent stops using a tool, check that your computer is awake and online, then run `salts-tools restart`.
2. If the screen says `token refused`, that agent does not have your current token. Press **c** to copy it, paste it into **SearXNG token** under **Web search**, and save.
3. If a tool says `offline`, salts-tools cannot reach the internet right now. It keeps trying every 30 seconds, so you do not need to do anything once you are back online.
4. If a tool stays on `starting` for a long time, look at the **4 Log** tab to see what it is waiting for.
