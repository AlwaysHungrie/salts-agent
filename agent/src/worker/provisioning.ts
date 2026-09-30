import type { Env } from "../env";
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
 * Write the meta defaults into the agent: tuning, capabilities and missing MCP servers.
 * Explicit, so hand tuning is not undone on every save; existing servers are left alone.
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
 * Delete an agent and everything it owns. The bot is unhooked first, so Telegram does
 * not keep retrying a dead route.
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

  // Directory row first: `wipe()` leaves the registry unseeded, and an unseeded registry
  // re-seeds from the directory, so a mid-teardown request could resurrect the access list.
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
 * An agent row as this caller may see it: the admin's address is blanked for everyone
 * else (a fleet would leak it to every member). Gates never read this copy.
 */
export function agentFor(row: AgentRow, email: string): AgentRow {
  return row.admin_email === email ? row : { ...row, admin_email: "" };
}

/**
 * Create one agent: registry access first (what makes it real), then the directory row
 * (what makes it findable). A failure between leaves an orphan, not a leak.
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

  // Seed settings now so the agent can answer at once, with placeholder Telegram whitelists
  // so pasting a token does not open the bot to everyone.
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
