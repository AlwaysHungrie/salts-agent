import { agentRoutes } from "../routes/agent";
import { settingsRoutes } from "../routes/agent-settings";
import { apiKeyRoutes } from "../routes/api-keys";
import { mcpRoutes } from "../routes/mcp";
import { sessionAgentRoutes } from "../routes/session-agent";
import { sessionRoutes } from "../routes/sessions";
import { createApiApp, serveDocs } from "./app";

/**
 * The typed API: every route an agent's API key can reach, validated by zod and
 * documented from the same schemas at `/openapi.json`. Built once per isolate.
 */
export const api = createApiApp();
agentRoutes(api);
settingsRoutes(api);
mcpRoutes(api);
apiKeyRoutes(api);
sessionRoutes(api);
sessionAgentRoutes(api);
serveDocs(api);

/** Whether a path belongs to the typed API rather than the Worker's other routes. */
export function isApiPath(segments: string[]): boolean {
  const [first, second, third] = segments;
  if (first === "openapi.json" && !second) return true;
  if (!third) return false;
  if (first === "api" && second === "agents") return third !== "catalog";
  return (
    (first === "api" && second === "sessions") || (first === "agents" && second === "session-agent")
  );
}

/**
 * The request with a JSON body Hono will read: JSON whatever the content type says (as
 * these routes always took it), and `{}` for an empty one. Uploads pass untouched.
 */
export async function asJsonRequest(request: Request): Promise<Request> {
  if (request.method === "GET" || request.method === "HEAD" || !request.body) return request;
  const type = request.headers.get("content-type") ?? "";
  if (/^multipart\/form-data/i.test(type)) return request;
  const text = await request.text();
  const headers = new Headers(request.headers);
  headers.set("content-type", "application/json");
  return new Request(request, { headers, body: text.trim() ? text : "{}" });
}
