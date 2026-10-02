import { OpenAPIHono, type z } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Env } from "../env";
import type { AgentCall } from "../routes/agent";
import { ApiError, jsonError, withCors } from "../worker/http";
import { ErrorSchema } from "./schemas";

/** What every API handler can reach: the Worker's bindings, and what middleware resolved. */
export type ApiEnv = {
  Bindings: Env;
  Variables: {
    /** The agent and the caller's roles on it, for `/api/agents/{agentId}/…`. */
    call: AgentCall;
    /** An unread copy of the request, for routes that hand it on to a session object. */
    forward: Request;
  };
};

export type ApiApp = OpenAPIHono<ApiEnv>;

/** The first validation problem, as one sentence. */
function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "invalid request";
  return issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message;
}

/** A fresh app: CORS on every answer, refusals as `{ error }`, unknown paths as 404. */
export function createApiApp(): ApiApp {
  const app = new OpenAPIHono<ApiEnv>({
    defaultHook: (result) => {
      if (!result.success) return jsonError(firstIssue(result.error), 400);
    },
  });
  app.use("*", async (c, next) => {
    await next();
    // Rebuilt rather than edited: a session object's answer has immutable headers.
    c.res = withCors(c.res);
  });
  app.onError((err) => {
    if (err instanceof ApiError) return jsonError(err.message, err.status);
    if (err instanceof HTTPException) return jsonError(err.message, err.status);
    throw err;
  });
  app.notFound(() => jsonError("not found", 404));
  app.openAPIRegistry.registerComponent("securitySchemes", "apiKey", {
    type: "http",
    scheme: "bearer",
    description:
      "An agent API key (`salt_user_…` or `salt_admin_…`), from the agent's settings. A signed-in session token works too.",
  });
  return app;
}

/** Serve the generated OpenAPI document at `/openapi.json`. */
export function serveDocs(app: ApiApp) {
  app.doc31("/openapi.json", (c) => ({
    openapi: "3.1.0",
    info: {
      title: "Salt agent API",
      version: "1",
      description:
        "Everything an agent API key can do. The user key reaches what a member can; the admin key what the agent's admin can. A key works on its own agent only.",
    },
    servers: [{ url: new URL(c.req.url).origin }],
    security: [{ apiKey: [] }],
  }));
}

/** A JSON body or answer of this schema. */
export function jsonOf<T extends z.ZodType>(schema: T, description = "OK") {
  return { description, content: { "application/json": { schema } } };
}

/** The refusals a route can answer with, documented as `{ error }`. */
export function refusals(...codes: (400 | 403 | 404 | 409 | 413 | 502)[]) {
  const said: Record<number, string> = {
    400: "The request is not valid.",
    403: "Not allowed for this agent.",
    404: "No such agent, or not one this caller may reach.",
    409: "Conflicts with what is there.",
    413: "Too large, or no room left.",
    502: "An upstream service failed.",
  };
  return Object.fromEntries(codes.map((code) => [code, jsonOf(ErrorSchema, said[code])]));
}

/** Keep an unread copy of the request before validation reads its body. */
export const keepForward: MiddlewareHandler<ApiEnv> = async (c, next) => {
  c.set("forward", c.req.raw.clone());
  await next();
};
