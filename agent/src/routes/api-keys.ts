import { createRoute, z } from "@hono/zod-openapi";
import { type ApiApp, jsonOf, refusals } from "../api/app";
import { ApiKeyInfoSchema, OkSchema } from "../api/schemas";
import type { ApiKeyRole } from "../registry";
import { newApiKey } from "../worker/auth";
import { refuseNotFound } from "../worker/http";
import { type AgentCall, AgentParams, agentRoute, may } from "./agent";

/** Whether the caller manages this role's key: the admin's is theirs, the user key everyone's. */
function manages(call: AgentCall, role: ApiKeyRole): boolean {
  return role === "admin" ? call.isAdmin : call.isUser || call.isAdmin;
}

const RoleParams = AgentParams.extend({
  role: z.enum(["admin", "user"]).openapi({ param: { name: "role", in: "path" } }),
});

const tag = ["API keys"];

/**
 * `/api/agents/{agentId}/api-keys[/{role}]`. Listing never shows a key; generating
 * replaces the role's key and returns it this once; deleting revokes it.
 */
export function apiKeyRoutes(app: ApiApp) {
  app.openapi(
    createRoute({
      method: "get",
      path: "/api/agents/{agentId}/api-keys",
      tags: tag,
      summary: "List the keys the caller manages",
      middleware: [agentRoute(may.either)] as const,
      request: { params: AgentParams },
      responses: {
        200: jsonOf(z.object({ keys: z.array(ApiKeyInfoSchema) })),
        ...refusals(404),
      },
    }),
    async (c) => {
      const call = c.var.call;
      const keys = (await call.reg.apiKeys()).filter((k) => manages(call, k.role));
      return c.json({ keys }, 200);
    }
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/agents/{agentId}/api-keys/{role}",
      tags: tag,
      summary: "Generate the role's key, replacing any it had",
      description: "The answer carries the key. It is never shown again.",
      middleware: [agentRoute(may.either)] as const,
      request: { params: RoleParams },
      responses: {
        200: jsonOf(ApiKeyInfoSchema.extend({ key: z.string() }).openapi("NewApiKey")),
        ...refusals(404),
      },
    }),
    async (c) => {
      const call = c.var.call;
      const { role } = c.req.valid("param");
      if (!manages(call, role)) refuseNotFound();
      const { key, hash, hint } = await newApiKey(call.agentId, role);
      const saved = await call.reg.setApiKey(role, hash, hint);
      return c.json({ ...saved, key }, 200);
    }
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/api/agents/{agentId}/api-keys/{role}",
      tags: tag,
      summary: "Revoke the role's key",
      middleware: [agentRoute(may.either)] as const,
      request: { params: RoleParams },
      responses: { 200: jsonOf(OkSchema), ...refusals(404) },
    }),
    async (c) => {
      const call = c.var.call;
      const { role } = c.req.valid("param");
      if (!manages(call, role)) refuseNotFound();
      await call.reg.removeApiKey(role);
      return c.json({ ok: true }, 200);
    }
  );
}
