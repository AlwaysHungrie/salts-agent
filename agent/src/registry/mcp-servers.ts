import { type McpServerRow, McpTokenError, refreshToken } from "../mcp";

/** The `mcp_servers` columns, in write order, excluding the primary key. */
export const MCP_COLUMNS = [
  "name",
  "url",
  "auth",
  "headers",
  "enabled",
  "oauth_client_id",
  "oauth_client_secret",
  "oauth_access_token",
  "oauth_refresh_token",
  "oauth_expires_at",
  "oauth_scope",
  "oauth_token_url",
  "oauth_authorize_url",
  "oauth_registration_url",
  "oauth_resource",
  "oauth_verifier",
  "oauth_state",
  "oauth_return_to",
  "tools_json",
  "disabled_tools",
  "tools_synced_at",
  "last_error",
  "created_at",
] as const;

/** A server the user has not filled in yet: every column with nothing in it. */
export const EMPTY_MCP_SERVER: Omit<McpServerRow, "id" | "name" | "url" | "created_at"> = {
  auth: "none",
  headers: "",
  enabled: 1,
  oauth_client_id: "",
  oauth_client_secret: "",
  oauth_access_token: "",
  oauth_refresh_token: "",
  oauth_expires_at: 0,
  oauth_scope: "",
  oauth_token_url: "",
  oauth_authorize_url: "",
  oauth_registration_url: "",
  oauth_resource: "",
  oauth_verifier: "",
  oauth_state: "",
  oauth_return_to: "",
  tools_json: "",
  disabled_tools: "",
  tools_synced_at: 0,
  last_error: "",
};

export function listMcpServers(storage: DurableObjectStorage): McpServerRow[] {
  return storage.sql
    .exec(`SELECT id, ${MCP_COLUMNS.join(", ")} FROM mcp_servers ORDER BY created_at`)
    .toArray() as unknown as McpServerRow[];
}

export function getMcpServer(storage: DurableObjectStorage, id: string): McpServerRow | undefined {
  return storage.sql
    .exec(`SELECT id, ${MCP_COLUMNS.join(", ")} FROM mcp_servers WHERE id = ? LIMIT 1`, id)
    .toArray()[0] as unknown as McpServerRow | undefined;
}

export function getMcpServerByState(
  storage: DurableObjectStorage,
  state: string
): McpServerRow | undefined {
  if (!state) return undefined;
  return storage.sql
    .exec(
      `SELECT id, ${MCP_COLUMNS.join(", ")} FROM mcp_servers WHERE oauth_state = ? LIMIT 1`,
      state
    )
    .toArray()[0] as unknown as McpServerRow | undefined;
}

export function addMcpServer(storage: DurableObjectStorage, row: McpServerRow): McpServerRow {
  const placeholders = MCP_COLUMNS.map(() => "?").join(", ");
  storage.sql.exec(
    `INSERT INTO mcp_servers (id, ${MCP_COLUMNS.join(", ")}) VALUES (?, ${placeholders})`,
    row.id,
    ...MCP_COLUMNS.map((c) => row[c])
  );
  return row;
}

export function updateMcpServer(
  storage: DurableObjectStorage,
  id: string,
  patch: Partial<McpServerRow>
): McpServerRow | undefined {
  const keys = MCP_COLUMNS.filter((c) => patch[c] !== undefined);
  if (keys.length > 0) {
    storage.sql.exec(
      `UPDATE mcp_servers SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`,
      ...keys.map((k) => patch[k] as string | number),
      id
    );
  }
  return getMcpServer(storage, id);
}

export async function performRefresh(
  storage: DurableObjectStorage,
  server: McpServerRow
): Promise<McpServerRow | undefined> {
  try {
    const tokens = await refreshToken(server.oauth_token_url, {
      refreshToken: server.oauth_refresh_token,
      clientId: server.oauth_client_id,
      clientSecret: server.oauth_client_secret || undefined,
      resource: server.oauth_resource || undefined,
    });
    return updateMcpServer(storage, server.id, {
      oauth_access_token: tokens.access_token,
      // A provider that rotates hands back a new one; keep the old when it does not.
      oauth_refresh_token: tokens.refresh_token ?? server.oauth_refresh_token,
      oauth_expires_at: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : 0,
      last_error: "",
    });
  } catch (err) {
    // A refused grant ends the connection: clear the tokens so the card offers Connect.
    if (err instanceof McpTokenError && err.permanent) {
      return updateMcpServer(storage, server.id, {
        oauth_access_token: "",
        oauth_refresh_token: "",
        oauth_expires_at: 0,
        tools_json: "",
        last_error: "The connection expired. Connect again to keep using it.",
      });
    }
    return updateMcpServer(storage, server.id, {
      last_error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function noteMcpError(storage: DurableObjectStorage, id: string, message: string) {
  storage.sql.exec(`UPDATE mcp_servers SET last_error = ? WHERE id = ?`, message, id);
}

export function removeMcpServer(storage: DurableObjectStorage, id: string) {
  storage.sql.exec(`DELETE FROM mcp_servers WHERE id = ?`, id);
}
