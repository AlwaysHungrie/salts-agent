import "server-only";
import { excerpt } from "./prompt";
import { PROTOCOL } from "./protocol";
import { orNull, workerJson } from "./worker";

/**
 * A challenge is one agent on the Worker, tagged `app: socratic-salt`. Its creator
 * administers it through meta settings; everyone it lets in is a guest, who may only
 * message it in sessions of their own.
 */
export const APP_TAG = { app: "socratic-salt" } as const;
const WITH_APP = `with=app:${APP_TAG.app}`;

export type ChallengeCard = { id: string; name: string; excerpt: string };

export type PublicChallenge = { id: string; name: string; public_notes: string };

export type ChallengeSettings = {
  id: string;
  name: string;
  private_notes: string;
  public_notes: string;
  guests: { enabled: boolean; emails: string[] };
  model: string;
  max_tokens: number;
  cap_web_search: number;
  cap_url_fetch: number;
  /** Secrets arrive masked: "" when unset, a mask when set. */
  openrouter_api_key: string;
  brave_api_key: string;
  searxng_url: string;
  searxng_token: string;
  monthly_spend_limit: number;
  spend: { month_usd?: number } & Record<string, unknown>;
};

export type McpServer = {
  id: string;
  name: string;
  url: string;
  headers: Record<string, string>;
  tools: { name: string }[];
  last_error?: string;
};

export type SessionRow = {
  id: string;
  title: string;
  owner_email: string;
  created_at: number;
  updated_at: number;
};

export type StoredMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  ts: number;
  steps?: string;
};

type AgentRow = { id: string; name: string; admin_email: string };

const agentPath = (id: string) => `/api/agents/${encodeURIComponent(id)}`;

async function withExcerpts(rows: AgentRow[]): Promise<ChallengeCard[]> {
  return Promise.all(
    rows.map(async (a) => {
      const view = await orNull(getPublic(a.id)).catch(() => null);
      return { id: a.id, name: a.name, excerpt: view ? excerpt(view.public_notes) : "" };
    }),
  );
}

/** The challenges the caller created, and how many more they may create. */
export async function myChallenges() {
  const page = await workerJson<{
    agents: AgentRow[];
    agent_limit: number;
    agents_owned: number;
  }>(`/api/agents?${WITH_APP}&limit=100`);
  const mine = page.agents.filter((a) => a.admin_email);
  return {
    challenges: await withExcerpts(mine),
    canCreate: page.agents_owned < page.agent_limit,
  };
}

/** The challenges the caller may take on as a guest. */
export async function openChallenges(): Promise<ChallengeCard[]> {
  const page = await workerJson<{ agents: AgentRow[] }>(`/api/agents?as=guest&${WITH_APP}&limit=100`);
  return withExcerpts(page.agents);
}

export function getPublic(id: string): Promise<PublicChallenge> {
  return workerJson<PublicChallenge>(`${agentPath(id)}/public`);
}

/** Whether the caller created this challenge. */
export async function isOwner(id: string): Promise<boolean> {
  const agent = await orNull(workerJson<AgentRow>(agentPath(id)));
  return !!agent?.admin_email;
}

export async function createChallenge(name: string, email: string): Promise<string> {
  const agent = await workerJson<{ id: string }>("/api/agents", {
    method: "POST",
    body: JSON.stringify({ name, allowed_emails: email, metadata: APP_TAG }),
  });
  // A challenge is text, the web and MCP. Everything else starts off, and memory
  // above all: it is shared by every session, so one guest could plant facts for the
  // next.
  await workerJson(`${agentPath(agent.id)}/config`, {
    method: "PATCH",
    body: JSON.stringify({
      system_prompt: PROTOCOL,
      // Room for the reply, the running tally and any reasoning the model spends first.
      max_tokens: 2000,
      cap_web_search: 0,
      cap_url_fetch: 1,
      cap_mcp: 1,
      cap_file_ingest: 0,
      cap_vision: 0,
      cap_image_generation: 0,
      cap_audio_input: 0,
      cap_voice_output: 0,
      cap_scheduled_tasks: 0,
      cap_memory: 0,
      cap_telegram: 0,
      cap_whatsapp: 0,
    }),
  });
  return agent.id;
}

/** null when the caller is not the creator. */
export async function getSettings(id: string): Promise<ChallengeSettings | null> {
  const meta = await orNull(
    workerJson<{ meta: { monthly_spend_limit: number }; spend: ChallengeSettings["spend"] }>(
      `${agentPath(id)}/meta`,
    ),
  );
  if (!meta) return null;
  const { agent, config, guests } = await workerJson<{
    agent: AgentRow;
    config: Omit<ChallengeSettings, "id" | "name" | "guests" | "monthly_spend_limit" | "spend">;
    guests: ChallengeSettings["guests"];
  }>(`${agentPath(id)}/config`);
  return {
    ...config,
    id: agent.id,
    name: agent.name,
    guests,
    monthly_spend_limit: meta.meta.monthly_spend_limit,
    spend: meta.spend,
  };
}

export type SettingsInput = {
  name: string;
  private_notes: string;
  public_notes: string;
  guests: boolean;
  guest_emails: string[];
  model: string;
  max_tokens: number;
  web_search: boolean;
  url_fetch: boolean;
  monthly_spend_limit: number;
  /** Blank means "keep the saved one". */
  openrouter_api_key: string;
  brave_api_key: string;
  searxng_url: string;
  searxng_token: string;
};

/** Saved through meta settings: the admin's own route, with the agent's config beside it. */
export async function saveSettings(id: string, input: SettingsInput): Promise<void> {
  await workerJson(agentPath(id), {
    method: "PATCH",
    body: JSON.stringify({
      name: input.name,
      guests: input.guests,
      guest_emails: input.guest_emails,
    }),
  });
  const { meta } = await workerJson<{ meta: Record<string, unknown> }>(`${agentPath(id)}/meta`);
  await workerJson(`${agentPath(id)}/meta`, {
    method: "PATCH",
    body: JSON.stringify({
      ...meta,
      monthly_spend_limit: input.monthly_spend_limit,
      config: {
        system_prompt: PROTOCOL,
        private_notes: input.private_notes,
        public_notes: input.public_notes,
        model: input.model,
        max_tokens: input.max_tokens,
        cap_web_search: input.web_search ? 1 : 0,
        cap_url_fetch: input.url_fetch ? 1 : 0,
        searxng_url: input.searxng_url,
        ...(input.openrouter_api_key ? { openrouter_api_key: input.openrouter_api_key } : {}),
        ...(input.brave_api_key ? { brave_api_key: input.brave_api_key } : {}),
        ...(input.searxng_token ? { searxng_token: input.searxng_token } : {}),
      },
    }),
  });
}

export async function deleteChallenge(id: string): Promise<void> {
  await workerJson(agentPath(id), { method: "DELETE" });
}

export async function modelCatalog(): Promise<{ id: string; label: string }[]> {
  return (await workerJson<{ models: { id: string; label: string }[] }>("/api/agents/catalog")).models;
}

export async function mcpServers(id: string): Promise<McpServer[]> {
  return (await workerJson<{ servers: McpServer[] }>(`${agentPath(id)}/mcp?meta=1`)).servers;
}

export async function addMcpServer(
  id: string,
  server: { name: string; url: string; headers: Record<string, string> },
): Promise<void> {
  const withHeaders = Object.keys(server.headers).length > 0;
  await workerJson(`${agentPath(id)}/mcp?meta=1`, {
    method: "POST",
    body: JSON.stringify({
      name: server.name,
      url: server.url,
      auth: withHeaders ? "headers" : "none",
      ...(withHeaders ? { headers: server.headers } : {}),
    }),
  });
}

export async function removeMcpServer(id: string, serverId: string): Promise<void> {
  await workerJson(`${agentPath(id)}/mcp/${encodeURIComponent(serverId)}?meta=1`, { method: "DELETE" });
}

/* ------------------------------------------------------------------ sessions -- */

/** The caller's own conversation with a challenge: their most recent session. */
export async function mySession(id: string): Promise<SessionRow | null> {
  const page = await workerJson<{ sessions: SessionRow[] }>(`${agentPath(id)}/sessions?mine=1&limit=1`);
  return page.sessions[0] ?? null;
}

export async function startSession(id: string): Promise<SessionRow> {
  return workerJson<SessionRow>(`${agentPath(id)}/sessions`, {
    method: "POST",
    body: JSON.stringify({ title: "Debate" }),
  });
}

export async function deleteSession(sessionId: string): Promise<void> {
  await workerJson(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
}

/** Every conversation with a challenge, newest first. Owner only. */
export async function allSessions(id: string): Promise<SessionRow[]> {
  return (await workerJson<{ sessions: SessionRow[] }>(`${agentPath(id)}/sessions?limit=200`)).sessions;
}

export async function transcript(sessionId: string): Promise<StoredMessage[]> {
  const { messages } = await workerJson<{ messages: StoredMessage[] }>(
    `/agents/session-agent/${encodeURIComponent(sessionId)}/messages?limit=200`,
  );
  return messages;
}
