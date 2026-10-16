---
title: Everyday use
section: salts-tools
order: 5
summary: The salts-tools screen, the commands you will use day to day, and what to do when something stops working.
---

Once salts-tools is installed, it mostly looks after itself. It checks on every tool every 30 seconds, restarts anything that has stopped, and reconnects your agents if your computer goes to sleep or changes network. This page covers the few things you might want to do yourself.

## The salts-tools page

The [salts-tools page](/salts-tools) on this site is where you manage everything. For each computer you have connected, it shows:

- whether the computer is **online**, and when it was last seen;
- which tools it can run, and anything missing on the computer for one of them;
- each agent it serves, with a switch for every tool;
- anything still to do on an agent before a tool works there, with a button to fix it.

To give another agent these tools, choose it under **Use this computer for another agent**. To stop serving an agent, click **Remove** next to it. salts-tools takes its tools off that agent for you. **Disconnect** removes the computer from your account and takes its tools off every agent.

## The salts-tools screen

Run `npx salts-tools` in a terminal to open a screen that shows what is running on your computer. It has four tabs:

| Tab | What it shows |
|---|---|
| **1 Services** | Each tool and whether it is `live`. Press **Enter** on a tool for its address, its log and where its files live. |
| **2 Agents** | The agents this computer serves, and the tools on for each. Press **Enter** to open the salts-tools page. |
| **3 Settings** | Whether the computer is connected, whether salts-tools starts at login, and where its files live. |
| **4 Log** | What salts-tools has been doing, newest at the bottom. |

Use the arrow keys or the numbers **1** to **4** to move around, **o** to open the salts-tools page, and **q** to quit. When something is wrong, the line under the list tells you what to do about it. Quitting the screen leaves your tools running.

## Everyday commands

| Command | What it does |
|---|---|
| `npx salts-tools` | Starts salts-tools if it is not running (connecting your computer the first time), then opens the salts-tools screen. |
| `npx salts-tools start` | Starts salts-tools without opening the screen. |
| `npx salts-tools stop` | Stops everything. The next `npx salts-tools start` brings back the same tools. |
| `npx salts-tools restart` | Gets a fresh address. Your agents follow it on their own. |
| `npx salts-tools autostart on` | Starts salts-tools when you log in. Use `off` to turn this off. |
| `npx salts-tools reset` | Disconnects this computer, takes its tools off every agent and forgets everything, so you can start again from scratch. The matchmaker's people and jobs and the analyst's files are kept. |

## Footnotes

1. If your agent stops using a tool, check that your computer is awake and online. The salts-tools page shows it as **Offline** otherwise. Then run `npx salts-tools restart`.
2. If the screen says `disconnected`, the computer was disconnected on the salts-tools page. Run `npx salts-tools` to connect it again.
3. If a tool says `missing`, something it needs is not installed on your computer. The line under the list says what to install.
4. If a tool stays on `starting` for a long time, look at the **4 Log** tab to see what it is waiting for.
