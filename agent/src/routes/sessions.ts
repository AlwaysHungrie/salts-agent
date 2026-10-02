import { createRoute, z } from "@hono/zod-openapi";
import { type ApiApp, jsonOf, refusals } from "../api/app";
import { OkSchema, SessionRowSchema } from "../api/schemas";
import type { Env } from "../env";
import { agentIdOf, sessionLimitMessage, sessionName } from "../registry";
import { deploymentSettings } from "../settings";
import { callerEmail } from "../worker/auth";
import { ApiError, errorMessage } from "../worker/http";
import { callSession, destroySession, registry, syncSessionCount } from "../worker/stores";

/**
 * The `{sessionId}` path parameter. A session id is `<agentId>~<local>`, so the id alone
 * says which registry it lives in. The gate has already checked the caller may use it.
 */
export const SessionParams = z.object({
  sessionId: z
    .string()
    .openapi({ param: { name: "sessionId", in: "path" }, example: "ab12cd34~1a2b3c4d" }),
});

const tag = ["Sessions"];

/** Everything under `/api/sessions/{sessionId}`: rename, delete, fork, unstick. */
export function sessionRoutes(app: ApiApp) {
  app.openapi(
    createRoute({
      method: "patch",
      path: "/api/sessions/{sessionId}",
      tags: tag,
      summary: "Rename a session",
      request: {
        params: SessionParams,
        body: { content: { "application/json": { schema: z.object({ title: z.string() }) } } },
      },
      responses: { 200: jsonOf(OkSchema), ...refusals(400, 404) },
    }),
    async (c) => {
      const { sessionId } = c.req.valid("param");
      await registry(c.env, agentIdOf(sessionId)).rename(sessionId, c.req.valid("json").title);
      return c.json({ ok: true }, 200);
    }
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/api/sessions/{sessionId}",
      tags: tag,
      summary: "Delete a session and everything in it",
      request: { params: SessionParams },
      responses: { 200: jsonOf(OkSchema), ...refusals(404) },
    }),
    async (c) => {
      const { sessionId } = c.req.valid("param");
      const agentId = agentIdOf(sessionId);
      await registry(c.env, agentId).remove(sessionId);
      await syncSessionCount(c.env, agentId);
      await destroySession(c.env, new URL(c.req.url).origin, sessionId);
      return c.json({ ok: true }, 200);
    }
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/sessions/{sessionId}/fork",
      tags: tag,
      summary: "Copy the first `count` messages into a new session",
      request: {
        params: SessionParams,
        body: {
          content: {
            "application/json": {
              schema: z.object({ count: z.number().optional(), title: z.string().optional() }),
            },
          },
        },
      },
      responses: { 200: jsonOf(SessionRowSchema), ...refusals(404, 409, 413, 502) },
    }),
    async (c) => {
      const { sessionId } = c.req.valid("param");
      const { count, title } = c.req.valid("json");
      return c.json(await forkSession(c.req.raw, c.env, sessionId, count ?? 0, title), 200);
    }
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/sessions/{sessionId}/unstick",
      tags: tag,
      summary: "Free a session whose replies stopped finishing",
      description: "Cancels running turns. Messages, files and memory stay.",
      request: { params: SessionParams },
      responses: {
        200: jsonOf(z.object({ ok: z.boolean(), cancelled: z.boolean() }).loose()),
        ...refusals(404, 502),
      },
    }),
    async (c) => {
      const { sessionId } = c.req.valid("param");
      const freed = await callSession(c.env, new URL(c.req.url).origin, sessionId, "unstick", {
        method: "POST",
      });
      if (!freed?.ok) throw new ApiError(502, "could not reach that session");
      return c.json((await freed.json()) as { ok: boolean; cancelled: boolean }, 200);
    }
  );
}

/**
 * A new session seeded with the first `count` messages of an existing one, in the same
 * agent. The session cap is checked before the (possibly long) export.
 */
async function forkSession(
  request: Request,
  env: Env,
  id: string,
  count: number,
  title: string | undefined
) {
  const origin = new URL(request.url).origin;
  const agentId = agentIdOf(id);
  const reg = registry(env, agentId);
  const { max_sessions } = await deploymentSettings(env);
  if ((await reg.countSessions()) >= max_sessions) {
    throw new ApiError(409, sessionLimitMessage(max_sessions));
  }
  const exported = await callSession(env, origin, id, `export?count=${Number(count)}`);
  if (!exported?.ok) throw new ApiError(502, "could not read the source session");
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
    throw new ApiError(409, errorMessage(err));
  }
  await syncSessionCount(env, agentId);
  const imported = await callSession(env, origin, forkId, "import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: snapshot,
  });
  if (!imported?.ok) {
    await reg.remove(forkId);
    await syncSessionCount(env, agentId);
    // 413 (no room for the copied files) carries a reason the person can act on.
    const reason = (await imported?.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(
      imported?.status === 413 ? 413 : 502,
      reason?.error ?? "could not seed the fork"
    );
  }
  return row;
}
