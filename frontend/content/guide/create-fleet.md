---
title: Create a fleet
section: Fleets
order: 3
summary: Enter the email address of everyone who should get an agent, choose the settings, and create them all at once.
---

This guide will help you create a fleet of agents for your users. Before you start, make sure you have a Fleet Account (see [Get a Fleet Account](/guide/fleet-account)), the email address of every user, and your OpenRouter API key if the agents will use it.

## 1. Choose who gets an agent

On the home page, click **Create a new Agent**.

1. Under **Name**, enter the name every agent in the fleet starts with, for example "Team assistant". Each user can rename their own agent later.
2. Check **Create a fleet of agents**.
3. Under **Fleet name**, enter a name for the whole fleet, such as your team or company name. Your users will see this name on their agent.
4. Under **User Emails**, enter the email address of every user, separated by spaces. One agent is created for each address.
5. Check the line under the box. It shows how many agents will be created, and whether any address is invalid.
6. Click **Next**.

## 2. Choose the settings

The next step is **Meta settings**, where you choose the settings every agent in the fleet starts with, and which of them your users are allowed to change. At the very least, we recommend that you:

1. Paste your OpenRouter API key under **OpenRouter**, if the agents will use it.
2. Set a **Monthly spend limit** under **Limits**, so no single agent can run up a large bill.

Everything else can stay as it is for now. [Choose the fleet's settings](/guide/fleet-settings) explains every setting in detail.

Click **Create**. Your fleet will show up in a new **Fleets** tab on the home page.

## 3. Let your users know

Salts does not send invitation emails, so you will need to tell each user yourself. Ask them to sign in to Salts with the email address you entered for them, and their agent will be waiting on their home page.

Users who sign in with a different email address will not see their agent. If that happens, you can add their correct address from [Manage your fleet](/guide/manage-fleet).
