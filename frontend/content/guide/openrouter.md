---
title: Get an OpenRouter API key
section: Get started
order: 2
summary: Create an OpenRouter account, add credit and get an API key for your agent.
featured: true
---

Your agent needs an AI model to understand and reply to your messages. OpenRouter is a service that gives your agent access to hundreds of models, including the ones that create images and voice notes, from a single account. You add credit to the account, and each reply is paid for from it based on how many tokens the model read and wrote. If any of these words are new to you, read [What is Salts](/guide/why-salts) first.

The key you create here is what lets your agent use your OpenRouter account. It takes about five minutes, and you will need to buy a few dollars of credit.

## 1. Create an account

Go to [openrouter.ai](https://openrouter.ai) and sign up for a free account.

## 2. Buy credits

Find and open the **Credits** page in the left sidebar and purchase API credits. We recommend only buying $10 to begin with. You can always add more later once you have a feel for how much your agent uses.

## 3. Create an API key

Open the [API keys page](https://openrouter.ai/workspaces/default/keys) and click **Create key**. Give the key a name you will recognise, such as the name of your agent.

While creating the key, you should also set a credit limit. This is the most your agent is allowed to spend with this key, and we recommend setting one so you are never surprised by your bill.

Once the key is created, copy it and keep it somewhere safe. It starts with `sk-or-v1-`, and OpenRouter will only show it to you once.

## 4. Add the key to your agent

When you create your agent, paste the key into the **OpenRouter API key** field. If you already have an agent, open its **Settings**, scroll to the **OpenRouter** section, paste the key there and save.
