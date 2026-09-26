# Infrastructure

The system runs on two hosts, each with a production and a staging deployment.

| Part | Host | Production | Staging |
| --- | --- | --- | --- |
| Agent Worker (`agent/`) | Cloudflare | `https://salt-agent.dhairyashah98.workers.dev` | `https://salt-agent-staging.dhairyashah98.workers.dev` |
| Web app (`frontend/`) | Vercel project `salts-agent-app` | `https://salts-agent-app.vercel.app` | `staging` branch preview |
| Landing page (`landing-page/`) | Vercel project `salts-agent-landingpage` | `https://salts-agent-landingpage.vercel.app` | none |

The web app calls the Worker at `AGENT_URL`. Production and staging each point at their
own Worker, so staging never touches production data.

The two hosts are managed separately:

- **Vercel** settings live in Terraform under `infra/vercel/`. Code ships by pushing to git.
- **Cloudflare** settings live in `agent/wrangler.jsonc`. Code ships with `npm run deploy`.

## Vercel

### What Terraform manages

`infra/vercel/` defines:

- Both projects: name, Next.js framework, root directory (`frontend` or
  `landing-page`), `pnpm install`, and the GitHub repo with `main` as the production
  branch.
- The `*.vercel.app` domains named after each project. The old
  `serverless-agent-one.vercel.app` domain is still attached to the app but is not
  managed by Terraform.
- The web app's environment variables, set per target:
  - `production`: deploys from `main`.
  - `preview`: deploys from every other branch.
  - `staging`: deploys from the `staging` branch. It gets production's variables with
    `AGENT_URL` replaced by `staging_agent_url`.

The landing page has no environment variables.

Terraform does not deploy code. Vercel builds and deploys on every git push.

### Files

| File | Committed | Contents |
| --- | --- | --- |
| `main.tf` | yes | Projects, domains, env vars |
| `variables.tf` | yes | Project names, repo, staging branch and Worker URL |
| `versions.tf` | yes | Provider pin |
| `.terraform.lock.hcl` | yes | Provider checksums |
| `terraform.tfvars.example` | yes | Layout for `terraform.tfvars` |
| `terraform.tfvars` | **no** | Env var values, including Clerk secret keys |
| `terraform.tfstate*` | **no** | State. Holds every env var value in plain text |

Keep a backup of `terraform.tfstate` somewhere private, such as a password manager.
Without it, Terraform no longer knows which Vercel projects it manages, and you must
import them again (see [Recovering state](#recovering-state)).

### Setup on a new machine

1. Install Terraform: `brew install hashicorp/tap/terraform`.
2. Create a Vercel token at vercel.com/account/tokens, scoped to the account that owns
   both projects. Vercel shows the token once. The token is only needed while running
   Terraform, so a short expiry is fine.
3. Restore `infra/vercel/terraform.tfstate` from your backup.
4. Create `infra/vercel/terraform.tfvars` from `terraform.tfvars.example` and fill in
   the values.
5. Run:

   ```sh
   cd infra/vercel
   export VERCEL_API_TOKEN=...
   terraform init
   terraform plan    # should show no changes
   ```

Don't store the token in `terraform.tfvars`, `.env` files, or the repo. It gives full
access to the projects and their secrets. If it leaks, delete it on the Tokens page.

### Changing settings or env vars

Edit `terraform.tfvars` (values) or the `.tf` files (structure), then run:

```sh
cd infra/vercel
terraform plan
terraform apply
```

Read the plan before applying. A `vercel_project` marked for replacement (`-/+`) would
delete and recreate the project, so stop if you see one.

New env var values reach the site on the next deployment only. After applying, push a
commit or redeploy the latest deployment from the Vercel dashboard.

Make these changes through Terraform, not the dashboard. Terraform overwrites
dashboard edits to anything it manages on the next `apply`. If you create an env var in
the dashboard with the same name and target as one in Terraform, `apply` fails with
"A variable with the name ... already exists". Delete the dashboard copy and apply
again.

### Deploying

| Goal | Command |
| --- | --- |
| Deploy production (both sites) | Merge a PR into `main` |
| Deploy staging web app | `git push origin <branch>:staging` |
| Preview any other branch | Push the branch. Vercel posts the preview URL on the commit. |

Both projects build on every push, including pushes that only change the other app.

`main` is protected by a GitHub ruleset: direct pushes, force-pushes and deletion are
blocked for everyone, admins included. Push a branch and open a PR:

```sh
git switch -c my-change
git push -u origin my-change
gh pr create --base main
gh pr merge
```

The staging web app's URL follows Vercel's branch pattern,
`salts-agent-app-git-staging-<account>.vercel.app`. The exact URL is on the deployment
page.

### Clerk

The web app uses a Clerk development instance (`pk_test_` / `sk_test_` keys).
Development instances accept any domain, so the Vercel URLs need no Clerk settings.

A Clerk production instance (`pk_live_` keys) needs a domain you own and does not
work on `*.vercel.app`. Before switching:

1. Buy a domain.
2. Add it to the web app as a `vercel_project_domain` in `main.tf`.
3. Add the DNS records Clerk asks for.

### Recovering state

If `terraform.tfstate` is lost, import the existing projects. The project IDs
(`prj_...`) are under each project's Settings → General in the Vercel dashboard.

```sh
terraform import vercel_project.frontend <prj_id of salts-agent-app>
terraform import vercel_project.landing_page <prj_id of salts-agent-landingpage>
terraform plan
```

Domains and env vars will show as new. Before applying, delete the web app's env vars
in the dashboard so `apply` can create them.

## Cloudflare

### What runs there

The agent is one Worker, defined in `agent/wrangler.jsonc`:

- **Durable Objects:** `SessionAgent`, `SessionRegistry`, `AgentDirectory`. Each has
  its own SQLite storage.
- **R2 bucket:** `salt-agent-files` (binding `FILES`).
- **Vars:** `CLERK_ISSUER`, the Clerk instance whose session tokens the Worker accepts.
  It is a public URL, so it lives in `wrangler.jsonc`.
- **Secret:** `API_SECRET`, set with `wrangler secret put`. The deploy preflight refuses
  to deploy without it.

Staging (`env.staging` in `wrangler.jsonc`) is a separate Worker, `salt-agent-staging`,
with its own Durable Objects, its own R2 bucket `salt-agent-files-staging`, and its own
secrets. Staging does not inherit `vars` from the top level, so `CLERK_ISSUER` is set
again under `env.staging`.

Runtime limits and defaults (models, system prompt, upload ceilings and so on) are not
in `wrangler.jsonc`. They are a settings document stored in the Worker and edited
with `admin-cli`. See "Admin: deployment settings" in the root `CLAUDE.md`.

### One-time setup

For production:

```sh
cd agent
npx wrangler login
npx wrangler r2 bucket create salt-agent-files
npx wrangler secret put API_SECRET
```

For staging:

```sh
npx wrangler r2 bucket create salt-agent-files-staging
npx wrangler secret put API_SECRET --env staging
```

`admin-cli` reads `admin-cli/.env` (layout in `admin-cli/.env.example`). It holds
each deployment's URL and `API_SECRET`: `AGENT_URL` / `API_SECRET` for production and
`AGENT_URL_STAGING` / `API_SECRET_STAGING` for staging. The file is gitignored.

### Deploying

Test on staging first:

```sh
cd agent
npm run deploy:staging
npm run smoke:staging
```

Then production:

```sh
npm run deploy
npm run smoke
```

Each deploy script runs, in order:

1. `tsc --noEmit` (typecheck)
2. `vitest run` (tests)
3. `scripts/preflight.mjs`, which checks that `API_SECRET` is set on the target Worker
   and runs `admin-cli check` against the live settings document
4. `wrangler deploy`
5. `admin-cli init`, which writes shipped defaults from `admin-cli/defaults.json` for
   any unset setting

Any failing step stops the deploy.

### Rolling back

```sh
cd agent
npm run rollback
```

This returns the Worker to the previous version. It does not undo Durable Object
migrations or data changes.

### Local development

```sh
cd agent
npm run dev    # Worker on http://localhost:8787
```

Local secrets go in `agent/.dev.vars` (layout in `agent/.dev.vars.example`). Point the
web app at the local Worker by setting `AGENT_URL=http://localhost:8787` in
`frontend/.env.local`.
