---
title: Connect your agent to WhatsApp
section: WhatsApp
order: 1
summary: Get a free test number from Meta and set up your agent to message you on WhatsApp.
featured: true
---

This guide will help you get a test phone number and set up your agent to use that number to message you on WhatsApp. Following it will require you to open three different browser tabs and follow precise instructions. No technical skills are required.

> [!warning]
> **Disclaimer:** Sharing your agent with any other WhatsApp account or group strictly violates Meta's terms of use and ours, and will get your account suspended. Only use your own phone number to talk to your agent.

> What to expect:
>
> - You will create a developer account on Meta and get a test number. This is a free service provided by Meta for testing purposes, and as such Meta can change or remove this service at any time.
> - Your agent will not work in WhatsApp groups, or with any account other than yours.
> - Your agent cannot send you a message on its own unless there is an active chat session, and a session only lasts 24 hours. To make sure reminders and scheduled messages reach you, keep a session alive by sending at least one message every 24 hours.

## 1. Create a Meta app

Sign in to [developers.facebook.com](https://developers.facebook.com/apps) and create a new app.

![The Meta apps dashboard with the Create App button](/guides/whatsapp/step1-create-app.png)

This opens a five-step app creation process.

1. Enter an app name. Use \<Your-Name\>'s Assistant as the name.
2. Under use cases, pick **Business messaging**, then **Connect with customers through WhatsApp**.

   ![The use case picker with Business messaging and Connect with customers through WhatsApp selected](/guides/whatsapp/step1-use-cases.png)

3. On the Business step:

   1. Create a business portfolio **only if you do not have one already.** Use **\<Your-Name\>'s Assistant** as the business portfolio name. Also enter your contact details.

      ![The Create a business portfolio dialog](/guides/whatsapp/step1-portfolio.png)

   2. Verification is not required. Click **Verify later**.

      ![The portfolio created dialog with Verify later and Start verification buttons](/guides/whatsapp/step1-verify-later.png)

   3. Select the portfolio you just created.

4. Requirements: if everything so far is right, you will see "No requirements identified." Click **Next**.
5. Review your details and click **Create app**.

   ![The review screen showing the WhatsApp use case, the business portfolio and the Create app button](/guides/whatsapp/step1-review.png)

## 2. Open the WhatsApp use case

Click **Use cases** in the left sidebar.

![The app dashboard sidebar with Use cases in the list](/guides/whatsapp/step2-sidebar.png "narrow")

Then click the customize button, the pencil icon, on the **Connect with customers through WhatsApp** card.

![The WhatsApp use case card with the pencil customize button on the right](/guides/whatsapp/step2-customize.png)

## 3. Request a test phone number

Step 2 takes you to a new page. Check that the right business portfolio is selected, then click **Continue**.

![The WhatsApp Business Platform panel with the business portfolio dropdown and a Continue button](/guides/whatsapp/step3-portfolio.png)

This opens a three-step overview. For now you only need to partly complete step 1. Click **Step 1. Try it out**.

![The WhatsApp overview page listing Try it out, Production setup and Business verification](/guides/whatsapp/step3-overview.png)

## 4. Copy the phone number ID and register your own phone number

1. Copy the **Phone number ID** and the **WhatsApp Business account ID**, and add both to your agent's settings.

   ![The Try it out panel showing the test number, phone number ID and WhatsApp Business account ID](/guides/whatsapp/step4-test-number.png)

2. Click **Generate token**, choose **Opt in to all current and future WhatsApp accounts**, **Continue**, then **Save**.

   ![The opt in dialog with all current and future WhatsApp accounts selected](/guides/whatsapp/step4-optin.png)

3. Finally, click **Select a recipient number** → **Manage phone number list**, add your phone number and verify the 5-digit code WhatsApp sends you. Click **Send message** and it should arrive on your phone.

   ![The Hello World message dropdown with the Send message button](/guides/whatsapp/step5-send-message.png)

## 5. Create a system user and a permanent access token

In a second new tab, go to [business.facebook.com](https://business.facebook.com/settings) and select the business portfolio you created in the first step.

Click the settings icon at the bottom left of the sidebar. A second sidebar opens: select **System users** and create a new system user named **Salts** with the **Admin** role.

Once it is created, click **Assign assets**.

![The system user page with no assets assigned and an Assign assets button](/guides/whatsapp/step5-assign-assets.png)

In the dialog, select your app and your WhatsApp account, and turn on **Full access** for both.

![The Select assets and assign permissions dialog with the WhatsApp account selected and Full access on](/guides/whatsapp/step5-full-access.png)

Now click **Generate token** and follow the process. Select your app, then set the expiry to **Never**.

![The token expiry screen with Never selected](/guides/whatsapp/step5-expiry.png)

On the permissions screen, select every permission in the list.

![The assign permissions screen with all options selected](/guides/whatsapp/step5-permissions.png)

> [!warning]
> You might need to refresh the page after creating the system user and after assigning assets. Assigned asset changes can take time to propagate, and the **Generate token** button will not work until they do.

The token will only be shown once. Copy it into the **Access token** field in your agent's settings before closing the dialog.

## 6. Get the app secret

In a third new tab, go to [developers.facebook.com](https://developers.facebook.com/apps). In the left sidebar, open **App settings** and select **Basic**.

![The app dashboard sidebar with App settings expanded and Basic selected](/guides/whatsapp/step6-sidebar.png "narrow")

Click **Show** next to App secret. Copy the value into the **App secret** field in your agent's settings.

![The App secret field with a Show button](/guides/whatsapp/step6-app-secret.png)

## 7. Configure the webhook

Almost there. Go back to the first tab you left open in step 3, the one with the three-step overview. Click **Step 2. Production setup**.

Add this callback URL:

{{whatsapp-callback-url}}

Generate a **verify token** below, then copy it into your agent settings **first**:

{{verify-token}}

Once it is saved there, paste the same verify token into the **Verify token** field of the Configure webhook step and click **Verify and save**.

![The Verify token field with the Verify and save button](/guides/whatsapp/step7-verify-token.png)

After the page refreshes, visit the same step again and check that **messages** is subscribed under the webhook configuration. It is on by default.

![The messages webhook field showing Subscribed](/guides/whatsapp/step7-messages-subscribed.png)

## You are done

Message the test number from your phone. Your agent answers in the same chat, with the same memory, tools and settings it has in your browser, and the conversation shows up in your sessions like any other.

Keep the 24-hour window in mind: if you have not messaged your agent for a day, WhatsApp will not let your agent reach you until you message it again.

## Footnotes

1. The most common mistake is an incorrect callback URL, or a verify token that does not match between the Meta dashboard and your agent settings. Check both first if messages are not going through.
2. If messages stop going through, check [business.facebook.com](https://business.facebook.com) for account suspension notices. Some business portfolio names and app names are not allowed and can result in an immediate suspension.
3. Creating more than one unverified business portfolio gets the newer portfolios suspended automatically. You may have to verify your business and ask for a review to get them back.
4. If you would rather use a second number of your own than the test number WhatsApp provides, you can add and verify it on the same page as step 7. That exercise is left to the reader.
