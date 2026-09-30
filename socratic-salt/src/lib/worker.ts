import "server-only";
import { agentHeaders } from "./upstream";

/**
 * The agent Worker, called as whoever is signed in. The Worker decides what that
 * person may reach — owner, guest, or nobody — so this app holds no secret of its own.
 */
export const AGENT_URL = (
  (process.env.USE_LOCAL_AGENT === "true" ? process.env.LOCALHOST_AGENT_URL : process.env.AGENT_URL) ??
  "http://localhost:8787"
).replace(/\/+$/, "");

export async function workerHeaders(): Promise<Record<string, string>> {
  return agentHeaders();
}

export async function worker(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${AGENT_URL}${path}`, {
    cache: "no-store",
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers as Record<string, string> | undefined),
      ...(await agentHeaders()),
    },
  });
}

export class WorkerError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function workerJson<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await worker(path, init);
  } catch {
    throw new WorkerError(`Cannot reach the agent Worker at ${AGENT_URL}.`, 502);
  }
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  if (!res.ok) {
    const detail = (body as { error?: unknown } | undefined)?.error;
    throw new WorkerError(
      typeof detail === "string" && detail ? detail : `The agent Worker returned ${res.status}.`,
      res.status,
    );
  }
  return body as T;
}

/** A 404 from the Worker means "not yours to see". Anything else is a real failure. */
export async function orNull<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch (err) {
    if (err instanceof WorkerError && (err.status === 404 || err.status === 401)) return null;
    throw err;
  }
}
