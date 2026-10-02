import type { Env } from "../env";
import { agentIdOf, sessionLimitMessage, sessionName } from "../registry";
import { deploymentSettings } from "../settings";
import { callerEmail } from "../worker/auth";
import { errorMessage, json, jsonError, readJson } from "../worker/http";
import { callSession, destroySession, registry, syncSessionCount } from "../worker/stores";

/**
 * Everything under `/api/sessions/:id`. A session name is `<agentId>~<local>`, so the
 * id alone says which registry it lives in.
 */
export async function handleSession(
  request: Request,
  env: Env,
  url: URL,
  segments: string[]
): Promise<Response | undefined> {
  const id = segments[2];
  const agentId = agentIdOf(id);
  if (!agentId) return jsonError("not found", 404);
  const reg = registry(env, agentId);

  if (request.method === "POST" && segments[3] === "fork") {
    return await forkSession(request, env, url, agentId, id);
  }

  // A session whose turns stopped completing, freed without losing what it holds.
  if (request.method === "POST" && segments[3] === "unstick") {
    const freed = await callSession(env, url.origin, id, "unstick", { method: "POST" });
    if (!freed?.ok) return jsonError("could not reach that session", 502);
    return json(await freed.json());
  }

  if (request.method === "PATCH") {
    const { title } = (await request.json()) as { title: string };
    await reg.rename(id, title);
    return json({ ok: true });
  }

  if (request.method === "DELETE") {
    await reg.remove(id);
    await syncSessionCount(env, agentId);
    await destroySession(env, url.origin, id);
    return json({ ok: true });
  }

  return undefined;
}

/**
 * A new session seeded with the first `count` messages of an existing one, in the same
 * agent. The session cap is checked before the (possibly long) export.
 */
async function forkSession(
  request: Request,
  env: Env,
  url: URL,
  agentId: string,
  id: string
): Promise<Response> {
  const reg = registry(env, agentId);
  const { count, title } = await readJson<{ count?: number; title?: string }>(request);
  const { max_sessions } = await deploymentSettings(env);
  if ((await reg.countSessions()) >= max_sessions) {
    return jsonError(sessionLimitMessage(max_sessions), 409);
  }
  const exported = await callSession(env, url.origin, id, `export?count=${Number(count ?? 0)}`);
  if (!exported?.ok) return jsonError("could not read the source session", 502);
  const snapshot = await exported.text();

  const forkId = sessionName(agentId, crypto.randomUUID().slice(0, 8));
  const objectId = env.SessionAgent.idFromName(forkId).toString();
  const source = await reg.get(id);
  let row;
  try {
    row = await reg.create(
      forkId,
      title ?? `${source?.title ?? "Session"} (fork)`,
      objectId,
      undefined,
      max_sessions,
      await callerEmail(request, env)
    );
  } catch (err) {
    return jsonError(errorMessage(err), 409);
  }
  await syncSessionCount(env, agentId);
  const imported = await callSession(env, url.origin, forkId, "import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: snapshot,
  });
  if (!imported?.ok) {
    await reg.remove(forkId);
    await syncSessionCount(env, agentId);
    // 413 (no room for the copied files) carries a reason the person can act on.
    const reason = (await imported?.json().catch(() => null)) as { error?: string } | null;
    return jsonError(
      reason?.error ?? "could not seed the fork",
      imported?.status === 413 ? 413 : 502
    );
  }
  return json(row);
}
