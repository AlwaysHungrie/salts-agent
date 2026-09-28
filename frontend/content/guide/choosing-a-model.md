---
title: Choose the right model
section: Managing costs
order: 1
summary: Which model to pick, when to pay for a better one, and the settings that change how it answers.
featured: true
---

The model is the part of your agent that reads your message and writes the reply. Different models are better at different things, and they are priced very differently. A more expensive model is not always a better choice.

You pick the model in your agent's **Settings** under **Model**. You can change it at any time. The next reply uses the new model, in the same conversation.

## Start with the default

The model your agent starts on is cheap and fast. It is good enough for everyday questions, writing, summaries and reminders. Use it for a few days before you change anything.

## When to switch

| If your agent | Try this |
|---|---|
| Needs to read photos or screenshots | Pick a model that is not marked **(no image)**. A model that cannot see will fail on every image you send. |
| Gets facts or reasoning wrong on harder questions | Pick a stronger model, or turn on **Extended reasoning**. |
| Does not use its tools, or uses them badly | Pick a stronger model. Cheaper models are worse at deciding when to search the web or call an MCP server. |
| Costs more than you expected | Pick a cheaper model, and read [Why and when to compact](/guide/compacting). |

Prices for every model are listed on [openrouter.ai/models](https://openrouter.ai/models). They are quoted per million tokens. A token is roughly three quarters of a word.

## Extended reasoning

**Extended reasoning** lets the model think before it answers. Answers get better on hard problems, such as planning, maths and code. They also get slower and more expensive, because the thinking is billed too.

Leave it **Off** for ordinary chatting. Try **Low** or **Medium** when you notice the agent getting hard questions wrong. **High** is the slowest and most expensive.

## The other settings

- **Creativity**: low keeps answers literal and predictable. High makes them varied. Keep it low for facts and high for brainstorming.
- **Reply length cap**: the longest a single reply can be. Leave it at **No cap** unless replies are running on for too long.
- **Context window**: how much of the conversation the agent reads on every turn. **Full history** is the default. A lower number makes every reply cheaper, but the agent forgets anything older than that.
- **Custom instructions**: what the agent is told before every chat. Write how you want it to reply, for example "Answer in short paragraphs."

## Footnotes

1. Image generation, voice-note transcription and spoken replies are not done by this model. Each picks its own model on the **Capabilities** page.
2. A model that works in your browser can fail on WhatsApp. See [WhatsApp gotchas](/guide/whatsapp-gotchas).
3. If your agent is part of a fleet, some of these settings may be missing. The person who runs the fleet has locked them.
