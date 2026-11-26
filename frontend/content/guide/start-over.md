---
title: Delete an agent or start over
section: Help
order: 3
summary: Start a fresh conversation, delete conversations, disconnect Telegram, WhatsApp and apps, delete an agent completely or deactivate your account, and what each one removes.
---

There are several ways to start over, from simply starting a new conversation to deleting your agent completely. We recommend picking the smallest one that solves your problem, since the bigger ones cannot be undone.

| If you want to | Do this |
|---|---|
| Talk about something new | Send `!new`, or start a new session in your browser. Nothing is deleted. |
| Get rid of one conversation | Delete it from the sidebar, or send `!delete` in it. |
| Get rid of many conversations | Press and hold one in the sidebar (or Cmd-, Ctrl- or Shift-click it on a computer), tick the others, then click the bin. |
| Stop your agent answering on Telegram | Switch off **Telegram** in **Settings**. To delete the bot itself, send `/deletebot` to [@BotFather](https://t.me/BotFather). |
| Stop your agent answering on WhatsApp | Switch off **WhatsApp** in **Settings**. |
| Disconnect an app | Click **Disconnect** on its card under **MCP servers** in **Capabilities**, or delete the card. |
| Disconnect Google Calendar | Click **Disconnect** under **Google Calendar** in **Capabilities**. |
| Remove everything your agent remembers | Delete the agent. There is not yet a way to clear its memory on its own. |
| Delete everything in one agent | Delete the agent, as described below. |
| Delete your Salts account | Deactivate your account, as described below. |

## Delete an agent

1. Open the Salts home page.
2. Find the agent in your list and click the **×** at the end of its row. On a computer, it shows up when you point at the row.
3. Type the agent's name exactly as it is shown, and click **Delete**.

This deletes every conversation, file, memory, setting and app connection in the agent, and your Telegram bot stops answering. If the agent was connected to Google Calendar, its access to your Google account is removed too. It cannot be undone.

Only the person who created an agent can delete it. People you added under **Manage access** cannot, and neither can the users of a fleet agent. Deleting an agent frees up a place in your account's agent limit, so you can create a new one straight away.

## Deactivate your account

Deactivating deletes your Salts account for good. You can only do it once your account is empty, so nothing is lost by accident:

1. Delete every agent you created, as described above.
2. Remove every key from your **Tokens Wallet**. Credit left on a key you bought is lost when you remove it.
3. Release any business phone numbers you hold.

Then click your picture in the top right corner of the home page, click **Deactivate account**, type your email address and click **Deactivate account**. If something is still in the way, Salts tells you what it is.

This deletes your lists and your sign-in, and signs you out. It cannot be undone. Agents that other people shared with you are not affected: if you sign up again with the same email address, you can open them again. You can also ask us to delete your account by email at salts-dev@proton.me.

## Things to tidy up afterwards

Deleting an agent does not touch anything outside Salts. Once it is gone, we recommend that you:

1. If the agent used your own OpenRouter key, delete it on the [API keys page](https://openrouter.ai/workspaces/default/keys), if no other agent uses it.
2. Delete its Telegram bot with `/deletebot` to [@BotFather](https://t.me/BotFather), if you will not use it again.
3. Delete any API keys you created for it in other apps, such as a GitHub personal access token.
4. If it used salts-tools, open `npx salts-tools`, open the agent in the **Agents** tab and unregister it.
