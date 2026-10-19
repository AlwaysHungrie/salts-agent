---
title: Get an OpenRouter API key
section: Get started
order: 4
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

The quickest way is to let Salts ask for one. On the Salts home page, click **OpenRouter wallet** in the top right corner, then choose **Connect OpenRouter**. OpenRouter asks you to approve a new key, then sends you back with the key in your wallet, and you can skip straight to step 5.

To create the key yourself instead, follow the steps below.

Open the [API keys page](https://openrouter.ai/workspaces/default/keys) and click **Create key**. Give the key a name you will recognise, such as the name of your agent.

While creating the key, you should also set a credit limit. This is the most your agent is allowed to spend with this key, and we recommend setting one so you are never surprised by your bill.

Once the key is created, copy it and keep it somewhere safe. It starts with `sk-or-v1-`, and OpenRouter will only show it to you once.

## 4. Add the key to your wallet

On the Salts home page, click **OpenRouter wallet** in the top right corner. Paste the key at the bottom and click **Add key**. Salts checks the key with OpenRouter before keeping it, and gives it a nickname, such as "Amber Falcon", so you can tell your keys apart. If you would rather skip OpenRouter's own checkout, you can also [buy a key with crypto](/guide/wallet-crypto) straight from your wallet.

Your wallet holds every key you add, and shows how much credit each one has left. You can see or remove a key from there at any time. Removing a key also takes it away from every agent that uses it.

## 5. Pick the key for your agent

When you create your agent, choose the key by its nickname from the **OpenRouter key** dropdown. If you already have an agent, open its **Settings**, scroll to the **OpenRouter** section and choose the key there. You can also open your wallet from the wallet icon at the end of the dropdown.
