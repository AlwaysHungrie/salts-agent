---
title: What your agent can do
section: Using your agent
order: 1
summary: Every capability on the Capabilities page, such as web search, files, images, voice notes, reminders and memory, what each one does and how to use it.
featured: true
---

A new agent can only read and write text. Everything else, such as searching the web or setting reminders, is a capability that you switch on from your agent's **Capabilities** page. Most of them are off when you create an agent.

We recommend switching on only the capabilities you will use. Most capabilities give your agent new tools, and every tool is described to the model with every message, so each one makes every reply a little more expensive, even when it is not used.

Once a capability is on, you do not need to tell your agent to use it. Just ask in your own words, and your agent works out what to do.

## Web search

Lets your agent look things up on the internet, so it can tell you today's news, a current price or whether a shop is open, along with links to where it found the answer. Without it, your agent only knows what its model learned when it was trained.

Web search needs a search engine to work. You can either run one for free on your own computer with salts-tools, or paste a Brave Search API key. [Set up web search](/guide/web-search) walks you through both.

## Read a URL

Lets your agent open a link you send it and read the page, for example "Summarise this article" followed by the link. Together with **Web search**, it also lets your agent read the full pages it finds, not just the search results.

## File ingest

Lets you attach files in the chat and ask questions about them, for example "What does this contract say about cancellation?". It works with PDFs up to 8 MB, and with text files such as Markdown, CSV, JSON and code up to 1 MB.

Excel workbooks cannot be read this way. To work with spreadsheets, see [Add the spreadsheet analyst](/guide/salts-tools-analyst).

## Image input

Lets your agent see the photos and screenshots you send it, for example "What does this error message mean?" with a screenshot attached.

Not every model can see images. Models marked **(no image)** in **Settings** cannot, and that includes the model your agent starts with. If you switch this on, also pick a model that can. See [Choose the right model](/guide/choosing-a-model).

## Image generation

Lets your agent create pictures when you ask for them, for example "Draw a birthday card with a cat on it". You can pick the **Image model** it uses. Images are billed to your OpenRouter key like any other reply, and usually cost more than a text reply.

## Audio input

Lets your agent listen to voice notes and audio files, so you can talk to it instead of typing. This is most useful on Telegram and WhatsApp. You can pick the **Transcription model**, which is the model that turns speech into text.

## Voice notes

Lets your agent reply with a voice note on Telegram and WhatsApp. The reply is still sent as text as well, and the voice note comes with it. Ask for it in your own words, for example "Reply with a voice note". You can pick the **Voice model** it uses.

## Schedule tasks

Lets your agent do something at a time you choose, once or again and again. For example:

- "Remind me to call the bank at 4pm."
- "Every Monday at 9am, send me a list of what is due this week."
- "Every morning, check the weather in Mumbai and tell me if I need an umbrella."

The answer arrives in the conversation where you set it up, including on Telegram or WhatsApp. You can ask your agent which tasks are scheduled, or ask it to cancel one. Each time a task runs it is billed like a normal reply.

Scheduled tasks belong to a conversation. They carry over when you send `!new`, but deleting the conversation also deletes its tasks. On WhatsApp, a task can only reach you within 24 hours of the last message you sent. See [WhatsApp gotchas](/guide/whatsapp-gotchas).

## Private Memory

Lets your agent remember things you tell it, such as your name, your preferences or a decision you made, and use them in every future conversation. Without it, your agent forgets everything when you start a new conversation.

Your agent decides on its own what is worth remembering, and you can also ask it directly, for example "Remember that I am vegetarian". Its memory is private to this agent. Your other agents do not see it.

Anyone who can talk to your agent can ask it what it remembers. If your agent is used by other people, read [Telegram safety tips](/guide/telegram-safety) first.

## MCP servers

Connects your agent to other apps, such as Notion and GitHub, so it can do things in them for you. This one is always on, and does nothing until you add a server. See [What is an MCP server](/guide/mcp).

## Footnotes

1. Telegram and WhatsApp are set up from your agent's **Settings**, not from **Capabilities**. See [Connect your agent to Telegram](/guide/telegram) and [Connect your agent to WhatsApp](/guide/whatsapp).
2. If your agent is part of a fleet, some capabilities may be hidden or locked by the person who runs the fleet.
