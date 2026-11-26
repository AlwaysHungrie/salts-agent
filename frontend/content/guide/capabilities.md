---
title: What your agent can do
section: Using your agent
order: 1
summary: Every capability on the Capabilities page, such as web search, YouTube summaries, files, images, voice notes, reminders, memory, lists, Google Calendar and a wallet, what each one does and how to use it.
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

## YouTube summaries

Lets your agent summarise a YouTube video when you send it the link, for example a talk you want the gist of before deciding whether to watch it. It works with ordinary video links, short `youtu.be` links and Shorts. You get the video's title, channel and length along with the summary.

You do not need the link. Name the video, for example "Summarise the 3Blue1Brown video on neural networks", and your agent searches YouTube for it first. You can also send a screenshot of a video. Your agent reads the link from the address bar if it is visible, or otherwise looks the video up by its title and channel. Screenshots need **Image input** switched on as well, with a model that can see images.

Your agent's own model writes the summary from the video's captions, which keeps it cheap, and only the summary is added to your conversation. A few videos have no captions. For those, a Gemini model can watch the whole video instead, which you pick under **Fallback (Gemini only)**. That costs more, about $0.04 for a 20-minute video on the cheapest model, and does not work for videos longer than about an hour. The fallback starts as **None**, and your agent tells you when it cannot summarise a video.

When your agent reads a video's captions, it also keeps the transcript in the conversation as a file, so you can ask follow-up questions such as "What did they say about pricing?". It searches the transcript for the answer instead of summarising the video again.

## File ingest

Lets you attach files in the chat and ask questions about them, for example "What does this contract say about cancellation?". It works with PDFs up to 8 MB, and with text files such as Markdown, CSV, JSON and code up to 1 MB.

Your agent does not reread the whole file with every message. It searches the file for the parts your question is about, which keeps long documents cheap to talk about. You can keep asking about a file for the rest of the conversation.

To see every file in a conversation, including video transcripts your agent kept, click the file count next to the message count at the top of the chat. Click a file to open it.

Excel workbooks cannot be read this way. To work with spreadsheets, see [Add the spreadsheet analyst](/guide/salts-tools-analyst).

## Image input

Lets your agent see the photos and screenshots you send it, for example "What does this error message mean?" with a screenshot attached. In the web app you can also paste a screenshot straight into the message box.

Not every model can see images. Models marked **(no image)** in **Settings** cannot, and that includes the model your agent starts with. If you switch this on, also pick a model that can. See [Choose the right model](/guide/choosing-a-model).

## Image generation

Lets your agent create pictures when you ask for them, for example "Draw a birthday card with a cat on it". It can also change a picture already in the chat, one you sent or one it drew, for example "Add a sad cat to the right side of this screenshot". To send it a picture, also turn on **Image input**. You can pick the **Image model** it uses. Images are paid from your agent's key like any other reply, and usually cost more than a text reply.

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

## User lists

Lets your agent keep lists for you, such as groceries, books to read, places to visit or people to call. Ask in your own words, for example "Add eggs and bread to my shopping list", "What's left on my to-do list?" or "Start a list of gift ideas for Mum". Your agent also adds to a list on its own when it fits, so "We're out of milk" puts milk on your shopping list.

Your lists belong to your account, not to one agent. Every agent you own, in every conversation, sees and changes the same lists. To look at them, open **Files** at the top of any conversation: your lists are at the top, under **Lists**. You can download a list from there.

Anyone who can talk to your agent can read and change your lists. If your agent is used by other people, keep this switched off. When it is off, your agent does not see your lists at all, and they stay as they are until you switch it on again.

## Google Calendar

Lets your agent see your Google Calendar and change it for you. Ask in your own words, for example "What's on tomorrow?", "Am I free on Friday afternoon?", "Book lunch with Priya at 1pm on Thursday" or "Move my dentist appointment to next week". It can also cancel events, add guests and set up events that repeat.

After you switch it on, click **Connect** and sign in with your Google account. Google asks you to allow access to your calendars, and then brings you back to the Capabilities page, which shows the account that is connected. Your agent works in your calendar's time zone, so the times it tells you and the times it books match what you see in Google Calendar.

Your agent checks with you before it deletes an event or sends invitations to other people, unless you already asked for exactly that. When it adds or changes an event with guests, it does not email them unless you ask it to.

Anyone who can talk to your agent can read and change your calendar. If your agent is used by other people, keep this switched off. To stop your agent using your calendar, click **Disconnect**. That also removes your agent's access from your Google account.

## Wallet

Gives your agent a crypto wallet of its own, with one address on EVM networks such as Ethereum and Base, and one on Solana. Both addresses appear under **Wallet** once you switch it on, so you can copy them and send funds there. The wallet's private key stays with Salts and is never shown, not even to you.

To let your agent check its balances, click **Add network** under EVM or Solana. Give the network a name such as "Solana Devnet", its RPC URL, and the tokens to track with their address and decimals. You can also add the network's explorer URL, so you can open the wallet on the explorer from its network. Then ask your agent in your own words, for example "What is your USDC balance on Solana Devnet?".

Your agent can send from this wallet too. Ask it something like "Send 0.01 SOL to <address> on Solana Devnet", and it sends the native coin or any token you track on that network, then replies with the transaction and an explorer link. It can also sign other transactions, for example from an MCP server, and send them through the same network.

Anyone who can talk to your agent can ask it to send or sign. We recommend keeping only small amounts in the wallet, and reading [Telegram safety tips](/guide/telegram-safety) first if other people use your agent.

## MCP servers

Connects your agent to other apps, such as Notion and GitHub, so it can do things in them for you. This one is always on, and does nothing until you add a server. See [What is an MCP server](/guide/mcp).

## Footnotes

1. Telegram and WhatsApp are set up from your agent's **Settings**, not from **Capabilities**. See [Connect your agent to Telegram](/guide/telegram) and [Connect your agent to WhatsApp](/guide/whatsapp).
2. If your agent is part of a fleet, some capabilities may be hidden or locked by the person who runs the fleet.
