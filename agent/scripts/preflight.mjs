#!/usr/bin/env node
/**
 * Refuse to deploy a Worker that would come up unguarded, or unconfigured.
 *   node scripts/preflight.mjs [--env <name>]
 *
 * Unconfigured means the deployment settings: the Worker ships no ceilings or defaults
 * of its own and refuses every request until each one is set, so a deploy onto an
 * incomplete document is a deploy onto a Worker that answers nothing. The check is the
 * admin CLI's own (`admin-cli check`), against the live deployment.
 *
 * Runs ahead of `wrangler deploy`, because the version that matters is the one that
 * is already live. The Worker itself also refuses to serve without `API_SECRET` — see
 * `unconfigured()` in src/server.ts — so a deploy that slipped past this would fail
 * closed rather than open. This is the earlier and friendlier of the two: it says what
 * is missing before the broken version is the one answering.
 *
 * Secrets are not readable, only listable, which is all this needs: the question is
 * whether one is set, never what it is.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Which deployment this is about. Secrets are per-environment on Cloudflare, so
 * checking production's secrets before a staging deploy would be checking the wrong
 * Worker — and would pass while staging came up with nothing set.
 */
const envIndex = process.argv.indexOf("--env");
const targetEnv = envIndex === -1 ? null : process.argv[envIndex + 1];
const envArgs = targetEnv ? ["--env", targetEnv] : [];
const label = targetEnv ?? "production";

/** Every secret name the deployed Worker has, according to Cloudflare. */
function deployedSecrets() {
  try {
    const out = execFileSync("npx", ["wrangler", "secret", "list", ...envArgs], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    // Wrangler prints a banner before the JSON on some versions; take the array.
    const start = out.indexOf("[");
    if (start === -1) return null;
    return JSON.parse(out.slice(start)).map((s) => s.name);
  } catch {
    // No network, not logged in, or the Worker has never been deployed. Unknown is
    // not "fine": a preflight that passes when it could not check is worse than none.
    return null;
  }
}

/**
 * `vars` from wrangler.jsonc. JSONC, so the comments have to come out first — crude,
 * but this only ever reads a file in this repo written by this repo.
 */
function configuredVars() {
  const raw = readFileSync(join(root, "wrangler.jsonc"), "utf8")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  const config = JSON.parse(raw);
  // `vars` are not inherited by a named environment — Wrangler replaces the block
  // rather than merging it — so an environment's own block is the whole truth about
  // what it will come up holding.
  return (targetEnv ? config.env?.[targetEnv]?.vars : config.vars) ?? {};
}

const fail = (lines) => {
  console.error(`\n  Refusing to deploy to ${label}.\n\n${lines.map((l) => `  ${l}`).join("\n")}\n`);
  process.exit(1);
};

const secrets = deployedSecrets();
if (secrets === null) {
  fail([
    "Could not read the deployed Worker's secrets, so there is no way to tell",
    "whether API_SECRET is set on it.",
    "",
    `Check \`npx wrangler whoami\`, then run \`npx wrangler secret list${targetEnv ? ` --env ${targetEnv}` : ""}\``,
    "to see the real error. If this Worker has never been deployed, set its",
    "secrets first:",
    "",
    `    npx wrangler secret put API_SECRET${targetEnv ? ` --env ${targetEnv}` : ""}`,
  ]);
}

const vars = configuredVars();
if (!vars.CLERK_ISSUER && !secrets.includes("CLERK_ISSUER")) {
  fail([
    "CLERK_ISSUER is not set.",
    "",
    "It is what lets the Worker verify a Clerk session token, and a verified token",
    "is how every ordinary caller becomes somebody. Without it nobody can sign in",
    "to this deployment at all, so the Worker refuses to serve.",
    "",
    "Add it to `vars` in wrangler.jsonc — it is a public URL, not a secret:",
    "",
    '    "CLERK_ISSUER": "https://<subdomain>.clerk.accounts.dev"',
  ]);
}

// The deployment settings, as the live Worker holds them. The admin CLI reads its own
// `.env` for the URL and secret — `--staging` picks that environment's pair.
//
// Exit 2 is the one-time bootstrap: the live Worker predates settings, so there is no
// document to check and no route to write one through until this deploy installs it.
// Let through; the deploy script runs `admin-cli init` straight after `wrangler deploy`.
try {
  execFileSync(
    process.execPath,
    [join(root, "..", "admin-cli", "index.mjs"), "check", ...(targetEnv ? [`--${targetEnv}`] : [])],
    { stdio: "inherit" }
  );
} catch (err) {
  if (err.status === 2) {
    console.log("  preflight: bootstrapping deployment settings — `init` runs after the deploy.");
  } else fail([
    "The deployment settings are incomplete, or could not be read (see above).",
    "",
    "The Worker has no values of its own for its ceilings and defaults, and refuses",
    "every request until each one is set. From admin-cli:",
    "",
    `    npm run init${targetEnv ? ` -- --${targetEnv}` : ""}      # write the shipped defaults for every unset field`,
  ]);
}

// API_SECRET is optional: it unlocks the owner's admin routes and names nobody.
console.log(
  secrets.includes("API_SECRET")
    ? `  preflight ok (${label}) — CLERK_ISSUER configured. API_SECRET is set: admin routes enabled.`
    : `  preflight ok (${label}) — CLERK_ISSUER configured. No API_SECRET: admin routes disabled.`
);
