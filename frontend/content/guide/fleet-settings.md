---
title: Choose the fleet's settings
section: Fleets
order: 4
summary: Decide how every agent in your fleet is set up, and which settings your users are allowed to change.
---

Fleet settings are the settings every agent in your fleet starts with. They also decide which settings your users are allowed to change. You choose them when you create the fleet, and you can change them at any time using the **Fleet Settings** button on your fleet.

## Locking a setting

Most settings have a lock next to them.

- **Unlocked** settings are where every agent starts, and each user can change them on their own agent.
- **Locked** settings are hidden from your users, and only you can change them.

We recommend locking settings that cost you money, and leaving the rest unlocked so your users can make their agent their own.

## The settings

| Setting | What it does |
|---|---|
| **OpenRouter** | The OpenRouter API key every agent uses. Lock it if you are paying and do not want users to replace it with their own key. |
| **Monthly spend limit** | How much each agent can spend in a calendar month, in US dollars. 0 means no limit. Users can see it but cannot change it. |
| **Member limit** | How many other people each user can add to their agent. 0 means no limit. Users cannot change it. |
| **Model options** | The list of models your users can choose from. Enter each model's OpenRouter ID, for example `anthropic/claude-haiku-4.5`. Leave it empty to use the default list. |
| **Model** | The model every agent starts on. Lock it if you want everyone on the same model. |
| **Custom instructions** | Instructions every agent reads before each conversation. Lock them if the agents must stay on one subject or use your company's tone. |
| **Extended reasoning**, **Creativity**, **Reply length cap**, **Context window** | How the agent thinks and answers. See [Choose the right model](/guide/choosing-a-model). Extended reasoning and longer replies cost more, so lock them if you want to keep costs down. |
| **Capabilities** | What the agents can do, such as web search, files, images, voice notes, reminders and memory. |
| **MCP templates** | Which ready-made app connections your users can pick from. Selecting none shows all of them. |
| **MCP servers** | App connections added to every agent. **Allow adding more MCP servers** decides whether users can add their own. |

## Leave Telegram and WhatsApp empty

> [!warning]
> Do not enter a Telegram bot token or WhatsApp details in fleet settings. A bot can only belong to one agent, so if every agent in the fleet gets the same one, only one of them will receive messages.

Leave **Telegram** and **WhatsApp** unlocked and empty, and let each user connect their own using [Connect your agent to Telegram](/guide/telegram) or [Connect your agent to WhatsApp](/guide/whatsapp).

For the same reason, only add app connections that each user signs in to with their own account. An app connected with your own login would give every user access to your data.

## A good starting point

If you are not sure what to choose, we recommend starting with this and adjusting later:

1. Your OpenRouter API key, locked.
2. A monthly spend limit you are comfortable paying for every agent.
3. **Model** unlocked, with a short list of **Model options** you have tried yourself.
4. Everything else left as it is.

Keep in mind that saving new fleet settings later overwrites every agent in the fleet, including anything your users changed themselves. See [Manage your fleet](/guide/manage-fleet).
