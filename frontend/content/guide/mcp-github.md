---
title: Connect GitHub
section: MCP servers
order: 4
summary: Create a GitHub personal access token and connect your agent to your repositories.
---

This guide will help you connect your agent to GitHub. Once it is done, you can ask your agent what changed in a project this week, look up an issue or open a new one, from anywhere you talk to your agent.

Unlike Notion, GitHub does not let you sign in with a button. Instead, you create a personal access token on GitHub, which works like a password that only your agent uses, and paste it into your agent's settings.

## 1. Create a personal access token

1. Open [github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new). You can also get there from **Settings** → **Developer settings** → **Personal access tokens** → **Fine-grained tokens** → **Generate new token**.
2. Give the token a name you will recognise, such as the name of your agent.
3. Choose an **Expiration**. When the token expires, your agent loses access to GitHub until you create a new one.
4. Under **Repository access**, choose which repositories your agent can see. We recommend **Only select repositories** and picking just the ones you want to ask about.
5. Under **Permissions**, add the permissions your agent needs. For most people, these are enough:
   - **Contents**: Read-only, so your agent can read files and commits.
   - **Issues**: Read and write, so your agent can read and open issues.
   - **Pull requests**: Read and write, so your agent can read and comment on pull requests.

   If you only want to ask questions and never want your agent to change anything, choose **Read-only** for all of them.
6. Click **Generate token**.
7. Copy the token. It starts with `github_pat_`, and GitHub will only show it to you once.

## 2. Add GitHub to your agent

Open your agent, go to **Capabilities** and scroll down to **MCP servers**.

1. Click the **GitHub** icon. A form opens with the name and URL already filled in, and **API key** selected.
2. In the first box, enter `Authorization`.
3. In the second box, enter `Bearer` followed by a space and your token, for example `Bearer github_pat_11AB…`.
4. Click **Add**.

Your agent connects to GitHub straight away, and the GitHub card shows how many tools it has.

## 3. Choose which tools to keep

GitHub offers your agent a lot of tools. Click **Select recommended** on the GitHub card to keep only the ones your agent is likely to need. Read [Must read: Managing costs and MCP tools](/guide/mcp-costs) to understand why this matters.

## You are done

Ask your agent something about one of your repositories, for example "What issues were opened on my project this week?".

## Footnotes

1. If the GitHub card shows an error, check that the second box starts with `Bearer ` followed by the whole token, and that the token has not expired.
2. When your token expires, create a new one, open the GitHub card, paste the new token into the second box and click **Save headers**.
3. Repositories that belong to an organisation may need the organisation's approval before a fine-grained token can access them.
