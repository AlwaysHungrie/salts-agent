import type { Env } from "../agent";
import { CAPABILITY_BY_ID, type CapabilityId, TELEGRAM_WHITELIST_DEFAULTS } from "../capabilities";
import type { McpServerRow } from "../mcp";
import {
  type AgentRow,
  type Config,
  EMPTY_MCP_SERVER,
  MAX_PAGE,
  type MetaSettings,
} from "../registry";
import { Telegram } from "../telegram";
import { validateConfig } from "../validation/config";
import { syncMcpTools, syncWebhook } from "./integrations";
import {
  destroySession,
  directory,
  readConfig,
  type Registry,
  registry,
  writeConfig,
} from "./stores";

/**
 * Write the defaults into the agent: its tuning, its capability switches and their
 * fields, and any MCP server it is supposed to have.
 *
 * Deliberately explicit rather than automatic. The defaults are what a fresh agent
 * *should* look like, and an agent that has been tuned by hand should not have that
 * work undone every time the dialog is saved — so applying them is its own action.
 *
 * A server whose name is already taken is left exactly as it is: it may be connected,
 * and reseeding it would throw away tokens to no purpose.
 */
export async function applyMeta(
  reg: Registry,
  meta: MetaSettings,
  env: Env,
  origin: string,
  agentId: string
): Promise<{ config: Config; added: string[] }> {
  const patch: Partial<Config> = { ...meta.defaults };

  for (const [id, entry] of Object.entries(meta.capabilities)) {
    const capability = CAPABILITY_BY_ID.get(id as CapabilityId);
    if (!capability) continue;
    if (entry.enabled !== undefined) (patch[capability.flag] as number) = entry.enabled ? 1 : 0;
    for (const [key, value] of Object.entries(entry.fields ?? {})) {
      (patch[key as keyof Config] as string) = value;
    }
  }

  const config = await writeConfig(env, reg, validateConfig(patch));

  const existing = await reg.mcpServers();
  const taken = new Set(existing.map((s) => s.name.toLowerCase()));
  const added: string[] = [];
  for (const wanted of meta.mcp.servers) {
    if (taken.has(wanted.name.toLowerCase())) continue;
    const row: McpServerRow = {
      ...EMPTY_MCP_SERVER,
      id: crypto.randomUUID().slice(0, 8),
      created_at: Date.now(),
      name: wanted.name,
      url: wanted.url,
      auth: wanted.auth,
      headers: JSON.stringify(wanted.headers ?? {}),
    };
    await reg.addMcpServer(row);
    // OAuth has nothing to read until somebody approves it; the rest can list now.
    if (row.auth !== "oauth") await syncMcpTools(reg, row);
    added.push(row.name);
  }

  // The switches just moved, and Telegram's is the one that has an outside effect.
  await syncWebhook(config, origin, agentId, env.TELEGRAM_API_BASE);

  return { config, added };
}

/**
 * Delete an agent and everything it owns: the name first, so nothing can be admitted
 * to it while the rest is going away, then its sessions and their files, then the
 * settings, MCP servers, memories and access list in its registry.
 *
 * The bot is unhooked before any of that. Its webhook points at a route that is
 * about to stop resolving, and a webhook Telegram keeps retrying against a 404 is
 * how a deleted agent goes on costing requests.
 */
export async function deleteAgent(env: Env, origin: string, agentId: string): Promise<void> {
  const reg = registry(env, agentId);

  const config = await readConfig(env, reg);
  if (config.telegram_bot_token) {
    try {
      await new Telegram(config.telegram_bot_token, env.TELEGRAM_API_BASE).deleteWebhook();
    } catch {
      // A dead token cannot be unhooked, and it cannot receive anything either.
    }
  }

  // The index goes before the storage, which is the one place the order is the other
  // way round from a membership edit — and for the same reason. `wipe()` leaves the
  // registry unseeded, and an unseeded registry asks the directory; so wiping first
  // would let a request arriving mid-teardown read the directory row that is still
  // there and seed the access list straight back into the object being torn down.
  // Removing the name first closes both doors at once: the gate finds no agent to
  // seed from, and every control-plane route 404s from here on.
  await directory(env).remove(agentId);

  // Deleting an agent has to reach every session it owns, not just the newest page,
  // so this walks the cursor to the end of the list.
  for (let cursor = "", more = true; more;) {
    const page = await reg.list(MAX_PAGE, cursor);
    cursor = page.cursor;
    more = page.has_more;
    for (const session of page.sessions) {
      await destroySession(env, origin, session.id);
    }
  }

  await reg.wipe();
}

/**
 * An agent row as a given caller may see it.
 *
 * The administrator's address is struck out for everybody who is not that
 * administrator. To the user of a fleet agent, whoever provides it is a fact about
 * their own tool, and that address is a personal one: a fleet of a thousand agents
 * would otherwise hand one person's inbox to a thousand strangers, every one of whom
 * can read it out of a page source. The user is told there is an administrator —
 * that is what the fleet name on their sidebar says — and not who.
 *
 * The blank is not a lie the rest of the code has to work around: every gate reads
 * the access list from the agent's own object, never from a row that has been
 * through here, and "is this me" comes out the same either way.
 */
export function agentFor(row: AgentRow, email: string): AgentRow {
  return row.admin_email === email ? row : { ...row, admin_email: "" };
}

/**
 * Bring one agent into existence: its gate, its index row, and the settings it
 * starts out holding.
 *
 * The registry goes first and the directory second — the access list is what every
 * gate reads, so writing it is what makes the agent real; the directory row is only
 * what makes it findable. Fail between the two and there is an agent nobody can see
 * and nobody can open: an orphan, but not a leak.
 */
export async function provisionAgent(
  env: Env,
  origin: string,
  dir: ReturnType<typeof directory>,
  agent: {
    id: string;
    name: string;
    /** The whole access list, newline-separated. One address, for a fleet agent. */
    allowed: string;
    admin: string;
    fleet?: { id: string; name: string };
    meta?: MetaSettings;
    /** The OpenRouter key, when it came in at the top level rather than in `meta`. */
    key?: string;
    metadata?: Record<string, string>;
  }
): Promise<AgentRow> {
  await registry(env, agent.id).setAccess({
    allowed_emails: agent.allowed,
    admin_email: agent.admin,
  });
  const row = await dir.create(
    agent.id,
    agent.name,
    agent.allowed,
    agent.admin,
    agent.fleet,
    agent.metadata
  );

  // Seed the settings row so the agent has a model — and its key — the moment it
  // exists, which is what lets it answer without a trip through Settings. Telegram is
  // on from the start, so its whitelists are seeded here for the same reason the
  // first enable seeds them: empty lists would let all of Telegram talk to the bot
  // the moment a token is pasted.
  const reg = registry(env, row.id);
  await writeConfig(env, reg, { agent_name: row.name, ...TELEGRAM_WHITELIST_DEFAULTS });
  // The defaults are applied straight away: an agent made through the dialog is meant
  // to open already looking the way the settings step described it.
  if (agent.meta) {
    await reg.setMeta(agent.meta);
    await applyMeta(reg, agent.meta, env, origin, row.id);
  }
  // Already written by `applyMeta` when it came from the settings step; this is for
  // the caller that still sends it at the top level.
  if (agent.key) await writeConfig(env, reg, { openrouter_api_key: agent.key });
  return row;
}
