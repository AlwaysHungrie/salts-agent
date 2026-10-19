---
title: What is the OpenRouter wallet
section: OpenRouter wallet
order: 1
summary: The place in Salts that holds your OpenRouter keys, so you can give one to any of your agents.
featured: true
---

Your agent needs an OpenRouter key to talk to an AI model, and every reply it writes is paid for from the credit on that key. The OpenRouter wallet is where Salts keeps your keys, so you can pick one for any of your agents without copying it around.

For example, you might keep one key for your personal agent and another for an agent you share with your team, each with its own credit, and see at a glance how much each one has left.

## Why you need a key in your wallet

An agent without a key cannot reply to anything. When you create an agent, the **OpenRouter key** dropdown lists the keys in your wallet, so you need at least one there first. If your wallet is empty, the dropdown says **No keys in your wallet**, and you can open the wallet straight from it to add one.

## Opening your wallet

On the Salts home page, click **OpenRouter wallet** in the top right corner. You can also open it from the wallet icon at the end of any **OpenRouter key** dropdown.

Each key in your wallet has a nickname, such as "Amber Falcon", so you can tell your keys apart. Under the nickname you can see how much credit the key has left, and how many of your agents use it.

## Getting a key

There are three ways to put a key in your wallet:

- **Connect your OpenRouter account.** Under **Get new key**, choose **From OpenRouter**. OpenRouter asks you to sign in and create a new key for Salts, then sends you back with the key already in your wallet. You don't need to copy anything.
- **Buy one with crypto.** Under **Get new key**, choose **Pay with crypto**, pick how much credit you want and pay from your crypto wallet. Salts creates the key for you and puts it straight into your wallet. See [Buy a key with crypto](/guide/wallet-crypto).
- **Add a key you already have.** If you have your own OpenRouter account, paste its key under **Already have a OpenRouter key?** and click **Add key**. See [Get an OpenRouter API key](/guide/openrouter) to create one.

## Removing a key

Click **Remove** on a key to take it out of your wallet. Every agent that uses the key stops replying until you give it another one, so we recommend picking a new key for those agents first.

A key you bought with crypto lives only in your wallet, so removing it also deletes it, and any credit left on it is lost. Salts asks you to type the key's nickname before it does this.
