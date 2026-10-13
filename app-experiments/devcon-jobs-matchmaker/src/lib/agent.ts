import "server-only";

/**
 * The agent on the Worker, reached with its user API key. The key is the whole
 * credential: every session it starts belongs to the agent, not to any one user, so
 * which session is whose is this app's to remember (see `db.ts`).
 */

function config() {
  const url = process.env.AGENT_URL?.replace(/\/+$/, "");
  const agentId = process.env.AGENT_ID;
  const key = process.env.AGENT_API_KEY;
  if (!url || !agentId || !key) throw new AgentError("AGENT_URL, AGENT_ID and AGENT_API_KEY must be set.", 500);
  return { url, agentId, key };
}

export class AgentError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export type StoredMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  ts: number;
};

/** A raw call to the Worker with the key attached. */
export async function agentFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const { url, key } = config();
  try {
    return await fetch(`${url}${path}`, {
      cache: "no-store",
      ...init,
      headers: { authorization: `Bearer ${key}`, ...(init.headers as Record<string, string> | undefined) },
    });
  } catch {
    throw new AgentError("Cannot reach the agent.", 502);
  }
}

/** The Worker's `{ error }` as a thrown AgentError when the response is not ok. */
export async function ensureOk(res: Response): Promise<Response> {
  if (res.ok) return res;
  const text = await res.text().catch(() => "");
  let detail = "";
  try {
    detail = (JSON.parse(text) as { error?: string }).error ?? "";
  } catch {}
  throw new AgentError(detail || `The agent returned ${res.status}.`, res.status >= 500 ? 502 : res.status);
}

async function json<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await ensureOk(
    await agentFetch(path, { ...init, headers: { "content-type": "application/json", ...(init.headers as Record<string, string>) } }),
  );
  return (await res.json()) as T;
}

const sessionPath = (sessionId: string, rest: string) =>
  `/agents/session-agent/${encodeURIComponent(sessionId)}/${rest}`;

export async function createSession(title: string): Promise<string> {
  const { agentId } = config();
  const row = await json<{ id: string }>(`/api/agents/${encodeURIComponent(agentId)}/sessions`, {
    method: "POST",
    body: JSON.stringify({ title }),
  });
  return row.id;
}

export async function deleteSession(sessionId: string): Promise<void> {
  await json(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
}

/** Attach a file to the session's next message. */
export async function uploadFile(sessionId: string, file: File): Promise<void> {
  const form = new FormData();
  form.append("file", file, file.name);
  await ensureOk(await agentFetch(sessionPath(sessionId, "files"), { method: "POST", body: form }));
}

/** Send a message and wait for the whole reply. */
export async function chat(sessionId: string, message: string): Promise<string> {
  const body = await json<{ reply: string }>(sessionPath(sessionId, "chat"), {
    method: "POST",
    body: JSON.stringify({ message }),
  });
  return body.reply;
}

/** Send a message; the response body is the reply as server-sent events. */
export async function stream(sessionId: string, message: string, signal?: AbortSignal): Promise<ReadableStream<Uint8Array>> {
  const res = await ensureOk(
    await agentFetch(sessionPath(sessionId, "stream"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message }),
      signal,
    }),
  );
  if (!res.body) throw new AgentError("The agent sent no reply.", 502);
  return res.body;
}

/** The whole transcript, oldest first. The Worker caps the page size, so page back. */
export async function transcript(sessionId: string): Promise<StoredMessage[]> {
  const all = new Map<string, StoredMessage>();
  let before = "";
  for (;;) {
    const query = `messages?limit=100${before ? `&before=${encodeURIComponent(before)}` : ""}`;
    const page = await json<{ messages: StoredMessage[]; has_more: boolean }>(sessionPath(sessionId, query));
    for (const { id, role, content, ts } of page.messages) all.set(id, { id, role, content, ts });
    const oldest = page.messages.reduce<StoredMessage | null>((o, m) => (!o || m.ts < o.ts ? m : o), null);
    if (!page.has_more || !oldest || oldest.id === before) break;
    before = oldest.id;
  }
  return [...all.values()].sort((a, b) => a.ts - b.ts);
}
