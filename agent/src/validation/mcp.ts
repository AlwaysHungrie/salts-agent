import { SECRET_MASK } from "../capabilities";
import { type McpAuth, type McpServerRow, parseHeaders } from "../mcp";
import type { Registry } from "../worker/stores";

/** What a PATCH or POST may set. Credentials aside, every field is user-editable. */
export function validateMcpBody(body: Record<string, unknown>): Partial<McpServerRow> {
  const patch: Partial<McpServerRow> = {};

  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (!name) throw new Error("name is required");
    patch.name = name.slice(0, 60);
  }
  if (body.url !== undefined) {
    const raw = String(body.url).trim();
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      throw new Error(`"${raw}" is not a valid URL`);
    }
    if (parsed.protocol !== "https:" && parsed.hostname !== "localhost") {
      // Credentials travel on every call, so the transport has to be encrypted.
      throw new Error("an MCP server URL must be https");
    }
    patch.url = parsed.toString();
  }
  if (body.auth !== undefined) {
    const auth = String(body.auth) as McpAuth;
    if (!["none", "headers", "oauth"].includes(auth)) throw new Error(`unknown auth: ${auth}`);
    patch.auth = auth;
  }
  if (body.headers !== undefined) {
    // Headers arrive as an object; a value left as the mask keeps the stored one.
    if (typeof body.headers !== "object" || body.headers === null) {
      throw new Error("headers must be an object");
    }
    patch.headers = JSON.stringify(body.headers).slice(0, 8000);
  }
  if (body.enabled !== undefined) patch.enabled = body.enabled ? 1 : 0;
  if (body.disabled_tools !== undefined) {
    if (!Array.isArray(body.disabled_tools)) throw new Error("disabled_tools must be an array");
    patch.disabled_tools = JSON.stringify(
      body.disabled_tools.filter((n): n is string => typeof n === "string")
    ).slice(0, 8000);
  }

  return patch;
}

/**
 * Names have to be distinct: a server's name is the prefix its tools reach the model
 * under, so two servers called the same thing would offer the model two different
 * tools under one name.
 */
export async function assertNameFree(
  reg: Registry,
  name: string,
  exceptId?: string
): Promise<void> {
  const taken = (await reg.mcpServers()).some(
    (s) => s.id !== exceptId && s.name.toLowerCase() === name.toLowerCase()
  );
  if (taken) throw new Error(`A server with name "${name}" already exists`);
}

/**
 * Merge a headers patch over what is stored, so a value the browser sent back as the
 * mask is left alone — the same contract the config secrets follow.
 */
export function mergeHeaders(current: string, incoming: string): string {
  const stored = parseHeaders(current);
  const next = parseHeaders(incoming);
  for (const [key, value] of Object.entries(next)) {
    if (value === SECRET_MASK && stored[key] !== undefined) next[key] = stored[key];
  }
  return JSON.stringify(next);
}
