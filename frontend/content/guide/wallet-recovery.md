---
title: Recover a lost payment
section: OpenRouter wallet
order: 3
summary: Paid with crypto but no key showed up in your wallet? Get it with the transaction id.
featured: false
---

Sometimes a crypto payment goes through, but the key never appears in your wallet. This can happen if you refreshed or closed the page while the payment was settling, or your connection dropped. Your payment is not lost: if it was successful, you can still get the key it paid for.

## Salts checks for you first

Each time you open your **OpenRouter wallet** in the same browser you paid from, Salts checks any payment it was still waiting on and adds the key if the payment went through. You will see a short note at the top of your wallet while it does this. In most cases, opening your wallet again is all you need to do.

## Recover a payment yourself

If you paid from another device, or the key still has not appeared, you can recover it with the transaction id.

1. Find the transaction id in your crypto wallet's activity or history. It may be called a transaction hash or a signature.
2. Open your **OpenRouter wallet** and click **Paid but didn't get a key?** under **Get new key**.
3. In the **Recover Lost Transactions** window, choose the network you paid on, paste the transaction id and click **Get my key**.

If the payment is confirmed, you will see **Transaction confirmed. The key has been added to your wallet.** If the key had already been added earlier, the message says so instead. Recovering a payment never charges you again or adds a second key.

## If it does not work

- **That payment isn't final yet.** The network has not settled the payment. Wait a minute and try again.
- **Failed to validate transaction.** Salts could not match the transaction to one of your purchases. Check that you chose the right network and pasted the whole id, and that you are signed in with the same email you used to start the checkout. Only payments made in the last 30 days can be recovered.
