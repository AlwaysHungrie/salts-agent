/**
 * External MCP servers over Streamable HTTP (no stdio in a Worker), authenticated by
 * headers or the full MCP OAuth flow. The JSON-RPC client is hand-rolled to stay small.
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
   * Tools the agent may not call, as a JSON array. Stored as exclusions so a tool the
   * provider adds later arrives switched on.
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
 * A refused token request. `permanent` marks refusals that will not recover on their
 * own (spent or revoked refresh token), as opposed to a brief outage.
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

/** One MCP session with a server: `initialize` on first call, then its session id is echoed. */
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

  /**
   * Calls a tool. Its text blocks become the text a model reads; images and embedded
   * files come back as base64 for the caller to store and show the user, never inlined
   * into that text.
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    await this.ensureInitialized();
    const result = (await this.send("tools/call", { name, arguments: args })) as
      | {
          content?: McpContentBlock[];
          structuredContent?: unknown;
          isError?: boolean;
        }
      | undefined;

    const images: McpToolResult["images"] = [];
    const files: McpToolResult["files"] = [];
    const parts = (result?.content ?? [])
      .map((block) => {
        if (block.type === "text") return block.text ?? "";
        if (block.type === "image") {
          if (typeof block.data === "string" && block.data) {
            images.push({ data: block.data, mime: block.mimeType ?? "image/png" });
            return "";
          }
          return `[image: ${block.mimeType ?? "image"}]`;
        }
        const resource = block.type === "resource" ? block.resource : undefined;
        if (resource && typeof resource.blob === "string" && resource.blob) {
          files.push({
            data: resource.blob,
            mime: resource.mimeType ?? "application/octet-stream",
            name: fileNameOf(resource.uri),
          });
          return "";
        }
        if (resource && typeof resource.text === "string") return resource.text;
        return `[${block.type}]`;
      })
      .filter(Boolean);

    const text =
      parts.length > 0
        ? parts.join("\n")
        : images.length > 0 || files.length > 0
          ? ""
          : result?.structuredContent !== undefined
            ? JSON.stringify(result.structuredContent)
            : "The tool returned nothing.";
    if (result?.isError) throw new Error(text || "The tool failed.");
    return {
      text: text.length > 24000 ? `${text.slice(0, 24000)}\n\n[truncated]` : text,
      images,
      files,
    };
  }

  /**
   * Upload a file's bytes out of band. The model cannot copy bytes into a tool call, so it
   * passes the returned id instead.
   */
  async upload(bytes: ArrayBuffer, mime: string): Promise<string> {
    const headers: Record<string, string> = { ...this.extraHeaders, "content-type": mime };
    if (this.bearer) headers.authorization = `Bearer ${this.bearer}`;
    const res = await fetch(uploadsUrl(this.url), {
      method: "POST",
      headers,
      body: bytes,
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
    // A plain error, not McpUnauthorized: a refusal here is no reason to refresh, or
    // drop, the token the server's tools work with.
    if (!res.ok) throw new Error(`upload ${res.status} ${(await res.text()).slice(0, 300)}`);
    const { upload_id } = (await res.json().catch(() => ({}))) as { upload_id?: unknown };
    // The id is put in front of the model, so a server gets no say in what else is.
    if (typeof upload_id !== "string" || !UPLOAD_ID.test(upload_id))
      throw new Error("upload returned no usable upload_id");
    return upload_id;
  }
}

type McpContentBlock = {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  resource?: { uri?: string; mimeType?: string; blob?: string; text?: string };
};

/** A tool's answer: text for the model, and the images and files it made for the user. */
export type McpToolResult = {
  text: string;
  images: { data: string; mime: string }[];
  files: { data: string; mime: string; name: string }[];
};

/** The last path segment of a resource URI, as a plain file name. */
export function fileNameOf(uri: string | undefined): string {
  const last = (uri ?? "").split(/[/\\]/).pop() ?? "";
  let name = last;
  try {
    name = decodeURIComponent(last);
  } catch {
    // A malformed escape: keep it as written.
  }
  // Control characters would break a Markdown link or a download header.
  const printable = [...name].filter((ch) => ch.charCodeAt(0) >= 0x20).join("");
  return printable.trim() || "file";
}

const UPLOAD_TIMEOUT_MS = 30_000;
const UPLOAD_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** Where a server takes uploads: its URL without the `/mcp`, plus `/uploads`. */
export function uploadsUrl(url: string): string {
  const u = new URL(url);
  u.pathname = `${u.pathname.replace(/\/mcp\/?$/, "").replace(/\/$/, "")}/uploads`;
  return u.toString();
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
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

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

/** `.well-known` URLs to try: the spec's (resource path after the segment), then the root. */
function wellKnown(base: URL, document: string): string[] {
  const path = base.pathname.replace(/\/$/, "");
  const urls = [`${base.origin}/.well-known/${document}`];
  if (path) urls.unshift(`${base.origin}/.well-known/${document}${path}`);
  return urls;
}

/**
 * Find an MCP endpoint's authorization server and its metadata, falling back to the
 * conventional endpoints on its own origin as the spec allows.
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

/** Dynamic client registration: MCP providers issue no client ids in advance. */
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
  if (!res.ok)
    throw new Error(
      `client registration failed: ${res.status} ${(await res.text()).slice(0, 300)}`
    );
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
    // 400/401 means the grant itself is bad (`invalid_grant`); only reconnecting fixes it.
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
 * A server's tool name as the model sees it: prefixed with the server name (two servers
 * may both offer `search`) and limited to characters OpenRouter accepts.
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
