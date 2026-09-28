---
title: Manage your fleet
section: Fleets
order: 5
summary: Add users, change settings for everyone or for one person, and remove agents.
---

Everything you do to a fleet starts from the **Fleets** tab on the home page. It shows up once you have created your first fleet. Every fleet is one row, with its name and how many agents are in it.

## See who is in the fleet

Click **Manage fleet** on the fleet's row. It opens a list of every agent in the fleet, with the email address of the user it belongs to.

You can see who has an agent. You cannot open their agent or read their conversations.

## Add users

1. Click **+** on the fleet's row.
2. Enter the email addresses of the new users, separated by spaces.
3. Click **Add agents**.

New agents start with the fleet's current settings. Tell the new users to sign in with the address you entered.

## Change settings for everyone

1. Click **Fleet Settings** on the fleet's row.
2. Change what you need. [Choose the fleet's settings](/guide/fleet-settings) explains every setting.
3. Click **Save and apply**, then **Apply to all**.

The dialog counts the agents as it updates them. Keep the page open until it is done.

> [!warning]
> Saving fleet settings overwrites every agent in the fleet, including settings your users changed for themselves. If a user picked a different model or wrote their own custom instructions, they lose it. A setting they rely on can stop working. Tell your users before you change fleet settings.

If the page is closed before it finishes, some agents have the new settings and some still have the old ones. Open **Fleet Settings** again and save once more to finish the rest.

## Change settings for one user

Open **Manage fleet**, find the user's agent, and click its settings icon. This opens the same settings, for that one agent only. Use it to give one user a higher spending limit, or a model the others do not have.

The next time you save the fleet's settings, this agent is overwritten like all the others. Make the change again afterwards if you still need it.

## Remove a user

Open **Manage fleet**, find the user's agent, and click its delete button. The agent is deleted with every conversation, file and memory in it. It cannot be undone.

## Delete the whole fleet

Click the delete button on the fleet's row. You will be asked to type the fleet's name to confirm.

> [!warning]
> Deleting a fleet deletes every agent in it, with every conversation, file, memory and setting inside them. Their Telegram bots stop answering. It cannot be undone.

Large fleets take a while to delete. The dialog counts the agents as it goes. Keep the page open until it is done.

## Footnotes

1. Each agent has its own monthly spend limit. When one agent reaches it, the agent tells its user and stops answering until the next month, or until you raise the limit. The other agents keep working.
2. Every deleted agent frees up a place in your account's agent limit.
