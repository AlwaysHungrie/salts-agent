---
title: Choose the fleet's settings
section: Fleets
order: 4
summary: Decide how every agent in your fleet is set up, and which settings your users are allowed to change.
---

Fleet settings are the settings every agent in your fleet starts with. They also decide what your users are allowed to change. You choose them when you create the fleet, and you can change them at any time from the **Fleet Settings** button on your fleet.

## Locks

Next to most settings is a lock. It decides who is in charge of that setting.

- **Unlocked**: what you enter is where every agent starts. Each user can change it on their own agent.
- **Locked**: what you enter is the only value. The setting is hidden from your users, and only you can change it.

Lock what costs you money, or what you have promised someone. Leave the rest unlocked, so users can make their agent their own.

## The settings, one by one

| Setting | What it does | Lock it when |
|---|---|---|
| **OpenRouter** | The key every agent uses to pay for its replies. | You are paying, and do not want users swapping in their own key. |
| **Monthly spend limit** | How much each agent can spend in a calendar month, in US dollars. Each agent has its own limit. 0 means no limit. | This has no lock. Users can see it but never change it. |
| **Member limit** | How many other people each user can add to their own agent. 0 means no limit. | This has no lock. Users can never change it. |
| **Model options** | The list of models users can choose from. Enter a model's OpenRouter ID, for example `anthropic/claude-haiku-4.5`. Empty means the default list. | This has no lock. Users can only pick from this list. |
| **Model** | The model every agent starts on. | You want everyone on the same model. |
| **Custom instructions** | What every agent is told before every conversation. | The agents must stay on one subject or speak in your company's tone. |
| **Extended reasoning**, **Creativity**, **Reply length cap**, **Context window** | How the agent thinks and answers. See [Choose the right model](/guide/choosing-a-model). | Reasoning and reply length raise costs. Lock them to keep costs down. |
| **Capabilities** | What the agents can do: web search, files, images, voice notes, reminders, memory. Enter any keys a capability needs. | You do not want users switching a capability on or off. |
| **MCP templates** | Which ready-made app connections users see. None selected means all of them. | This has no lock. |
| **MCP servers** | App connections created in every agent. **Allow adding more MCP servers** decides whether users can add their own. | You want users to connect only the apps you chose. |

The image, transcription and voice model options work like **Model options**, for the capabilities that use them.

## Leave these empty

> [!warning]
> Do not enter a Telegram bot token or WhatsApp details in fleet settings. Every agent in the fleet would get the same bot, but a bot can only belong to one agent. Only one agent would receive messages, and nobody would know which.

Leave **Telegram** and **WhatsApp** unlocked and empty. Each user connects their own bot or number, using [Connect your agent to Telegram](/guide/telegram) or [Connect your agent to WhatsApp](/guide/whatsapp).

The same goes for an MCP server that signs in with your own token or password. Every user would use it as you, with your access to your data. Only add servers that each user signs in to with their own account.

## A good starting point

If you are not sure, start with this and change it later:

1. Your OpenRouter key, locked.
2. A monthly spend limit you are comfortable paying for every agent.
3. **Model** left unlocked, with a short list of **Model options** you have tried.
4. Everything else as it is.

## Changing the settings later

See [Manage your fleet](/guide/manage-fleet). Saving new fleet settings overwrites every agent in the fleet, including anything your users changed themselves.
