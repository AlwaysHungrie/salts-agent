---
title: Choose the right model
section: Managing costs
order: 1
summary: Which model to pick, when to pay for a better one, and the settings that change how it answers.
featured: true
---

The model is what reads your messages and writes your agent's replies. Different models are good at different things and are priced very differently, so the most expensive model is not always the best choice.

You can pick the model in your agent's **Settings** under **Model**, and change it at any time. The next reply will use the new model, even in the middle of a conversation.

On Telegram or WhatsApp, you can also switch with `!model` and the model's nickname, which is the part of its name in brackets. For example, `!model ds` switches to **DeepSeek V4.1 Flash (ds)**. See [Commands](/guide/commands).

## Start with the default

Your agent starts on a model that is cheap and fast, and good enough for everyday questions, writing, summaries and reminders. We recommend using it for a few days before you change anything.

## When to switch

| If your agent | Try this |
|---|---|
| Needs to read photos or screenshots | Pick a model that is not marked **(no image)**. Those models cannot see images. |
| Gets harder questions wrong | Pick a stronger model, or turn on **Extended reasoning**. |
| Does not search the web or use your connected apps when it should | Pick a stronger model. Cheaper models are worse at deciding when to use their tools. |
| Costs more than you expected | Pick a cheaper model, and read [Why and when to compact](/guide/compacting). |

You can compare the prices of every model on [openrouter.ai/models](https://openrouter.ai/models). Prices are listed per million tokens, and a token is roughly three quarters of a word.

## Extended reasoning

**Extended reasoning** lets the model think before it answers. This gives better answers on hard problems such as planning, maths and code, but replies take longer and cost more, because the thinking is billed too.

We recommend leaving it **Off** for everyday use. If you notice your agent getting hard questions wrong, try **Low** or **Medium**. **High** is the slowest and most expensive option.

## Other settings

- **Creativity** controls how varied the answers are. Keep it low for facts and raise it for brainstorming.
- **Reply length cap** is the longest a single reply can be. Leave it at **No cap** unless replies are too long.
- **Context window** is how much of the conversation your agent reads before every reply. **Full history** is the default. A smaller window makes replies cheaper, but your agent forgets anything older than that.
- **Custom instructions** are read by your agent before every conversation. Use them to tell it how you want it to reply, for example "Answer in short paragraphs."

## Footnotes

1. Image generation, voice-note transcription and voice replies each use their own model, which you pick on the **Capabilities** page.
2. Some models do not work on WhatsApp. See [WhatsApp gotchas](/guide/whatsapp-gotchas).
