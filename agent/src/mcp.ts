/**
 * External MCP servers: the agent's tools, hosted by someone else.
 *
 * A server here is always remote and always speaks Streamable HTTP — Notion's,
 * MetaMCP's, and every other hosted server do. There is no stdio transport: a Worker
 * has no subprocesses to give one.
 *
 * Two ways in, because that is what providers actually ask for:
 *
 * - Headers. A key pasted into a header, which is how MetaMCP and most API-key
 *   servers authenticate.
 * - OAuth. The full MCP authorization flow — protected-resource discovery, dynamic
 *   client registration, PKCE — which is how Notion authenticates. Nothing is typed
 *   in: the user clicks Connect and approves it at the provider.
 *
 * The JSON-RPC client is hand-rolled rather than pulled from the MCP SDK: three
 * methods (initialize, tools/list, tools/call) over `fetch` is less code than the
 * bundle it would cost inside a Worker.
 */

export type McpAuth = "none" | "headers" | "oauth";

/** One tool a server advertises, as `tools/list` returns it. */
export type McpTool = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

export type McpServerRow = {
  id: string;
  /** What the user calls it. Also the prefix its tools reach the model under. */
  name: string;
  url: string;
  auth: McpAuth;
  /** Custom headers as a JSON object, `{"Authorization": "Bearer …"}`. */
  headers: string;
  enabled: number;

  /* OAuth state, all empty until the user connects. */
  oauth_client_id: string;
  oauth_client_secret: string;
  oauth_access_token: string;
  oauth_refresh_token: string;
  /** Epoch ms the access token dies at. 0 when it does not expire. */
  oauth_expires_at: number;
  oauth_scope: string;
  /** Token endpoint, kept so a refresh needs no rediscovery. */
  oauth_token_url: string;
  oauth_authorize_url: string;
  oauth_registration_url: string;
  /** The canonical resource id the tokens are bound to (RFC 8707). */
  oauth_resource: string;
  /** PKCE verifier and CSRF state, live only between Connect and the callback. */
  oauth_verifier: string;
  oauth_state: string;
  /** Where to send the browser once the callback lands. */
  oauth_return_to: string;

  /** Cached `tools/list`, as JSON. Refreshed on save, on connect, and on demand. */
  tools_json: string;
  /**
   * The tools of this server the agent may not call, as a JSON array of names. Kept
   * as the exclusions rather than the inclusions so a tool the provider adds later
   * arrives switched on, which is what someone who never opened this list expects.
   */
  disabled_tools: string;
  tools_synced_at: number;
  /** Why the last sync failed, shown on the card. Empty when it worked. */
  last_error: string;
  created_at: number;
};

/** What the browser may see: tokens never leave the Worker. */
export type McpServerView = Omit<
  McpServerRow,
  | "oauth_client_secret"
  | "oauth_access_token"
  | "oauth_refresh_token"
  | "oauth_verifier"
  | "oauth_state"
  | "headers"
  | "tools_json"
  | "disabled_tools"
> & {
  /**
   * Saved headers. Values are real for a caller that may edit the server's list, and
   * the mask for anyone else.
   */
  headers: Record<string, string>;
  tools: McpTool[];
  /** Names from `tools` the agent may not call. */
  disabled_tools: string[];
  connected: boolean;
};

export const MCP_PROTOCOL_VERSION = "2025-06-18";

/* ------------------------------------------------------------- transport -- */

type JsonRpcResponse = {
  jsonrpc?: string;
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

/**
 * Raised when the authorization server refuses a token request. `permanent` marks the
 * refusals that will not come good on their own — a spent or revoked refresh token —
 * as opposed to the provider being briefly unreachable.
 */
export class McpTokenError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly permanent: boolean
  ) {
    super(message);
  }
}

/** Raised when the server answers 401: the caller may refresh a token and retry. */
export class McpUnauthorized extends Error {
  constructor(public readonly resourceMetadata?: string) {
    super("the MCP server rejected the credentials");
  }
}

export function parseHeaders(json: string): Record<string, string> {
  if (!json.trim()) return {};
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "string" && k.trim()) out[k.trim()] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * A Streamable HTTP response is either JSON or a one-shot SSE stream carrying the
 * same envelope. Both are read here so the caller only ever sees the envelope.
 */
async function readEnvelope(res: Response): Promise<JsonRpcResponse | undefined> {
  const type = res.headers.get("content-type") ?? "";
  const body = await res.text();
  if (!body.trim()) return undefined;
  if (!type.includes("text/event-stream")) return JSON.parse(body) as JsonRpcResponse;
  // SSE: the payload is on the `data:` lines of the last event that carries one.
  let last: JsonRpcResponse | undefined;
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const chunk = line.slice(5).trim();
    if (!chunk || chunk === "[DONE]") continue;
    try {
      const parsed = JSON.parse(chunk) as JsonRpcResponse;
      if (parsed.result !== undefined || parsed.error !== undefined) last = parsed;
    } catch {
      // A comment or a partial frame; the envelope is on another line.
    }
  }
  return last;
}

/**
 * One MCP session against one server. `initialize` is sent on the first call and the
 * session id it hands back is echoed on the rest, which is what lets a server keep
 * per-connection state between `tools/list` and `tools/call`.
 */
export class McpClient {
  private sessionId = "";
  private initialized = false;
  private nextId = 1;

  constructor(
    private readonly url: string,
    private readonly extraHeaders: Record<string, string> = {},
    private readonly bearer = ""
  ) {}

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": MCP_PROTOCOL_VERSION,
      ...this.extraHeaders,
    };
    if (this.bearer) headers.authorization = `Bearer ${this.bearer}`;
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
    return headers;
  }

  private async send(method: string, params?: unknown, notification = false): Promise<unknown> {
    const body: Record<string, unknown> = { jsonrpc: "2.0", method };
    if (params !== undefined) body.params = params;
    if (!notification) body.id = this.nextId++;

    const res = await fetch(this.url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });

    if (res.status === 401) {
      const challenge = res.headers.get("www-authenticate") ?? "";
      throw new McpUnauthorized(challenge.match(/resource_metadata="([^"]+)"/)?.[1]);
    }
    const id = res.headers.get("mcp-session-id");
    if (id) this.sessionId = id;
    if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 300)}`);
    if (notification) return undefined;

    const envelope = await readEnvelope(res);
    if (envelope?.error) throw new Error(envelope.error.message);
    return envelope?.result;
  }

  private async ensureInitialized() {
    if (this.initialized) return;
    await this.send("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "salts-agent", version: "1.0" },
    });
    // Best effort: some servers close the stream before the notification lands, and
    // the session works regardless.
    await this.send("notifications/initialized", undefined, true).catch(() => {});
    this.initialized = true;
  }

  async listTools(): Promise<McpTool[]> {
    await this.ensureInitialized();
    const result = (await this.send("tools/list")) as { tools?: McpTool[] } | undefined;
    return (result?.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: t.inputSchema ?? { type: "object", properties: {} },
    }));
  }

  /** Calls a tool and flattens its content blocks to the text a model can read. */
  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    await this.ensureInitialized();
    const result = (await this.send("tools/call", { name, arguments: args })) as
      | {
          content?: { type: string; text?: string; data?: string; mimeType?: string }[];
          structuredContent?: unknown;
          isError?: boolean;
        }
      | undefined;

    const parts = (result?.content ?? [])
      .map((block) => {
        if (block.type === "text") return block.text ?? "";
        if (block.type === "image") return `[image: ${block.mimeType ?? "image"}]`;
        return `[${block.type}]`;
      })
      .filter(Boolean);

    const text =
      parts.length > 0
        ? parts.join("\n")
        : result?.structuredContent !== undefined
          ? JSON.stringify(result.structuredContent)
          : "The tool returned nothing.";
    if (result?.isError) throw new Error(text);
    return text.length > 24000 ? `${text.slice(0, 24000)}\n\n[truncated]` : text;
  }
}

/* ----------------------------------------------------------------- oauth -- */

type AuthServerMetadata = {
  issuer?: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
};

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function randomToken(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

async function getJson<T>(url: string): Promise<T | undefined> {
  try {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) return undefined;
    return (await res.json()) as T;
  } catch {
    return undefined;
  }
}

/**
 * Where a server's `.well-known` documents live. The spec puts the path of the
 * resource *after* the well-known segment, and older servers put it at the root, so
 * both are tried in that order.
 */
function wellKnown(base: URL, document: string): string[] {
  const path = base.pathname.replace(/\/$/, "");
  const urls = [`${base.origin}/.well-known/${document}`];
  if (path) urls.unshift(`${base.origin}/.well-known/${document}${path}`);
  return urls;
}

/**
 * Find the authorization server for an MCP endpoint, and read its metadata.
 *
 * The path is the one the spec lays out: the protected resource points at its
 * authorization servers, and each of those describes its own endpoints. When a server
 * publishes neither — plenty in the wild do not — the conventional endpoints under
 * its own origin are assumed, which is what the spec's fallback says to do.
 */
export async function discoverAuthServer(
  serverUrl: string
): Promise<{ metadata: AuthServerMetadata; resource: string }> {
  const base = new URL(serverUrl);
  const resourceMeta = await Promise.all(
    wellKnown(base, "oauth-protected-resource").map((u) =>
      getJson<{ authorization_servers?: string[]; resource?: string }>(u)
    )
  ).then((all) => all.find((m) => m?.authorization_servers?.length));

  const resource = resourceMeta?.resource ?? `${base.origin}${base.pathname.replace(/\/$/, "")}`;
  const issuer = new URL(resourceMeta?.authorization_servers?.[0] ?? base.origin);

  const candidates = [
    ...wellKnown(issuer, "oauth-authorization-server"),
    ...wellKnown(issuer, "openid-configuration"),
  ];
  for (const candidate of candidates) {
    const metadata = await getJson<AuthServerMetadata>(candidate);
    if (metadata?.authorization_endpoint && metadata.token_endpoint) {
      return { metadata, resource };
    }
  }
  return {
    metadata: {
      issuer: issuer.origin,
      authorization_endpoint: `${issuer.origin}/authorize`,
      token_endpoint: `${issuer.origin}/token`,
      registration_endpoint: `${issuer.origin}/register`,
    },
    resource,
  };
}

/**
 * Register this app with the authorization server on the fly. MCP providers hand out
 * no client ids in advance, so the client is created per server, per install, the
 * first time someone connects it.
 */
export async function registerClient(
  registrationUrl: string,
  redirectUri: string
): Promise<{ client_id: string; client_secret?: string }> {
  const res = await fetch(registrationUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_name: "Serverless Agent",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  if (!res.ok) throw new Error(`client registration failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as { client_id: string; client_secret?: string };
}

export type TokenSet = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
};

async function tokenRequest(tokenUrl: string, form: Record<string, string>): Promise<TokenSet> {
  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(form).toString(),
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    // 400 and 401 are the authorization server saying the grant itself is no good —
    // `invalid_grant` for a spent or revoked refresh token. Retrying cannot fix it;
    // only the user approving the app again can.
    throw new McpTokenError(
      `token request failed: ${res.status} ${body}`,
      res.status,
      res.status === 400 || res.status === 401
    );
  }
  const json = (await res.json()) as TokenSet;
  if (!json.access_token) {
    throw new McpTokenError("the authorization server returned no access token", res.status, true);
  }
  return json;
}

export function exchangeCode(
  tokenUrl: string,
  params: {
    code: string;
    clientId: string;
    clientSecret?: string;
    redirectUri: string;
    verifier: string;
    resource?: string;
  }
): Promise<TokenSet> {
  const form: Record<string, string> = {
    grant_type: "authorization_code",
    code: params.code,
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    code_verifier: params.verifier,
  };
  if (params.clientSecret) form.client_secret = params.clientSecret;
  if (params.resource) form.resource = params.resource;
  return tokenRequest(tokenUrl, form);
}

export function refreshToken(
  tokenUrl: string,
  params: { refreshToken: string; clientId: string; clientSecret?: string; resource?: string }
): Promise<TokenSet> {
  const form: Record<string, string> = {
    grant_type: "refresh_token",
    refresh_token: params.refreshToken,
    client_id: params.clientId,
  };
  if (params.clientSecret) form.client_secret = params.clientSecret;
  if (params.resource) form.resource = params.resource;
  return tokenRequest(tokenUrl, form);
}

/* ------------------------------------------------------------ tool names -- */

/**
 * What a server's tools are called once they reach the model. Two servers may both
 * offer `search`, so the server's own name goes in front — and the result is kept to
 * the characters OpenRouter accepts in a function name.
 */
export function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 24) || "mcp"
  );
}

export const qualifiedName = (server: McpServerRow, tool: string) =>
  `mcp_${slug(server.name)}_${tool}`.slice(0, 64);

/** The disabled-tool names on a row. A malformed value disables nothing. */
export function parseNames(json: string): string[] {
  if (!json.trim()) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((n): n is string => typeof n === "string") : [];
  } catch {
    return [];
  }
}

export function parseTools(json: string): McpTool[] {
  if (!json.trim()) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as McpTool[]) : [];
  } catch {
    return [];
  }
}
