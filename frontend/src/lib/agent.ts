/** Server-side access to the Cloudflare Worker that hosts the agent. */
export const AGENT_URL =
  (process.env.USE_LOCAL_AGENT === "true" ? process.env.LOCALHOST_AGENT_URL : process.env.AGENT_URL) ??
  "http://localhost:8787";

/**
 * An agent: its own bot, its own settings, its own MCP servers, its own sessions.
 * Agents share nothing — each one is a separate Durable Object in the Worker.
 */
export type AgentRow = {
  id: string;
  name: string;
  created_at: number;
  updated_at: number;
  /**
   * Who may open this agent: one email address per line, lowercased. Everyone on it
   * gets the whole agent — its chats, its settings, its keys — so it is a list of
   * owners rather than of guests.
   */
  allowed_emails: string;
  /**
   * The address that created the agent, lowercased. It administers the agent — admin
   * settings, and deleting it — and it never changes.
   *
   * Being the admin is not access: unless this address is also on `allowed_emails`,
   * the admin cannot open the agent's pages at all.
   */
  admin_email: string;
  /*
   * Blank unless the address reading it is the administrator: whoever provides a
   * fleet agent is never named to the people it was provided to. `admin_email ===
   * email` still answers "am I the admin", which is all this field is used for.
   */
  /**
   * The fleet this agent was created into, or "" when it stands alone. Agents made
   * by one fleet create call share this id, which is what groups them on the home
   * page.
   */
  fleet_id?: string;
  /** What that fleet is called. "" for an agent that is not in one. */
  fleet_name?: string;
};

/**
 * A fleet as the home page lists it: the name it was created under, and how many
 * agents are inside. The agents themselves are fetched only when it is opened —
 * a fleet can hold thousands.
 */
export type FleetRow = {
  fleet_id: string;
  fleet_name: string;
  agents: number;
  created_at: number;
};

/** One page of agents, with the cursor that asks for the page after it. */
export type AgentPage = {
  agents: AgentRow[];
  has_more: boolean;
  /** Opaque, handed back untouched. Empty once the list is exhausted. */
  cursor: string;
};

/**
 * A session id is `<agentId>~<local>`, so a session says which agent owns it. That is
 * what lets every session-scoped route stay agent-free: the id is enough.
 */
export const AGENT_SEPARATOR = "~";

/** The agent a session belongs to. Empty when the id is not one of ours. */
export function agentIdOf(sessionId: string): string {
  const cut = sessionId.indexOf(AGENT_SEPARATOR);
  return cut === -1 ? "" : sessionId.slice(0, cut);
}

export type SessionRow = {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
  object_id: string;
  /** "web", "telegram" for a chat the bot is in, or "whatsapp". */
  source?: string;
  /** The Telegram chat id, or `wa:<number>` for a WhatsApp conversation. */
  chat_id?: string;
  /** private, group, supergroup or channel. */
  chat_type?: string;
  /**
   * A public Telegram chat's @handle, without the @. On a WhatsApp session it holds
   * the business number the conversation runs through, since WhatsApp has no handles.
   */
  chat_username?: string;
  /** The forum topic inside that chat, when the session is one topic of a group. */
  chat_thread_id?: string;
};

/**
 * One page of the session list. `cursor` is opaque — it is handed back untouched to
 * ask for the page after this one, and is empty once the list is exhausted.
 */
export type SessionPage = {
  sessions: SessionRow[];
  has_more: boolean;
  cursor: string;
};

/**
 * Where "Continue in Telegram" points. Telegram has a link for every chat, but a
 * different one per kind:
 *
 * - A public group or channel is reachable by its @handle.
 * - A private supergroup is reachable at `t.me/c/<id>/1`, where the id is the chat id
 *   with Telegram's `-100` prefix stripped. It only opens for people already in it,
 *   which is exactly right: it is a link back to a conversation, not an invite.
 * - A forum topic hangs off its group's link, as `<group>/<topic id>`.
 * - A DM with the bot is the bot's own handle.
 */
export function telegramLink(session: SessionRow, botUsername: string): string {
  const topic = session.chat_thread_id ?? "";
  if (session.chat_username) {
    const group = `https://t.me/${session.chat_username}`;
    return topic ? `${group}/${topic}` : group;
  }
  const id = session.chat_id ?? "";
  // The trailing segment is the topic in a forum, and the first message otherwise.
  if (id.startsWith("-100")) return `https://t.me/c/${id.slice(4)}/${topic || "1"}`;
  // A basic group (not a supergroup) has no link of its own; the bot is the way in.
  return botUsername ? `https://t.me/${botUsername}` : "https://t.me";
}

export type StoredMessage = {
  /** The session-tree message id: a UUID, not a row number. */
  id: string;
  role: "user" | "assistant";
  content: string;
  ts: number;
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd: number;
  ms: number;
  /** Files and images sent with this message, resolved by the Worker. */
  attachments: Attachment[];
  /** JSON array of `TurnStep`: how an assistant turn unfolded. `[]` when unused. */
  steps?: string;
};

/**
 * One window of a transcript, newest-last. `offset` is how many messages precede it:
 * a fork counts from the start of the conversation, so the number it needs is not
 * the index within what is drawn.
 */
export type TranscriptPage = {
  messages: StoredMessage[];
  has_more: boolean;
  offset: number;
  total: number;
};

/**
 * One segment of an assistant turn, in the order it happened — mirrors the Worker's
 * own type, so a reopened session redraws the tool lines the live stream showed.
 */
export type TurnStep =
  | { kind: "text"; text: string }
  | { kind: "tools"; tools: { name: string; ok: boolean }[] };

/**
 * Per-message usage, streamed to the client as a `data-usage` part.
 * Token counts and cost come from OpenRouter, so they are exact and immediate.
 * There is deliberately no Cloudflare figure here: its analytics lag minutes, so a
 * per-message Cloudflare cost could only ever be a guess.
 */
export type UsageData = {
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd: number;
  llm_ms: number;
};

/** What the session knows about itself: transcript size and exact LLM spend. */
export type ModelOption = { id: string; label: string; vision: boolean };

export type ReasoningEffort = "off" | "low" | "medium" | "high";

/**
 * One agent's settings, held in that agent's registry Durable Object `config` table:
 * tuning (settings page) plus capability switches and their credentials
 * (capabilities page). Nothing here is shared between agents.
 * The 0/1 fields are booleans; SQLite has no boolean type.
 *
 * Secrets read back as `SECRET_MASK`, never as the key itself. Sending the mask back
 * in a PATCH means "leave that key as it is".
 */
export type Config = {
  model: string;
  /** Mirrored from the agent row; set by renaming the agent, not from this page. */
  agent_name: string;
  system_prompt: string;
  temperature: number;
  max_tokens: number;
  reasoning_effort: ReasoningEffort;
  context_messages: number;

  cap_web_search: number;
  cap_url_fetch: number;
  cap_file_ingest: number;
  cap_vision: number;
  cap_image_generation: number;
  cap_audio_input: number;
  cap_voice_output: number;
  cap_scheduled_tasks: number;
  cap_memory: number;
  cap_telegram: number;
  cap_whatsapp: number;
  cap_mcp: number;

  /**
   * The agent's own OpenRouter key. Every model call it makes is billed here, so one
   * agent's spend and rate limits are its own. Blank falls back to the Worker's key.
   */
  openrouter_api_key: string;
  brave_api_key: string;
  searxng_url: string;
  searxng_token: string;
  telegram_bot_token: string;
  telegram_bot_username: string;
  telegram_user_whitelist: string;
  telegram_group_whitelist: string;
  whatsapp_phone_number_id: string;
  whatsapp_access_token: string;
  whatsapp_app_secret: string;
  whatsapp_verify_token: string;
  /** The one number the agent answers on WhatsApp. Not a list: one agent, one person. */
  whatsapp_number: string;
  image_model: string;
  transcription_model: string;
};

export const SECRET_MASK = "••••••••";

/** Capability metadata, defined once in the Worker and shipped to the browser. */
export type CapabilityField = {
  key: keyof Config;
  label?: string;
  hint?: string;
  secret: boolean;
  /** The field holds a list, one entry per line, edited as chips. */
  list?: boolean;
  required: boolean;
  placeholder?: string;
  /** When present the field is a fixed choice, not free text. */
  options?: { value: string; label: string }[];
};

export type Capability = {
  id: string;
  /** The capability is always on and has no switch of its own. */
  alwaysOn?: boolean;
  flag: keyof Config;
  label: string;
  summary: string;
  note: string;
  /** A page explaining how to get this capability's credentials, opened in a new tab. */
  guide?: { label: string; href: string };
  tools: string[];
  fields: CapabilityField[];
};

/** A capability is only usable once it is on *and* its required fields are filled. */
export function capabilityReady(
  capability: Capability,
  config: Config,
): boolean {
  // A capability with no switch is on regardless of what the stored flag says.
  if (!capability.alwaysOn && !config[capability.flag]) return false;
  return capability.fields.every(
    (f) => !f.required || String(config[f.key] ?? "").trim() !== "",
  );
}

/**
 * Where "Continue on WhatsApp" points. Unlike Telegram there is one shape only: a
 * `wa.me` link to the business number, which opens the existing conversation on
 * whichever device WhatsApp is signed in on. Empty when the session predates the
 * number being recorded, in which case no link is offered rather than a broken one.
 */
export function whatsappLink(session: SessionRow): string {
  const number = (session.chat_username ?? "").replace(/\D/g, "");
  return number ? `https://wa.me/${number}` : "";
}

/* --------------------------------------------------------- mcp servers -- */

/** How an external MCP server authenticates this agent. */
export type McpAuth = "none" | "headers" | "oauth";

/**
 * One provider the capabilities page may offer, described by whoever provisioned this
 * agent rather than compiled into this app.
 *
 * What a tile needs to become a server: a name, a url and how it authenticates. The
 * logo is `icon`, an SVG data URL drawn with `<img>` so no script inside it runs;
 * without one the mark is `letter` on `color`.
 */
export type McpCatalogEntry = {
  id: string;
  name: string;
  url: string;
  auth: McpAuth;
  icon?: string;
  letter?: string;
  color?: string;
};

/** One tool an MCP server advertises. */
export type McpTool = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

/**
 * An external MCP server as the Worker hands it back. Access and refresh tokens are
 * never included. Header values are, to a caller that may edit the server; anyone
 * else gets each value as the mask.
 */
export type McpServer = {
  id: string;
  name: string;
  url: string;
  auth: McpAuth;
  enabled: number;
  headers: Record<string, string>;
  tools: McpTool[];
  /**
   * Names from `tools` the agent may not call. Held as the exclusions, so a tool the
   * provider adds later arrives switched on.
   */
  disabled_tools: string[];
  /** False only for an OAuth server nobody has approved yet. */
  connected: boolean;
  tools_synced_at: number;
  /** Why the last tool sync failed. Empty when it worked. */
  last_error: string;
  oauth_scope: string;
  created_at: number;
};

/* -------------------------------------------------------- meta settings -- */

/**
 * An agent's settings *about* its settings: what its settings and capabilities
 * should default to, which models it may be switched between at all, and which MCP
 * templates and servers belong to it.
 *
 * Edited only from the home page dialog. Nothing here changes what the agent does on
 * its own — applying it writes these values into `Config`, and `Config` is still what
 * every turn reads.
 */
export type MetaSettings = {
  /**
   * The models the settings page may offer, typed in rather than picked: OpenRouter's
   * catalogue is far bigger than the handful a deployment names. Empty means the
   * deployment's own list.
   */
  models: ModelChoice[];
  /** Default tuning values. An absent key keeps the factory default. */
  defaults: Partial<Pick<Config, MetaTunableKey>>;
  /**
   * Settings the agent's own pages may not show or change: config columns and
   * capability ids. A locked setting is configured here and nowhere else.
   */
  locked: string[];
  /** Per capability id: whether it starts on, and what its fields start out holding. */
  capabilities: Record<string, MetaCapability>;
  /**
   * Open lists of what a fixed-choice field may be set to, by config column — the
   * image model, the transcription model. Empty leaves the shipped choices alone.
   */
  field_options: Record<string, string[]>;
  mcp: {
    /** Preset ids offered on the capabilities page. Empty means every preset. */
    templates: string[];
    /**
     * Templates provisioned from outside this deployment, shown in place of the
     * built-in presets. Empty leaves those alone. See `McpCatalogEntry`.
     */
    catalog: McpCatalogEntry[];
    /** Servers added to the agent when defaults are applied, matched by name. */
    servers: MetaMcpServer[];
    /**
     * Whether the agent's own pages may add servers of their own — and rename,
     * repoint or remove the ones it has. Off leaves the list to the meta dialog; the
     * owner can still switch a server off, pick its tools and approve its OAuth.
     */
    user_servers: boolean;
  };
  /**
   * What the agent may spend on model calls in a calendar month, in US dollars.
   * 0 is no ceiling. Once a month is over it, the agent says so instead of
   * answering, until the month turns or the limit is raised.
   */
  monthly_spend_limit: number;
  /**
   * How many addresses the agent's own access list may grow to. 0 is no ceiling.
   * The agent's user adds members from its settings page; this is the
   * administrator's say in how far that goes.
   */
  member_limit: number;
};

/**
 * One model an agent may be switched to: an OpenRouter id, and whether it sees
 * images. There is no label — a model in the deployment's catalogue is shown under
 * the name that gives it, and one that is not is shown as the id it is.
 */
export type ModelChoice = { id: string; vision: boolean; label?: string };

export type MetaTunableKey =
  | "model"
  | "system_prompt"
  | "temperature"
  | "max_tokens"
  | "reasoning_effort"
  | "context_messages"
  | "openrouter_api_key";

export type MetaCapability = {
  enabled?: boolean;
  /** Default field values, by config column. Secrets are never defaults. */
  fields?: Record<string, string>;
};

export type MetaMcpServer = {
  name: string;
  url: string;
  auth: McpAuth;
  /** Default headers, by name. */
  headers: Record<string, string>;
};

export const EMPTY_META: MetaSettings = {
  models: [],
  defaults: {},
  locked: [],
  capabilities: {},
  field_options: {},
  mcp: { templates: [], catalog: [], servers: [], user_servers: true },
  monthly_spend_limit: 0,
  member_limit: 0,
};

/** What an agent has spent this calendar month, against the ceiling it was given. */
/**
 * The deployment's ceilings the composer has to know before it sends anything, as the
 * `/config` route hands them over.
 *
 * There is no copy of them here: the browser's number and the Worker's have to be the
 * same number, and the browser's is the one the user meets first.
 */
export type ClientLimits = {
  max_files_per_message: number;
  max_upload_bytes: { text: number; pdf: number; image: number; audio: number; sheet: number };
};

/**
 * Bytes a re-encoded image is aimed at: the deployment's image ceiling less a margin
 * for the multipart envelope. An image over this is shrunk in the browser, not refused.
 */
export function imageTarget(limits: ClientLimits): number {
  return Math.max(1, Math.floor(limits.max_upload_bytes.image * 0.95));
}

/**
 * How long one take may run, from the audio ceiling.
 *
 * 16 kHz mono PCM is 32 kB a second, so the clip's length is the ceiling divided by
 * that. Capped at ten minutes whatever the ceiling allows: past that a take stops
 * being a voice note, and a transcript cut across two requests loses the sentence that
 * straddles them.
 */
export function recordingSeconds(limits: ClientLimits): number {
  return Math.max(5, Math.min(600, Math.floor(limits.max_upload_bytes.audio / 32_000)));
}

export type SpendState = { usd: number; limit: number; month: string };

/** A file the user attached, or an image the agent drew, minus the bytes. */
export type Attachment = {
  id: string;
  kind: "text" | "image" | "pdf" | "sheet";
  name: string;
  mime: string;
  bytes: number;
  chars: number;
  /** First stretch of a text file, or of a voice note's transcript. */
  preview?: string;
  /** Whether a render of a PDF's first page exists to draw on its card. */
  thumb?: boolean;
};

export type ScheduledTask = { id: string; prompt: string; when: string };

export type Summary = {
  session: string;
  messages: number;
  llm: {
    model: string;
    prompt_tokens: number;
    completion_tokens: number;
    cost_usd: number;
  };
  tasks: ScheduledTask[];
  sqlite_bytes: number;
};

/**
 * The two failures that kill the session's instance rather than the turn. They are
 * named here because the chat has to recognise them: retrying one straight away only
 * asks the object to do the thing that just killed it, so the notice they produce is
 * shown without a Retry button.
 */
export const SESSION_OUT_OF_MEMORY =
  "This session ran out of memory and was reset. Send a new message or start a new conversation.";

export const SESSION_CRASHED =
  "The session crashed while answering. Send a new message or start a new conversation.";

/**
 * A deploy tears down every running instance, so anything in flight at that moment
 * fails with wording about the object's code being updated. It is worth its own
 * sentence — it is nobody's fault, it fixes itself, and it is not a crash.
 */
export const SESSION_UPDATED = "Session restarted before your message was processed.";

export function isSessionCrash(text: string): boolean {
  return text === SESSION_OUT_OF_MEMORY || text === SESSION_CRASHED;
}

/**
 * The one sentence worth showing for a failure that came from the platform rather
 * than from the request. Null when the text is not one of those, and the caller
 * should say something of its own instead.
 *
 * Everything here is matched on wording because that is all the runtime gives us: the
 * failures arrive as prose inside an error message, not as codes.
 */
export function describeSessionFailure(raw: string): string | null {
  if (/code was updated|reset because its code/i.test(raw)) return SESSION_UPDATED;
  if (/exceeded its memory limit|Exceeded Memory/i.test(raw)) return SESSION_OUT_OF_MEMORY;
  if (/isolate|Durable Object.*(reset|reload)/i.test(raw)) return SESSION_CRASHED;
  return null;
}

export function agentUrl(sessionId: string, path: string) {
  return `${AGENT_URL}/agents/session-agent/${encodeURIComponent(sessionId)}/${path}`;
}
