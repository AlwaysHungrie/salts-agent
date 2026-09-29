import { DurableObject } from "cloudflare:workers";
import { McpTokenError, refreshToken, type McpAuth, type McpServerRow } from "./mcp";
import { addColumnIfMissing, applyMigrations, type Migration } from "./schema";
import {
  completeSettings,
  missingSettings,
  parseStoredSettings,
  validateSettingsPatch,
  SettingsError,
  SETTABLE_CONFIG_KEYS,
  type DeploymentSettings,
  type SettableConfigKey,
  type StoredSettings,
} from "./settings";

/**
 * One agent's settings, split in two:
 *
 * - Tuning (model, prompt, temperature…): how the agent talks.
 * - Capabilities (`cap_*` plus the credentials they need): what the agent can *do* —
 *   search, read files, see images, draw, hear, schedule work, remember.
 *
 * Every agent has its own `SessionRegistry`, so this row — bot token, MCP servers,
 * OpenRouter key and all — belongs to that agent alone. Nothing here is shared.
 *
 * One typed column per setting, in a single-row table: settings keep growing, and
 * columns keep them queryable and migratable instead of turning into one opaque blob.
 * Integers stand in for booleans because SQLite has no boolean type.
 *
 * API keys are stored here in plain text. That is deliberate for now — see README.
 */
export type Config = {
  model: string;
  /**
   * The agent's name, mirrored from the directory row so the model can be told what
   * it is called without the session object having to look the agent up.
   */
  agent_name: string;
  /** Appended to the built-in system prompt. Empty means "no custom instructions". */
  system_prompt: string;
  /**
   * The owner's notes. `private_notes` is a brief only the model reads; `public_notes`
   * is what guests are shown before they start, and the model is told it too. Longer
   * than `system_prompt` on purpose: a brief with its evidence runs to pages.
   */
  private_notes: string;
  public_notes: string;
  temperature: number;
  /** Cap on a single reply. 0 means "no cap: let the model stop on its own". */
  max_tokens: number;
  /** OpenRouter reasoning effort. "off" sends no reasoning field at all. */
  reasoning_effort: "off" | "low" | "medium" | "high";
  /** How many past messages to resend. 0 means "the whole transcript". */
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
   * The agent's own OpenRouter key. Every model call this agent makes is billed to
   * it, so one agent's spend and rate limits are its own. There is no fallback: blank
   * means the agent cannot answer, which is the only way a deployment's own credit
   * stays out of reach of every agent anyone creates on it.
   */
  openrouter_api_key: string;
  /** Brave Search API key. The default web search provider when set. */
  brave_api_key: string;
  /** Base URL of a self-hosted SearXNG instance. Only used when `brave_api_key` is empty. */
  searxng_url: string;
  /** Bearer token for a guarded SearXNG instance. Blank when the instance is open. */
  searxng_token: string;
  /** OpenRouter model used for `generate_image`; billed on the existing OpenRouter key. */
  image_model: string;
  /** OpenRouter model used to transcribe audio uploads; same key, same bill. */
  transcription_model: string;
  /** OpenRouter model that speaks a `send_voice_note` note; same key, same bill. */
  voice_model: string;
  /** Bot token from @BotFather. The bot is the agent's face on Telegram. */
  telegram_bot_token: string;
  /** The bot's @handle, without the @: a chat needs it to link back to the bot. */
  telegram_bot_username: string;
  /**
   * Who may talk to the bot in a DM: newline-separated usernames, or `/regex/`
   * entries. Empty means anyone.
   */
  telegram_user_whitelist: string;
  /**
   * Which groups the bot answers in: newline-separated chat ids, `chatId:topicId`
   * for one forum topic, or `/regex/` entries. Empty means any group.
   */
  telegram_group_whitelist: string;
  /** The test or business number's id from Meta's API Setup panel, not the number. */
  whatsapp_phone_number_id: string;
  /**
   * The WhatsApp Business Account the number belongs to. Not used to send: it is the
   * account whose webhooks this agent's Meta app has to be subscribed to, which the
   * Worker does itself whenever the settings are saved.
   */
  whatsapp_waba_id: string;
  /** System-user token with `whatsapp_business_messaging`. Sends every reply. */
  whatsapp_access_token: string;
  /** The Meta app's secret. Every inbound delivery's signature is checked against it. */
  whatsapp_app_secret: string;
  /** Chosen by the owner, pasted into Meta's callback settings. Must match exactly. */
  whatsapp_verify_token: string;
  /**
   * The one number this agent answers, in international form.
   *
   * Not a whitelist. An agent on WhatsApp serves one person, and a required single
   * value says that in a way a list cannot: there is no empty state that quietly means
   * "everyone", and no second entry to add by accident.
   */
  whatsapp_number: string;
};

/**
 * The per-agent columns every agent starts blank on: its name, its own instructions,
 * its keys and its channel wiring. Everything else a new agent holds — the model and
 * every column in `SETTABLE_CONFIG_KEYS` — is the deployment's `default_model` and
 * `config_defaults`, not a value this code picks.
 */
export const DEFAULT_CONFIG: Omit<Config, "model" | SettableConfigKey> = {
  agent_name: "",
  system_prompt: "",
  private_notes: "",
  public_notes: "",
  openrouter_api_key: "",
  brave_api_key: "",
  searxng_url: "",
  searxng_token: "",
  telegram_bot_token: "",
  telegram_bot_username: "",
  telegram_user_whitelist: "",
  telegram_group_whitelist: "",
  whatsapp_phone_number_id: "",
  whatsapp_waba_id: "",
  whatsapp_access_token: "",
  whatsapp_app_secret: "",
  whatsapp_verify_token: "",
  whatsapp_number: "",
};

/**
 * Meta settings: an agent's settings *about* its settings.
 *
 * Where `Config` is what the agent is set to right now, this is what it should be
 * set to by default — which model choices it is offered at all, which capabilities
 * arrive switched on, what their fields start out holding, and which MCP templates
 * and servers belong to it. Applying it writes those defaults into `Config`; nothing
 * here is read on a turn, so a turn's behaviour still comes from `Config` alone.
 *
 * One JSON blob rather than columns: it is nested (per capability, per server) and
 * nothing queries it, so columns would buy nothing and cost a migration per field.
 */
export type MetaSettings = {
  /**
   * The models the settings page may offer, typed in rather than picked: OpenRouter's
   * catalogue is far larger than the handful a deployment names in its `models` setting, and an
   * agent that wants one of the others should not need a release. Empty means the
   * deployment's own list.
   *
   * Each carries its own `vision`, because an id typed in is one nothing else knows
   * anything about — whether it can be sent an image is a thing only the person
   * adding it can say.
   */
  models: ModelChoice[];
  /** Default tuning values. A key that is absent keeps the factory default. */
  defaults: Partial<Pick<Config, MetaTunableKey>>;
  /**
   * Settings the agent's own pages may not touch: capability ids and config columns.
   * A locked setting is not shown under the agent at all — it is decided here and
   * nowhere else, which is what makes this more than a set of starting values.
   */
  locked: string[];
  /** Per capability: whether it starts on, and what its fields start out holding. */
  capabilities: Record<string, MetaCapability>;
  /**
   * Open lists of what a fixed-choice field may be set to, by config column — the
   * image model and the transcription model. Same reasoning as `models`: the built-in
   * choices are a starting point, not the limit. An absent or empty list leaves the
   * field offering what the Worker ships.
   */
  field_options: Record<string, string[]>;
  mcp: {
    /** Template ids offered on the capabilities page, out of the catalogue. Empty means every one. */
    templates: string[];
    /**
     * Templates supplied by whoever provisioned this agent, shown on the capabilities
     * page in place of the deployment's `mcp_catalog`.
     *
     * A definition carries what a tile actually needs (a name, a url, how it
     * authenticates), which is what lets a catalogue live outside this repo. Empty
     * leaves the deployment's catalogue in force.
     */
    catalog: McpCatalogEntry[];
    /** Servers added to the agent when the defaults are applied, matched by name. */
    servers: MetaMcpServer[];
    /**
     * Whether the agent's own pages may add servers of their own — and rename, repoint
     * or remove the ones it has.
     *
     * On is the open arrangement: the servers above are a starting point and the agent
     * builds out the rest. Off makes the list this dialog's alone, which is what an
     * agent handed to somebody else wants — they can switch a server off, pick which
     * of its tools it may call and approve its OAuth, because that is using what they
     * were given, but the list itself is not theirs to change.
     */
    user_servers: boolean;
  };
  /**
   * What this agent may spend on model calls in a calendar month, in US dollars.
   * `0` is no ceiling at all, which is what every agent had before this existed.
   *
   * Counted against what the agent's own turns cost — the numbers OpenRouter hands
   * back per turn, summed into `spend` by month. A month that has already gone over
   * refuses new turns rather than truncating one mid-answer: a half-written reply
   * costs the same as a whole one and is worth less.
   */
  monthly_spend_limit: number;
  /**
   * How many addresses this agent's own access list may grow to. `0` is no ceiling
   * beyond the deployment's `max_members`.
   *
   * A fleet agent is created with one member and its user may add more — that is
   * deliberate, they own the agent. This is the administrator's say in how far that
   * goes, for an agent they are paying for.
   */
  member_limit: number;
};

/**
 * One provider on the capabilities page's strip — from the deployment's `mcp_catalog`,
 * or from whoever provisioned the agent.
 *
 * The logo is an optional SVG `icon`; without one, a mark is drawn from `letter` and
 * `color`, which needs no asset at all.
 */
export type McpCatalogEntry = {
  id: string;
  name: string;
  url: string;
  auth: McpAuth;
  /**
   * The provider's logo, as an SVG data URL. Drawn with `<img>`, so no script inside it
   * runs. Without one the tile is a letter mark instead.
   */
  icon?: string;
  /** Placeholder mark: this letter on this colour. Both optional — the name's first letter does. */
  letter?: string;
  color?: string;
};

/**
 * One model an agent may be switched to: an OpenRouter id, and whether it sees images.
 * No label — a model that is in the deployment's catalogue is shown under the name
 * that gives it, and one that is not is shown as the id it is.
 */
export type ModelChoice = { id: string; vision: boolean };

/** The tuning settings a default may be given for. */
export type MetaTunableKey =
  | "model"
  | "system_prompt"
  | "temperature"
  | "max_tokens"
  | "reasoning_effort"
  | "context_messages"
  | "openrouter_api_key";

export type MetaCapability = {
  /** Whether the capability is switched on when the defaults are applied. */
  enabled?: boolean;
  /** Default values for that capability's fields, by config column. */
  fields?: Record<string, string>;
};

/**
 * One MCP server the agent should have. OAuth still has to be approved per server —
 * this only gets the row in place, with the headers it needs, so connecting is a
 * click rather than a re-entry of the URL.
 */
export type MetaMcpServer = {
  name: string;
  url: string;
  auth: "none" | "headers" | "oauth";
  /** Default headers, by name. Sent as-is to a `headers` server. */
  headers: Record<string, string>;
};

export const DEFAULT_META: MetaSettings = {
  models: [],
  defaults: {},
  locked: [],
  capabilities: {},
  field_options: {},
  mcp: { templates: [], catalog: [], servers: [], user_servers: true },
  monthly_spend_limit: 0,
  member_limit: 0,
};

/** The config columns, in the order they are written, excluding the primary key. */
const CONFIG_COLUMNS = [
  "model",
  ...SETTABLE_CONFIG_KEYS,
  ...Object.keys(DEFAULT_CONFIG),
] as (keyof Config)[];

/** `ALTER TABLE` fragments for every column added after `config` first shipped. */
const CONFIG_MIGRATIONS = [
  `system_prompt TEXT NOT NULL DEFAULT ''`,
  `agent_name TEXT NOT NULL DEFAULT ''`,
  `temperature REAL NOT NULL DEFAULT 0.7`,
  `max_tokens INTEGER NOT NULL DEFAULT 0`,
  `reasoning_effort TEXT NOT NULL DEFAULT 'off'`,
  `context_messages INTEGER NOT NULL DEFAULT 0`,
  `cap_web_search INTEGER NOT NULL DEFAULT 0`,
  `cap_url_fetch INTEGER NOT NULL DEFAULT 0`,
  `cap_file_ingest INTEGER NOT NULL DEFAULT 0`,
  `cap_vision INTEGER NOT NULL DEFAULT 0`,
  `cap_image_generation INTEGER NOT NULL DEFAULT 0`,
  `cap_audio_input INTEGER NOT NULL DEFAULT 0`,
  `cap_scheduled_tasks INTEGER NOT NULL DEFAULT 0`,
  `cap_memory INTEGER NOT NULL DEFAULT 0`,
  `cap_telegram INTEGER NOT NULL DEFAULT 0`,
  `brave_api_key TEXT NOT NULL DEFAULT ''`,
  // Backfill for rows that predate the column, frozen at what the column shipped with.
  // A row written since always carries the deployment's `config_defaults`.
  `image_model TEXT NOT NULL DEFAULT 'google/gemini-2.5-flash-image'`,
  `transcription_model TEXT NOT NULL DEFAULT 'google/gemini-2.5-flash-lite'`,
  `telegram_bot_token TEXT NOT NULL DEFAULT ''`,
  `telegram_bot_username TEXT NOT NULL DEFAULT ''`,
  `telegram_user_whitelist TEXT NOT NULL DEFAULT ''`,
  `telegram_group_whitelist TEXT NOT NULL DEFAULT ''`,
  `cap_mcp INTEGER NOT NULL DEFAULT 1`,
  `searxng_url TEXT NOT NULL DEFAULT ''`,
  `searxng_token TEXT NOT NULL DEFAULT ''`,
  `openrouter_api_key TEXT NOT NULL DEFAULT ''`,
];

/**
 * The `config` columns WhatsApp added, as `ALTER TABLE` fragments.
 *
 * A rung of their own rather than more entries in `CONFIG_MIGRATIONS`, because that
 * list is only ever run by the baseline step — and the baseline runs once per object,
 * before the ladder existed or on the object's first touch. An object that already
 * passed it never sees an entry appended to the list, so it goes on without the
 * column until the first statement that names one fails: `no such column:
 * cap_whatsapp`, from every read of the settings, including the one that deletes the
 * agent. Columns added from here on go in a new step below, never in that list.
 */
const WHATSAPP_CONFIG_COLUMNS = [
  `cap_whatsapp INTEGER NOT NULL DEFAULT 0`,
  `whatsapp_phone_number_id TEXT NOT NULL DEFAULT ''`,
  `whatsapp_access_token TEXT NOT NULL DEFAULT ''`,
  `whatsapp_app_secret TEXT NOT NULL DEFAULT ''`,
  `whatsapp_verify_token TEXT NOT NULL DEFAULT ''`,
  `whatsapp_number TEXT NOT NULL DEFAULT ''`,
];

/** The `mcp_servers` columns, in write order, excluding the primary key. */
const MCP_COLUMNS = [
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

/** A fact the agent chose to keep. Memories span an agent, not one session. */
export type Memory = {
  id: number;
  text: string;
  session_id: string;
  created_at: number;
};

export type SessionRow = {
  id: string;
  title: string;
  /** Who started it on the web, lowercased. "" for channel sessions and older rows. */
  owner_email: string;
  created_at: number;
  updated_at: number;
  /**
   * Hex id of this session's Durable Object. Nothing in the app reads it; it is kept
   * because it is the `objectId` needed to query Cloudflare's usage analytics by hand.
   */
  object_id: string;
  /** "web" for a session started in the browser, "telegram" for a chat with the bot. */
  source: string;
  /** The Telegram chat this session belongs to. Empty for a browser session. */
  chat_id: string;
  /** Telegram's own chat type: private, group, supergroup, channel. */
  chat_type: string;
  /** A public chat's @handle, without the @. Empty for a private one. */
  chat_username: string;
  /**
   * The forum topic inside that chat, as a string, or empty when the session is the
   * whole chat. A forum gets one session per topic, so this is part of what makes a
   * conversation distinct.
   */
  chat_thread_id: string;
};

/**
 * A single Durable Object holding the list of sessions.
 *
 * Durable Object namespaces are not enumerable — you can address an instance by name,
 * but you cannot ask Cloudflare "which instances exist". So the index lives here, in
 * one well-known object, while each session's data lives in its own SessionAgent.
 */
/**
 * Session ids carry the agent that owns them, as `<agentId>~<local>`.
 *
 * `SessionAgent` is one Durable Object namespace for the whole Worker, so a session
 * id has to be unique across every agent — and the ids that are not random are the
 * ones that would collide: two agents in the same Telegram chat both want `tg-123`,
 * which would be the same object. The prefix is also how a session finds its agent:
 * a `SessionAgent` knows nothing but its own name, and reads the owner back out of it.
 */
export const AGENT_SEPARATOR = "~";

/** The full session id for a session local to `agentId`. */
export function sessionName(agentId: string, local: string): string {
  return `${agentId}${AGENT_SEPARATOR}${local}`;
}

/** The agent a session id belongs to. Empty when the id is not one of ours. */
export function agentIdOf(sessionId: string): string {
  const cut = sessionId.indexOf(AGENT_SEPARATOR);
  return cut === -1 ? "" : sessionId.slice(0, cut);
}

/**
 * The session a chat conversation maps to. A DM is one chat, a group is another, and
 * a forum topic is its own conversation inside a group — so this is what gives each
 * of them its own session, and keeps giving it the same one. Two agents are two
 * different bots, so the same chat under each of them is two separate sessions.
 *
 * `channel` prefixes the id so a WhatsApp number and a Telegram chat that happen to
 * be the same digits cannot land on the same Durable Object. It defaults to `tg`
 * because every session created before WhatsApp existed is named that way, and those
 * ids are stored: changing the default would orphan every live chat.
 */
export function sessionIdForChat(
  agentId: string,
  chatId: string,
  threadId = "",
  channel: "tg" | "wa" = "tg"
): string {
  const base = `${channel}-${safeChatId(chatId)}`;
  return sessionName(agentId, threadId ? `${base}-t${threadId}` : base);
}

/**
 * A chat id reduced to characters a session id may hold.
 *
 * A session id is addressed as a URL path segment — `/agents/session-agent/<id>` —
 * and the Durable Object is named by that segment as it arrives. Anything
 * `encodeURIComponent` rewrites therefore reaches the object in its encoded form,
 * while the registry still holds the raw one, and every lookup the object makes about
 * itself quietly misses. A WhatsApp chat id is `wa:<number>`, and that colon is
 * exactly such a character: it cost a day of silent scheduled messages.
 *
 * Telegram ids are digits and a leading `-`, which keeps its own spelling as `n` so
 * the ids already stored stay the ids this returns.
 */
function safeChatId(chatId: string): string {
  return chatId.replace("-", "n").replace(/[^A-Za-z0-9_-]/g, "");
}

/**
 * How many sessions the delete walk reads per page. Internal batching, not a page
 * any caller is served — those are `session_page` / `max_session_page`.
 */
export const MAX_PAGE = 200;

/**
 * What a refused upload says, wherever it was refused.
 *
 * The ceiling is passed in rather than read from a constant, because the sentence
 * quotes it: a message naming 50 MB on a deployment that has raised the limit to 500
 * is worse than no message, since the reader has no way to know which number is real.
 */
export function storageFullMessage(used: number, size: number, limit: number): string {
  const mb = (n: number) => `${(n / 1_000_000).toFixed(1)} MB`;
  return (
    `This agent is using ${mb(used)} of its ${mb(limit)} file storage, ` +
    `and this file is ${mb(size)}. Delete some files or a session to make room.`
  );
}

/** What every refusal says, so the wording does not drift between four callers. */
export function sessionLimitMessage(maxSessions: number): string {
  return (
    `This agent has reached its limit of ${maxSessions} sessions. ` +
    `Delete one to start another.`
  );
}

/** One page of the session list, plus the cursor that continues it. */
export type SessionPage = {
  sessions: SessionRow[];
  has_more: boolean;
  /** Pass back as `cursor` for the next page. Empty when the list is exhausted. */
  cursor: string;
};

/** A `<updated_at>:<id>` cursor, or undefined when there is none to resume from. */
function parseCursor(cursor: string): { updated_at: number; id: string } | undefined {
  if (!cursor) return undefined;
  const cut = cursor.indexOf(":");
  if (cut === -1) return undefined;
  const updated_at = Number(cursor.slice(0, cut));
  const id = cursor.slice(cut + 1);
  if (!Number.isFinite(updated_at) || !id) return undefined;
  return { updated_at, id };
}

/**
 * One agent's access row, as the registry holds it.
 *
 * `seeded` is 0 only for an agent created before access lived here at all. It is not
 * part of the wire format: the Worker uses it to decide whether to fall back to the
 * directory, and strips it before anything is returned.
 */
export type AccessRow = {
  allowed_emails: string;
  admin_email: string;
  seeded: number;
  /**
   * Guests: people who may message the agent and nothing else — start sessions of
   * their own, read and continue those, and delete them. Never its settings, keys or
   * anyone else's sessions. `guests` is the switch; with it on, an empty
   * `guest_emails` means any signed-in address.
   */
  guests: number;
  guest_emails: string;
};

/**
 * One agent's tables, in the order they were introduced.
 *
 * Step 0 is the baseline — everything that existed before this ladder did, written
 * idempotently because every live agent already has it. Append below; do not edit it.
 */
const SESSION_REGISTRY_MIGRATIONS: readonly Migration[] = [
  {
    name: "baseline",
    up: (sql) => {
      sql.exec(
        `CREATE TABLE IF NOT EXISTS sessions (
           id TEXT PRIMARY KEY,
           title TEXT NOT NULL,
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL,
           object_id TEXT NOT NULL DEFAULT '',
           source TEXT NOT NULL DEFAULT 'web',
           chat_id TEXT NOT NULL DEFAULT '',
           chat_type TEXT NOT NULL DEFAULT '',
           chat_username TEXT NOT NULL DEFAULT '',
           chat_thread_id TEXT NOT NULL DEFAULT ''
         )`
      );
      for (const col of [
        `object_id TEXT NOT NULL DEFAULT ''`,
        `source TEXT NOT NULL DEFAULT 'web'`,
        `chat_id TEXT NOT NULL DEFAULT ''`,
        `chat_type TEXT NOT NULL DEFAULT ''`,
        `chat_username TEXT NOT NULL DEFAULT ''`,
        `chat_thread_id TEXT NOT NULL DEFAULT ''`,
      ]) addColumnIfMissing(sql, "sessions", col);
      sql.exec(
        `CREATE TABLE IF NOT EXISTS config (
           id INTEGER PRIMARY KEY CHECK (id = 1),
           model TEXT NOT NULL
         )`
      );
      // Bring forward config rows created before the tuning and capability columns.
      for (const col of CONFIG_MIGRATIONS) addColumnIfMissing(sql, "config", col);
      sql.exec(
        `CREATE TABLE IF NOT EXISTS meta (
           id INTEGER PRIMARY KEY CHECK (id = 1),
           json TEXT NOT NULL DEFAULT ''
         )`
      );
      // What the agent's turns have cost, one row per calendar month, in US dollars.
      //
      // A running total rather than a sum over the sessions: usage rows live in each
      // session's own object, so answering "what has this agent spent this month"
      // from them would mean opening every session the agent has ever had, on every
      // turn. The sessions report what they spend here instead, which makes the
      // question one read of one row.
      // Uploaded and generated bytes, agent-wide. One row, moved by each session as it
      // writes and deletes files. See `max_agent_bytes` in settings.ts.
      sql.exec(
        `CREATE TABLE IF NOT EXISTS storage (
           id INTEGER PRIMARY KEY CHECK (id = 1),
           bytes INTEGER NOT NULL DEFAULT 0
         )`
      );

      sql.exec(
        `CREATE TABLE IF NOT EXISTS spend (
           month TEXT PRIMARY KEY,
           usd REAL NOT NULL DEFAULT 0
         )`
      );
      // Who may open this agent, and who administers it. Deliberately its own table
      // and not a pair of columns on `config`: that row is walked by `redact` and
      // `validateConfig` in the Worker, returned whole by `GET /config` and patched by
      // `PATCH /config` — so an access column living there would be both readable by
      // the browser and editable by anyone the list already lets in. The gate may not
      // be reachable from the thing it guards.
      sql.exec(
        `CREATE TABLE IF NOT EXISTS access (
           id INTEGER PRIMARY KEY CHECK (id = 1),
           allowed_emails TEXT NOT NULL DEFAULT '',
           admin_email TEXT NOT NULL DEFAULT '',
           seeded INTEGER NOT NULL DEFAULT 0
         )`
      );
      sql.exec(
        `CREATE TABLE IF NOT EXISTS memories (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           text TEXT NOT NULL,
           session_id TEXT NOT NULL,
           created_at INTEGER NOT NULL
         )`
      );
      sql.exec(
        `CREATE TABLE IF NOT EXISTS mcp_servers (
           id TEXT PRIMARY KEY,
           name TEXT NOT NULL,
           url TEXT NOT NULL,
           auth TEXT NOT NULL DEFAULT 'none',
           headers TEXT NOT NULL DEFAULT '',
           enabled INTEGER NOT NULL DEFAULT 1,
           oauth_client_id TEXT NOT NULL DEFAULT '',
           oauth_client_secret TEXT NOT NULL DEFAULT '',
           oauth_access_token TEXT NOT NULL DEFAULT '',
           oauth_refresh_token TEXT NOT NULL DEFAULT '',
           oauth_expires_at INTEGER NOT NULL DEFAULT 0,
           oauth_scope TEXT NOT NULL DEFAULT '',
           oauth_token_url TEXT NOT NULL DEFAULT '',
           oauth_authorize_url TEXT NOT NULL DEFAULT '',
           oauth_registration_url TEXT NOT NULL DEFAULT '',
           oauth_resource TEXT NOT NULL DEFAULT '',
           oauth_verifier TEXT NOT NULL DEFAULT '',
           oauth_state TEXT NOT NULL DEFAULT '',
           oauth_return_to TEXT NOT NULL DEFAULT '',
           tools_json TEXT NOT NULL DEFAULT '',
           disabled_tools TEXT NOT NULL DEFAULT '',
           tools_synced_at INTEGER NOT NULL DEFAULT 0,
           last_error TEXT NOT NULL DEFAULT '',
           created_at INTEGER NOT NULL DEFAULT 0
         )`
      );
      // Bring forward server rows created before a column was added.
      for (const col of [`disabled_tools TEXT NOT NULL DEFAULT ''`]) addColumnIfMissing(sql, "mcp_servers", col);
    },
  },
  {
    name: "whatsapp delivery dedupe",
    up: (sql) => {
      // Meta re-delivers a webhook until it gets a fast 200, and a slow turn is
      // exactly what produces a retry — so the same `wamid` arrives two or three
      // times and, without this, is answered two or three times.
      //
      // It lives in the registry rather than in the session because the check has to
      // happen at the webhook, before a session has been resolved or created: two
      // concurrent deliveries of a first message would otherwise race to create two
      // sessions for one conversation.
      sql.exec(
        `CREATE TABLE IF NOT EXISTS whatsapp_events (
           id TEXT PRIMARY KEY,
           seen_at INTEGER NOT NULL
         )`
      );
    },
  },
  {
    name: "whatsapp config columns",
    up: (sql) => {
      // `addColumnIfMissing` rather than a bare `ALTER`, which a step after the
      // baseline would normally use: the deploy that first shipped WhatsApp added
      // these columns to `CONFIG_MIGRATIONS`, so every object created while that code
      // was live already has them and would fail this rung on a duplicate column.
      for (const col of WHATSAPP_CONFIG_COLUMNS) addColumnIfMissing(sql, "config", col);
    },
  },
  {
    name: "whatsapp waba id",
    up: (sql) => {
      // The account id the app has to be subscribed to. Added after the columns
      // above, so agents configured before it have it blank and are asked for it the
      // next time their settings are opened.
      addColumnIfMissing(sql, "config", `whatsapp_waba_id TEXT NOT NULL DEFAULT ''`);
    },
  },
  {
    name: "voice note columns",
    up: (sql) => {
      // What the agent speaks with, and whether it may. Agents that predate this have
      // the capability off and the model at its default, which is the same state a
      // new agent arrives in.
      addColumnIfMissing(sql, "config", `cap_voice_output INTEGER NOT NULL DEFAULT 0`);
      addColumnIfMissing(
        sql,
        "config",
        `voice_model TEXT NOT NULL DEFAULT 'openai/gpt-audio-mini'`
      );
    },
  },
  {
    name: "guests, session owners and notes",
    up: (sql) => {
      addColumnIfMissing(sql, "access", `guests INTEGER NOT NULL DEFAULT 0`);
      addColumnIfMissing(sql, "access", `guest_emails TEXT NOT NULL DEFAULT ''`);
      addColumnIfMissing(sql, "sessions", `owner_email TEXT NOT NULL DEFAULT ''`);
      sql.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_owner ON sessions(owner_email)`);
      addColumnIfMissing(sql, "config", `private_notes TEXT NOT NULL DEFAULT ''`);
      addColumnIfMissing(sql, "config", `public_notes TEXT NOT NULL DEFAULT ''`);
    },
  },
];

/**
 * How many delivered message ids to remember. Retries arrive within minutes, so this
 * only has to outlast a burst — it is a dedupe window, not a history.
 */
const WHATSAPP_EVENTS_KEPT = 500;

export class SessionRegistry extends DurableObject {
  private ready = false;
  /** Token refreshes in flight, by server id, so concurrent callers share one. */
  private refreshing = new Map<string, Promise<McpServerRow | undefined>>();

  /**
   * The agent's own tables. Ladder in `SESSION_REGISTRY_MIGRATIONS`; schema.ts says
   * why it is a ladder. One registry object per agent, so a new step lands on each
   * agent the first time that agent is touched after the deploy that added it.
   */
  private ensureSchema() {
    if (this.ready) return;
    applyMigrations(this.ctx, SESSION_REGISTRY_MIGRATIONS);
    this.ready = true;
  }

  /* --------------------------------------------------------- mcp servers -- */

  /**
   * The external MCP servers, oldest first, credentials and all. Only the Worker
   * calls this: `server.ts` strips the secrets before anything reaches the browser.
   */
  mcpServers(): McpServerRow[] {
    this.ensureSchema();
    return this.ctx.storage.sql
      .exec(`SELECT id, ${MCP_COLUMNS.join(", ")} FROM mcp_servers ORDER BY created_at`)
      .toArray() as unknown as McpServerRow[];
  }

  mcpServer(id: string): McpServerRow | undefined {
    this.ensureSchema();
    return this.ctx.storage.sql
      .exec(`SELECT id, ${MCP_COLUMNS.join(", ")} FROM mcp_servers WHERE id = ? LIMIT 1`, id)
      .toArray()[0] as unknown as McpServerRow | undefined;
  }

  /** The server an in-flight OAuth callback belongs to, matched on its CSRF state. */
  mcpServerByState(state: string): McpServerRow | undefined {
    this.ensureSchema();
    if (!state) return undefined;
    return this.ctx.storage.sql
      .exec(
        `SELECT id, ${MCP_COLUMNS.join(", ")} FROM mcp_servers WHERE oauth_state = ? LIMIT 1`,
        state
      )
      .toArray()[0] as unknown as McpServerRow | undefined;
  }

  addMcpServer(row: McpServerRow): McpServerRow {
    this.ensureSchema();
    const placeholders = MCP_COLUMNS.map(() => "?").join(", ");
    this.ctx.storage.sql.exec(
      `INSERT INTO mcp_servers (id, ${MCP_COLUMNS.join(", ")}) VALUES (?, ${placeholders})`,
      row.id,
      ...MCP_COLUMNS.map((c) => row[c])
    );
    return row;
  }

  /** A partial update: only the columns present are written. */
  updateMcpServer(id: string, patch: Partial<McpServerRow>): McpServerRow | undefined {
    this.ensureSchema();
    const keys = MCP_COLUMNS.filter((c) => patch[c] !== undefined);
    if (keys.length > 0) {
      this.ctx.storage.sql.exec(
        `UPDATE mcp_servers SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`,
        ...keys.map((k) => patch[k] as string | number),
        id
      );
    }
    return this.mcpServer(id);
  }

  /**
   * The access token for a server, refreshed if it is spent.
   *
   * Refreshing lives here, in the one object that owns the row, because a turn can
   * call several of a server's tools at once and a provider that rotates refresh
   * tokens only honours the first of two concurrent refreshes. In-flight refreshes
   * are shared, so those callers wait on one request and all see the same result.
   *
   * `force` is for a call that has already been answered with a 401: the stored
   * expiry said the token was good, and the provider disagrees.
   */
  async refreshMcpToken(id: string, force = false): Promise<McpServerRow | undefined> {
    const server = this.mcpServer(id);
    if (!server || server.auth !== "oauth" || !server.oauth_refresh_token) return server;

    const spent = server.oauth_expires_at > 0 && server.oauth_expires_at - Date.now() < 60_000;
    if (!force && !spent) return server;

    const existing = this.refreshing.get(id);
    if (existing) return await existing;

    const attempt = this.performRefresh(server).finally(() => this.refreshing.delete(id));
    this.refreshing.set(id, attempt);
    return await attempt;
  }

  private async performRefresh(server: McpServerRow): Promise<McpServerRow | undefined> {
    try {
      const tokens = await refreshToken(server.oauth_token_url, {
        refreshToken: server.oauth_refresh_token,
        clientId: server.oauth_client_id,
        clientSecret: server.oauth_client_secret || undefined,
        resource: server.oauth_resource || undefined,
      });
      return this.updateMcpServer(server.id, {
        oauth_access_token: tokens.access_token,
        // A provider that rotates hands back a new one; keep the old when it does not.
        oauth_refresh_token: tokens.refresh_token ?? server.oauth_refresh_token,
        oauth_expires_at: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : 0,
        last_error: "",
      });
    } catch (err) {
      // A refusal of the grant itself is the end of this connection: drop the tokens
      // so the server reads as disconnected and offers a Connect button, rather than
      // sitting there advertising tools that every call will fail.
      if (err instanceof McpTokenError && err.permanent) {
        return this.updateMcpServer(server.id, {
          oauth_access_token: "",
          oauth_refresh_token: "",
          oauth_expires_at: 0,
          tools_json: "",
          last_error: "The connection expired. Connect again to keep using it.",
        });
      }
      return this.updateMcpServer(server.id, {
        last_error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Notes what a failed call learned, so the card stops claiming the server works. */
  noteMcpError(id: string, message: string) {
    this.ensureSchema();
    this.ctx.storage.sql.exec(`UPDATE mcp_servers SET last_error = ? WHERE id = ?`, message, id);
  }

  removeMcpServer(id: string) {
    this.ensureSchema();
    this.ctx.storage.sql.exec(`DELETE FROM mcp_servers WHERE id = ?`, id);
  }

  /* --------------------------------------------------------------- access -- */

  /**
   * Who may open this agent, and who administers it. **This is the authority.**
   *
   * Every access decision in the Worker is taken from here rather than from the
   * directory, because this object is one per agent and the directory is one for the
   * whole deployment: an access check that reads the directory puts every message
   * every user sends through a single thread in a single datacenter.
   *
   * `seeded` is what separates "this agent has no members" from "this agent has not
   * been asked yet". Agents created before access moved here have their list only in
   * the directory, and reading a missing row as an empty list would lock every one of
   * their users out the moment this deploys. So the unseeded state is explicit, and
   * the Worker answers it by seeding from the directory once — see `seedAccess`.
   */
  access(): AccessRow {
    this.ensureSchema();
    const row = this.ctx.storage.sql
      .exec(
        `SELECT allowed_emails, admin_email, seeded, guests, guest_emails FROM access WHERE id = 1`
      )
      .toArray()[0] as AccessRow | undefined;
    return row ?? { allowed_emails: "", admin_email: "", seeded: 0, guests: 0, guest_emails: "" };
  }

  /**
   * Write the access list, and — only if it has never been written — the admin.
   *
   * `admin_email` is set once, at creation, and no route moves it: an agent whose
   * administrator can be handed over is one that can be taken. That rule is enforced
   * here rather than trusted to callers, so a `setAccess` carrying an admin for an
   * agent that already has one silently keeps the one it has.
   *
   * Writing anything at all marks the row seeded, so the directory is never consulted
   * for this agent again.
   */
  setAccess(patch: { allowed_emails?: string; admin_email?: string }): AccessRow {
    const current = this.access();
    const allowed = patch.allowed_emails ?? current.allowed_emails;
    const admin = current.admin_email || (patch.admin_email ?? "").trim().toLowerCase();
    this.ctx.storage.sql.exec(
      `INSERT INTO access (id, allowed_emails, admin_email, seeded) VALUES (1, ?, ?, 1)
       ON CONFLICT(id) DO UPDATE SET
         allowed_emails = excluded.allowed_emails,
         admin_email = excluded.admin_email,
         seeded = 1`,
      allowed,
      admin
    );
    return { ...current, allowed_emails: allowed, admin_email: admin, seeded: 1 };
  }

  /**
   * Switch guests on or off and replace their list. Separate from `setAccess` because
   * it is a different decision, made by the admin rather than by any user.
   */
  setGuests(patch: { guests?: number; guest_emails?: string }): AccessRow {
    const current = this.access();
    const guests = patch.guests === undefined ? current.guests : patch.guests ? 1 : 0;
    const emails = patch.guest_emails ?? current.guest_emails;
    this.ctx.storage.sql.exec(
      `INSERT INTO access (id, allowed_emails, admin_email, seeded, guests, guest_emails)
       VALUES (1, ?, ?, 1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET guests = excluded.guests, guest_emails = excluded.guest_emails`,
      current.allowed_emails,
      current.admin_email,
      guests,
      emails
    );
    return { ...current, guests, guest_emails: emails };
  }

  /**
   * Adopt the directory's copy, once, for an agent that predates this table.
   *
   * Does nothing to an agent that has already been seeded, which is what makes it
   * safe for two requests to arrive at the same unseeded agent at once: the method
   * body has no `await` in it, so a Durable Object runs it to completion before the
   * second caller starts, and the second caller then finds `seeded = 1` and reads
   * what the first one wrote. They would be writing identical rows in any case — both
   * read the same directory row — so the race is benign even where it is visible.
   *
   * It is deliberately not `setAccess`: this may only ever *fill in* an agent nobody
   * has written access for, never overwrite a decision already recorded here.
   */
  seedAccess(allowedEmails: string, adminEmail: string): AccessRow {
    const current = this.access();
    if (current.seeded) return current;
    const admin = adminEmail.trim().toLowerCase();
    this.ctx.storage.sql.exec(
      `INSERT INTO access (id, allowed_emails, admin_email, seeded) VALUES (1, ?, ?, 1)
       ON CONFLICT(id) DO UPDATE SET
         allowed_emails = excluded.allowed_emails,
         admin_email = excluded.admin_email,
         seeded = 1`,
      allowedEmails,
      admin
    );
    return { ...current, allowed_emails: allowedEmails, admin_email: admin, seeded: 1 };
  }

  /* ------------------------------------------------------------- storage -- */

  /**
   * Move the agent's byte total, up on an upload and down when files go.
   *
   * A running total, so it can drift from the truth if a session dies between
   * writing a file and reporting it. It is clamped at zero and it is only ever a
   * ceiling on uploads, so drift costs somebody a few megabytes of headroom rather
   * than losing their files.
   */
  addStorageBytes(delta: number): void {
    this.ensureSchema();
    if (!Number.isFinite(delta) || delta === 0) return;
    // The delta is bound twice, and deliberately not through `excluded`: `excluded.bytes`
    // is the *insert* value, which is already clamped to zero by `MAX(?, 0)` for the
    // no-row-yet case — so an update reading it added zero for every negative delta, and
    // deleting a file never gave its bytes back. The two branches want different values,
    // so they get two bindings.
    const bytes = Math.trunc(delta);
    this.ctx.storage.sql.exec(
      `INSERT INTO storage (id, bytes) VALUES (1, MAX(?, 0))
       ON CONFLICT(id) DO UPDATE SET bytes = MAX(bytes + ?, 0)`,
      bytes,
      bytes
    );
  }

  /**
   * What the agent is holding, and the ceiling it is held against.
   *
   * The ceiling is passed in for the same reason `config` takes the default model: an
   * agent's registry is not the object that decides deployment-wide numbers, and a
   * cross-object read on every upload would be an RPC hop per file. Callers get it
   * from `deploymentSettings(env)`, which caches it.
   */
  storageState(limit: number): { bytes: number; limit: number } {
    this.ensureSchema();
    const row = this.ctx.storage.sql
      .exec(`SELECT bytes FROM storage WHERE id = 1 LIMIT 1`)
      .toArray()[0] as { bytes: number } | undefined;
    return { bytes: Math.max(0, Number(row?.bytes ?? 0)), limit };
  }

  /** How many more bytes this agent may take. Never negative. */
  storageRoom(limit: number): number {
    const { bytes } = this.storageState(limit);
    return Math.max(0, limit - bytes);
  }

  /* --------------------------------------------------------------- spend -- */

  /**
   * Bank what a turn cost against this month.
   *
   * Called by the session that spent it, after the turn is over — the cost is only
   * known once OpenRouter has answered, and a turn that failed still spent whatever
   * tokens it generated.
   */
  addSpend(usd: number): void {
    this.ensureSchema();
    if (!Number.isFinite(usd) || usd <= 0) return;
    this.ctx.storage.sql.exec(
      `INSERT INTO spend (month, usd) VALUES (?, ?)
       ON CONFLICT(month) DO UPDATE SET usd = usd + excluded.usd`,
      thisMonth(),
      usd
    );
  }

  /** What this agent has spent in the current calendar month, in US dollars. */
  spendThisMonth(): number {
    this.ensureSchema();
    const row = this.ctx.storage.sql
      .exec(`SELECT usd FROM spend WHERE month = ? LIMIT 1`, thisMonth())
      .toArray()[0] as { usd: number } | undefined;
    return row?.usd ?? 0;
  }

  /**
   * This month's spend and the ceiling it is measured against, in one read.
   *
   * One call because both halves are wanted at the same moments and by the same
   * callers: the gate in front of every turn, and the dialog that shows where the
   * agent stands. `limit` of 0 means there is no ceiling.
   */
  spendState(): { usd: number; limit: number; month: string } {
    return {
      usd: this.spendThisMonth(),
      limit: this.meta().monthly_spend_limit,
      month: thisMonth(),
    };
  }

  /* ------------------------------------------------------- meta settings -- */

  /** The agent's defaults, or the empty set when nobody has set any. */
  meta(): MetaSettings {
    this.ensureSchema();
    const row = this.ctx.storage.sql.exec(`SELECT json FROM meta WHERE id = 1`).toArray()[0] as
      | { json: string }
      | undefined;
    if (!row?.json) return DEFAULT_META;
    try {
      const stored = JSON.parse(row.json) as Partial<MetaSettings>;
      return {
        ...DEFAULT_META,
        ...stored,
        // The list was bare ids before each model carried its own vision flag. An
        // agent stored back then said nothing about images either way, which is the
        // same thing an unknown id says: assume it sees them.
        models: (stored.models ?? []).map((m) =>
          typeof m === "string" ? { id: m, vision: true } : m
        ),
        mcp: { ...DEFAULT_META.mcp, ...(stored.mcp ?? {}) },
      };
    } catch {
      // A blob we cannot read is one nobody can fix from the dialog either.
      return DEFAULT_META;
    }
  }

  /** Replaces the whole document: the dialog always sends the settings entire. */
  setMeta(next: MetaSettings): MetaSettings {
    this.ensureSchema();
    this.ctx.storage.sql.exec(
      `INSERT INTO meta (id, json) VALUES (1, ?)
       ON CONFLICT(id) DO UPDATE SET json = excluded.json`,
      JSON.stringify(next)
    );
    return this.meta();
  }

  /**
   * Reads the settings row, seeding it from the deployment's defaults on first use.
   *
   * `seed` is the deployment's `config_defaults`, applied over the factory values and
   * only ever on the first read — an agent that already has a row keeps what it has,
   * because a default is where a setting starts, not what it is held to. Locking a
   * setting so the agent cannot move it is what `MetaSettings.locked` is for.
   */
  config(defaultModel: string, seed: Pick<Config, SettableConfigKey>): Config {
    this.ensureSchema();
    const row = this.ctx.storage.sql
      .exec(`SELECT ${CONFIG_COLUMNS.join(", ")} FROM config WHERE id = 1`)
      .toArray()[0] as Config | undefined;
    if (row) return row;
    const seeded: Config = { model: defaultModel, ...seed, ...DEFAULT_CONFIG };
    this.write(seeded);
    return seeded;
  }

  setConfig(
    patch: Partial<Config>,
    defaultModel: string,
    seed: Pick<Config, SettableConfigKey>
  ): Config {
    const next = { ...this.config(defaultModel, seed), ...patch };
    this.write(next);
    return next;
  }

  private write(config: Config) {
    const placeholders = CONFIG_COLUMNS.map(() => "?").join(", ");
    const updates = CONFIG_COLUMNS.map((c) => `${c} = excluded.${c}`).join(", ");
    this.ctx.storage.sql.exec(
      `INSERT INTO config (id, ${CONFIG_COLUMNS.join(", ")}) VALUES (1, ${placeholders})
       ON CONFLICT(id) DO UPDATE SET ${updates}`,
      ...CONFIG_COLUMNS.map((c) => config[c])
    );
  }

  /**
   * One page of sessions, newest first.
   *
   * The list is read on every page load and after every turn, and a busy agent
   * accumulates sessions without bound — so it is paged rather than returned whole.
   * `cursor` is keyset rather than an offset: sessions are ordered by `updated_at`,
   * which a turn changes underneath a scroll, and an offset would skip or repeat
   * rows when that happens. `id` breaks ties between sessions touched in the same
   * millisecond, and is what makes the cursor a total order.
   */
  /** How many sessions this agent has. Admin stats only — the hot path pages instead. */
  sessionCount(): number {
    this.ensureSchema();
    const row = this.ctx.storage.sql.exec(`SELECT COUNT(*) AS n FROM sessions`).toArray()[0] as
      | { n: number }
      | undefined;
    return row?.n ?? 0;
  }

  /** `owner`, when given, narrows the page to the sessions that address started. */
  list(limit: number, cursor = "", owner = ""): SessionPage {
    this.ensureSchema();
    const size = Math.max(1, Math.trunc(limit));
    const after = parseCursor(cursor);
    // One row past the page: its existence is the only thing `has_more` needs, and
    // it is cheaper than a second COUNT over the table.
    const rows = this.ctx.storage.sql
      .exec(
        `SELECT id, title, owner_email, created_at, updated_at, object_id, source, chat_id,
                chat_type, chat_username, chat_thread_id
         FROM sessions
         WHERE (?1 = '' OR owner_email = ?1)
           AND (?2 = 0 OR updated_at < ?2 OR (updated_at = ?2 AND id > ?3))
         ORDER BY updated_at DESC, id ASC LIMIT ?4`,
        owner,
        after?.updated_at ?? 0,
        after?.id ?? "",
        size + 1
      )
      .toArray() as unknown as SessionRow[];

    const page = rows.slice(0, size);
    const last = page[page.length - 1];
    return {
      sessions: page,
      has_more: rows.length > size,
      cursor: rows.length > size && last ? `${last.updated_at}:${last.id}` : "",
    };
  }

  /** How many sessions this agent holds. What `max_sessions` is measured against. */
  countSessions(): number {
    this.ensureSchema();
    const row = this.ctx.storage.sql
      .exec(`SELECT COUNT(*) AS n FROM sessions`)
      .toArray()[0] as { n: number } | undefined;
    return Number(row?.n ?? 0);
  }

  create(
    id: string,
    title: string,
    objectId: string,
    origin: Pick<
      SessionRow,
      "source" | "chat_id" | "chat_type" | "chat_username" | "chat_thread_id"
    > = {
      source: "web",
      chat_id: "",
      chat_type: "",
      chat_username: "",
      chat_thread_id: "",
    },
    /** The deployment's `max_sessions`, passed in by the caller. See `storageState`. */
    maxSessions: number,
    /** Who started it on the web. Written once; an update keeps the first owner. */
    owner = ""
  ): SessionRow {
    this.ensureSchema();
    // The ceiling, enforced here because here is where every path meets: the web
    // button, a fork, `!new`, and the first message from a Telegram chat nobody has
    // spoken to before. A caller that checked first and then created would still be
    // racing the other three.
    //
    // A row that already exists is an update, not a new session, so it is let
    // through whatever the count is — otherwise renaming the oldest session would
    // start failing the moment the agent filled up.
    if (this.countSessions() >= maxSessions && !this.get(id)) {
      throw new Error(sessionLimitMessage(maxSessions));
    }
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `INSERT INTO sessions (id, title, owner_email, created_at, updated_at, object_id, source,
                             chat_id, chat_type, chat_username, chat_thread_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at,
                                     object_id = excluded.object_id`,
      id,
      title,
      owner.trim().toLowerCase(),
      now,
      now,
      objectId,
      origin.source,
      origin.chat_id,
      origin.chat_type,
      origin.chat_username,
      origin.chat_thread_id
    );
    return this.get(id)!;
  }

  /**
   * The session a Telegram conversation maps to, if it has one already. A topic is its
   * own conversation, so the thread is matched too — a group's own session (thread '')
   * never answers for a topic inside it.
   */
  forChat(chatId: string, threadId = ""): SessionRow | undefined {
    this.ensureSchema();
    return this.ctx.storage.sql
      .exec(
        `SELECT id, title, owner_email, created_at, updated_at, object_id, source, chat_id,
                chat_type, chat_username, chat_thread_id
         FROM sessions WHERE chat_id = ? AND chat_thread_id = ? LIMIT 1`,
        chatId,
        threadId
      )
      .toArray()[0] as unknown as SessionRow | undefined;
  }

  /**
   * A session id for a chat that has none yet. Normally that is the chat's own id,
   * but `!new` leaves the previous session in place under exactly that name — so a
   * generation is appended until the name is free. Without this the "new" session
   * would be the old Durable Object again, which is the one thing it must not be.
   *
   * It lives here rather than at the webhook because `!new` needs the same answer:
   * the session it hands its scheduled tasks to has to be the one the next message
   * lands in.
   */
  freeChatSessionId(
    agentId: string,
    chatId: string,
    threadId = "",
    channel: "tg" | "wa" = "tg"
  ): string {
    this.ensureSchema();
    const base = sessionIdForChat(agentId, chatId, threadId, channel);
    if (!this.get(base)) return base;
    for (let n = 2; n < 1000; n++) {
      const candidate = `${base}-g${n}`;
      if (!this.get(candidate)) return candidate;
    }
    // A thousand fresh starts in one chat is not a thing; fall back to a unique name.
    return `${base}-g${crypto.randomUUID().slice(0, 8)}`;
  }

  /**
   * Claim one WhatsApp delivery, returning true the first time and false for every
   * repeat of the same `wamid`.
   *
   * A Durable Object handles one request at a time, so the read and the write cannot
   * interleave: two simultaneous deliveries of the same message are serialised here,
   * and exactly one of them is told to go on. That is the whole reason the check is
   * in the registry and not in the webhook's own code.
   */
  claimWhatsappEvent(id: string): boolean {
    this.ensureSchema();
    if (!id) return false;
    const seen = this.ctx.storage.sql
      .exec(`SELECT id FROM whatsapp_events WHERE id = ? LIMIT 1`, id)
      .toArray();
    if (seen.length > 0) return false;
    this.ctx.storage.sql.exec(
      `INSERT INTO whatsapp_events (id, seen_at) VALUES (?, ?)`,
      id,
      Date.now()
    );
    this.ctx.storage.sql.exec(
      `DELETE FROM whatsapp_events WHERE id NOT IN (
         SELECT id FROM whatsapp_events ORDER BY seen_at DESC LIMIT ?
       )`,
      WHATSAPP_EVENTS_KEPT
    );
    return true;
  }

  /** One session by id, or nothing. */
  get(id: string): SessionRow | undefined {
    this.ensureSchema();
    return this.ctx.storage.sql
      .exec(
        `SELECT id, title, owner_email, created_at, updated_at, object_id, source, chat_id,
                chat_type, chat_username, chat_thread_id
         FROM sessions WHERE id = ? LIMIT 1`,
        id
      )
      .toArray()[0] as unknown as SessionRow | undefined;
  }

  /**
   * Cut a session loose from its Telegram chat without touching what it holds. The
   * chat stops resolving to it, so the next message there starts somewhere new, while
   * the conversation stays readable in the browser exactly as it was left.
   */
  detachChat(id: string) {
    this.ensureSchema();
    this.ctx.storage.sql.exec(
      `UPDATE sessions SET chat_id = '', chat_thread_id = '' WHERE id = ?`,
      id
    );
  }

  touch(id: string) {
    this.ensureSchema();
    this.ctx.storage.sql.exec(`UPDATE sessions SET updated_at = ? WHERE id = ?`, Date.now(), id);
  }

  rename(id: string, title: string) {
    this.ensureSchema();
    this.ctx.storage.sql.exec(`UPDATE sessions SET title = ? WHERE id = ?`, title, id);
  }

  remove(id: string) {
    this.ensureSchema();
    this.ctx.storage.sql.exec(`DELETE FROM sessions WHERE id = ?`, id);
  }

  /**
   * Memory spans the agent on purpose: a fact worth keeping ("I use pnpm") is worth
   * keeping in the agent's next session too, which is the whole point of remembering
   * it. It stops there — one agent never reads another's memories.
   */
  remember(text: string, sessionId: string): Memory {
    this.ensureSchema();
    const row = { text, session_id: sessionId, created_at: Date.now() };
    const id = this.ctx.storage.sql
      .exec(
        `INSERT INTO memories (text, session_id, created_at) VALUES (?, ?, ?) RETURNING id`,
        row.text,
        row.session_id,
        row.created_at
      )
      .toArray()[0] as { id: number };
    return { id: id.id, ...row };
  }

  /**
   * Substring search, newest first. Small enough a table that scanning it beats
   * carrying an embedding model around; `query` empty returns the most recent.
   */
  recall(query: string, limit = 20): Memory[] {
    this.ensureSchema();
    const sql = query
      ? `SELECT id, text, session_id, created_at FROM memories
         WHERE text LIKE ? COLLATE NOCASE ORDER BY id DESC LIMIT ?`
      : `SELECT id, text, session_id, created_at FROM memories ORDER BY id DESC LIMIT ?`;
    const args = query ? [`%${query}%`, limit] : [limit];
    return this.ctx.storage.sql.exec(sql, ...args).toArray() as unknown as Memory[];
  }

  forget(id: number) {
    this.ensureSchema();
    this.ctx.storage.sql.exec(`DELETE FROM memories WHERE id = ?`, id);
  }

  /**
   * Drop everything this agent owns. Called when the agent itself is deleted, after
   * its sessions have been destroyed: a Durable Object is billed for the bytes it
   * holds, so an emptied-but-living registry still costs.
   */
  async wipe(): Promise<void> {
    await this.ctx.storage.deleteAll();
    this.ready = false;
  }
}

/* ------------------------------------------------------------- directory -- */

/** An agent: a bot, its settings, its MCP servers, its memories, its sessions. */
export type AgentRow = {
  id: string;
  name: string;
  created_at: number;
  updated_at: number;
  /**
   * Who may open this agent: newline-separated email addresses, lowercased.
   *
   * Access is by email rather than by account id because an agent is usually shared
   * before the people it is shared with have signed in — the address is what the
   * owner knows, and Clerk hands the same address back once they do. Empty means
   * nobody but nothing else: an agent with no addresses is unreachable, which is why
   * creation always seeds it with the creator's own.
   */
  allowed_emails: string;
  /**
   * The one address that administers this agent: whoever created it, lowercased.
   *
   * Separate from `allowed_emails` on purpose. The access list says who may *use* the
   * agent — open its pages, chat with it, change its settings. This says who may
   * change the decisions *behind* those settings: the meta document, and whether the
   * agent goes on existing at all. It is set once, at creation, and never moves.
   *
   * Being the admin is not membership. An admin who is not on the access list cannot
   * open the agent any more than a stranger can; they see it on their list of agents
   * and they can administer it, and that is all. Putting themselves on the list is a
   * deliberate act, the same as adding anybody else.
   */
  admin_email: string;
  /**
   * The fleet this agent belongs to, or '' when it stands alone.
   *
   * A fleet is one create call that made several agents at once — one per address —
   * all of them holding the same settings. The id is what groups them on the home
   * page; it is shared by every agent that call made and by nothing else.
   */
  fleet_id: string;
  /** What that fleet is called. '' for an agent that is not in one. */
  fleet_name: string;
};

/** One page of agents, with the cursor that asks for the page after it. */
export type AgentPage = {
  agents: AgentRow[];
  has_more: boolean;
  /** Opaque; handed back untouched. Empty once the list is exhausted. */
  cursor: string;
};

/** A fleet as the home page lists it: a name, and how many agents are inside. */
export type FleetRow = {
  fleet_id: string;
  fleet_name: string;
  agents: number;
  created_at: number;
};

/**
 * Where a page stopped: the sort key of its last row, `<created_at>:<id>`.
 *
 * A keyset rather than an offset. The lists this pages are appended to while they
 * are being read — an offset would skip or repeat a row every time an agent is
 * created mid-scroll, and a fleet of thousands is read over minutes, not seconds.
 */
function encodeCursor(row: AgentRow): string {
  return `${row.created_at}:${row.id}`;
}

function decodeCursor(cursor: string): { created_at: number; id: string } | null {
  const cut = cursor.indexOf(":");
  if (cut === -1) return null;
  const created = Number(cursor.slice(0, cut));
  const id = cursor.slice(cut + 1);
  if (!Number.isFinite(created) || !id) return null;
  return { created_at: created, id };
}

/** How stale an agent's "last used" date may get before `touch` writes again. */
const TOUCH_INTERVAL = 5 * 60 * 1000;

/**
 * The calendar month a spend row is keyed by, as `YYYY-MM` in UTC.
 *
 * UTC rather than anybody's local month: the agent, its administrator and its user
 * can each be somewhere different, and a ceiling that resets at a different hour for
 * each of them is one nobody can reason about.
 */
export function thisMonth(at = Date.now()): string {
  return new Date(at).toISOString().slice(0, 7);
}

/** The addresses in a stored access list: lowercased, trimmed, blanks dropped. */
export function splitEmails(stored: string): string[] {
  return stored
    .split("\n")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * The stored form of an access list: lowercased, de-duplicated, one per line.
 *
 * Throws when there are more than `maxMembers` of them, so the caller can say so.
 * The ceiling is passed in because it is the deployment's `max_members`, not this
 * function's.
 */
export function normalizeEmails(input: string | string[], maxMembers: number): string {
  const raw = Array.isArray(input) ? input : input.split(/[\n,;]/);
  const seen = new Set<string>();
  for (const entry of raw) {
    const email = entry.trim().toLowerCase();
    // Enough of a shape check to keep typos and pasted prose out of the list.
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) seen.add(email);
  }
  if (seen.size > maxMembers) {
    throw new Error(`an agent may have at most ${maxMembers} addresses on its access list`);
  }
  return [...seen].join("\n");
}

/** The first address on a stored access list, or "" when it is empty. */
function firstEmail(allowed: string): string {
  return splitEmails(allowed)[0] ?? "";
}

/**
 * Whether `email` appears in a stored access list.
 *
 * Still here, and still exact, because the access list travels to the Worker as the
 * text column on `AgentRow` — `mayUseAgent` and the per-section checks in `server.ts`
 * have a row in hand and no reason to ask the directory a second question. The
 * `agent_members` table is what makes *finding* rows by address indexable; this is
 * what checks one row already fetched.
 */
export function emailAllowed(allowed: string, email: string): boolean {
  const wanted = email.trim().toLowerCase();
  if (!wanted) return false;
  return splitEmails(allowed).includes(wanted);
}

/**
 * The list of agents, in one well-known Durable Object.
 *
 * Same reason the session index exists: a Durable Object namespace can be addressed
 * by name but not enumerated, so "which agents exist" has to be written down
 * somewhere. This holds names only — everything an agent *is* lives in its own
 * `SessionRegistry`, which is why deleting an agent is two steps, not one.
 */
/**
 * The directory's tables, in the order they were introduced.
 *
 * Step 0 is the baseline, written idempotently because the live directory object
 * already has all of it. Append below; do not edit it.
 */
const AGENT_DIRECTORY_MIGRATIONS: readonly Migration[] = [
  {
    name: "baseline",
    up: (sql) => {
      sql.exec(
        `CREATE TABLE IF NOT EXISTS agents (
           id TEXT PRIMARY KEY,
           name TEXT NOT NULL,
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL,
           allowed_emails TEXT NOT NULL DEFAULT '',
           admin_email TEXT NOT NULL DEFAULT ''
         )`
      );
      // Bring forward rows created before an agent had an access list, and before the
      // admin was a person rather than everyone on that list.
      for (const col of [
        `allowed_emails TEXT NOT NULL DEFAULT ''`,
        `admin_email TEXT NOT NULL DEFAULT ''`,
        // A cached count of the agent's sessions, kept here so the admin dashboard is
        // one query against this object instead of one round trip per agent. `-1` means
        // "never measured" — the rows that existed before this column did — and the
        // stats route fills those in once, by asking each session registry directly.
        `session_count INTEGER NOT NULL DEFAULT -1`,
        // The fleet an agent was created into. Empty on every agent made before
        // fleets existed, which is exactly what "stands alone" means.
        `fleet_id TEXT NOT NULL DEFAULT ''`,
        `fleet_name TEXT NOT NULL DEFAULT ''`,
      ]) addColumnIfMissing(sql, "agents", col);
      // Agents made before the split have no admin, and no record of who created them:
      // everyone on the list was both user and administrator. The first address on the
      // list is the closest thing to the creator that was ever written down — the
      // create dialog seeds the box with their own address — so it inherits the role.
      sql.exec(
        `UPDATE agents
            SET admin_email = lower(trim(
                  CASE WHEN instr(allowed_emails, char(10)) > 0
                       THEN substr(allowed_emails, 1, instr(allowed_emails, char(10)) - 1)
                       ELSE allowed_emails END))
          WHERE admin_email = ''`
      );

      // One row per address, which is what makes "the agents this person may open" an
      // index lookup instead of a walk over every agent in the deployment.
      sql.exec(
        `CREATE TABLE IF NOT EXISTS agent_members (
           agent_id TEXT NOT NULL,
           email TEXT NOT NULL,
           PRIMARY KEY (agent_id, email)
         )`
      );
      sql.exec(
        `CREATE INDEX IF NOT EXISTS idx_agent_members_email ON agent_members(email)`
      );
      sql.exec(
        `CREATE INDEX IF NOT EXISTS idx_agents_admin_email ON agents(admin_email)`
      );
      // One fleet's agents, in page order. A fleet is the one list here that can run
      // to thousands of rows, so the index carries the sort key as well as the
      // grouping key: a page of it is a range scan, never a sort of the whole fleet.
      sql.exec(
        `CREATE INDEX IF NOT EXISTS idx_agents_fleet ON agents(fleet_id, created_at, id)`
      );

      // Absence is the ordinary case: an account with no row here administers at most
      // `default_agent_limit` agent. A row is only ever written by the owner's own
      // admin route, so this table's whole contents are the deployment's business
      // accounts.
      sql.exec(
        `CREATE TABLE IF NOT EXISTS account_limits (
           email TEXT PRIMARY KEY,
           agent_limit INTEGER NOT NULL
         )`
      );

      // A fleet's own meta document: the settings every agent in it was created
      // holding, and the ones an agent added later is created holding.
      //
      // Kept here rather than read off any one of the fleet's agents, because an
      // agent's own meta document drifts — it is overwritten wholesale each time the
      // fleet's is applied, and between applications its users change what they are
      // allowed to change. This row is what the fleet *means*, which is a different
      // question from what any agent currently holds.
      sql.exec(
        `CREATE TABLE IF NOT EXISTS fleet_meta (
           fleet_id TEXT PRIMARY KEY,
           json TEXT NOT NULL DEFAULT '',
           updated_at INTEGER NOT NULL DEFAULT 0
         )`
      );

      // A queue, not a log: a request sits here until the owner resolves it, then it's
      // gone — approving folds the increase into `account_limits` and deleting just
      // clears the ask. Nothing downstream reads a resolved request, so there is
      // nothing worth keeping one around for.
      sql.exec(
        `CREATE TABLE IF NOT EXISTS business_requests (
           id TEXT PRIMARY KEY,
           email TEXT NOT NULL,
           requested_increase INTEGER NOT NULL,
           created_at INTEGER NOT NULL
         )`
      );

    },
  },
  {
    // The deployment's own knobs, in the one object there is exactly one of.
    //
    // Here rather than in a `wrangler` var because the point is to change a ceiling
    // without a deploy, and here rather than in each agent's own registry because a
    // ceiling is the deployment's answer, not an agent's — an agent that could raise
    // its own `max_sessions` would not have a limit.
    //
    // One row holding a JSON patch: the document is nested, nothing queries a field
    // of it, and it holds only what this deployment has decided for itself, so a
    // column per setting would be a migration per setting for no lookup.
    name: "deployment settings",
    up: (sql) => {
      sql.exec(
        `CREATE TABLE IF NOT EXISTS deployment_settings (
           id INTEGER PRIMARY KEY CHECK (id = 1),
           json TEXT NOT NULL DEFAULT '',
           updated_at INTEGER NOT NULL DEFAULT 0
         )`
      );
    },
  },
  {
    // Metadata: free-form tags an app attaches to the agents it makes, so each app
    // lists only its own (`with`) and the others can leave them out (`without`).
    //
    // Guests: an index copy of each agent's guest switch and list, so "the agents
    // this address may message" is a query. The registry stays the authority.
    name: "agent metadata and guests",
    up: (sql) => {
      addColumnIfMissing(sql, "agents", `metadata TEXT NOT NULL DEFAULT '{}'`);
      addColumnIfMissing(sql, "agents", `guests INTEGER NOT NULL DEFAULT 0`);
      sql.exec(
        `CREATE TABLE IF NOT EXISTS agent_guests (
           agent_id TEXT NOT NULL,
           email TEXT NOT NULL,
           PRIMARY KEY (agent_id, email)
         )`
      );
      sql.exec(`CREATE INDEX IF NOT EXISTS idx_agent_guests_email ON agent_guests(email)`);
      sql.exec(`CREATE INDEX IF NOT EXISTS idx_agents_guests ON agents(guests)`);
    },
  },
];

/**
 * Which agents a listing keeps, by metadata. `with` keeps only agents whose `key`
 * holds `value`; `without` drops every agent that has `key` at all.
 */
/** The row as `AgentRow` has always looked: the metadata column is for filtering. */
function withoutMetadata(row: AgentRow & { metadata?: string }): AgentRow {
  const { metadata: _metadata, ...rest } = row;
  return rest;
}

export type MetadataFilter = { with?: [string, string]; without?: string };

/** Metadata keys are plain identifiers: they end up inside a JSON path. */
export const METADATA_KEY = /^[a-z0-9_-]{1,40}$/;

/** The SQL condition for `filter` on table alias `a`, and its bound values. */
function metadataClause(filter: MetadataFilter | undefined): { sql: string; args: string[] } {
  const parts: string[] = [];
  const args: string[] = [];
  if (filter?.with && METADATA_KEY.test(filter.with[0])) {
    parts.push(`json_extract(a.metadata, '$."' || ? || '"') = ?`);
    args.push(filter.with[0], filter.with[1]);
  }
  if (filter?.without && METADATA_KEY.test(filter.without)) {
    parts.push(`json_extract(a.metadata, '$."' || ? || '"') IS NULL`);
    args.push(filter.without);
  }
  return { sql: parts.length ? parts.join(" AND ") : "1", args };
}

export class AgentDirectory extends DurableObject {
  private ready = false;

  /**
   * The deployment-wide directory tables. Ladder in `AGENT_DIRECTORY_MIGRATIONS`.
   *
   * `migrate()` still runs after it, and still keeps its own `schema_version` row: it
   * guards a data backfill that predates this ladder, and renumbering it against the
   * ladder's version would mean deciding what an already-written `1` meant. Leaving
   * the two counters separate costs one extra table and no ambiguity.
   */
  private ensureSchema() {
    if (this.ready) return;
    applyMigrations(this.ctx, AGENT_DIRECTORY_MIGRATIONS);
    this.migrate();
    this.ready = true;
  }

  /**
   * One-time data migrations, guarded by a version number rather than by the shape of
   * the data.
   *
   * The `admin_email` backfill above can re-run harmlessly because "no admin" is a
   * state the data can express. Membership cannot: an agent with no rows in
   * `agent_members` is indistinguishable from one that has not been migrated yet, and
   * guessing wrong in the second direction would silently re-add addresses that were
   * deliberately removed. So the version is written down.
   *
   * Nothing here drops anything. `agents.allowed_emails` stays exactly as it was —
   * see `setAllowedEmails` for why it is still written.
   */
  private migrate() {
    const sql = this.ctx.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)`);
    const current = Number(
      (sql.exec(`SELECT version FROM schema_version LIMIT 1`).toArray()[0]?.version as
        | number
        | undefined) ?? 0
    );

    // v1: membership moves from the newline-separated column to its own table. The
    // column is the only record of who was on which list, so it is read, not cleared.
    if (current < 1) {
      this.ctx.storage.transactionSync(() => {
        const rows = sql
          .exec(`SELECT id, allowed_emails FROM agents`)
          .toArray() as unknown as { id: string; allowed_emails: string }[];
        for (const row of rows) {
          for (const email of splitEmails(row.allowed_emails)) {
            sql.exec(
              `INSERT OR IGNORE INTO agent_members (agent_id, email) VALUES (?, ?)`,
              row.id,
              email
            );
          }
        }
        sql.exec(`DELETE FROM schema_version`);
        sql.exec(`INSERT INTO schema_version (version) VALUES (1)`);
      });
    }
  }

  /**
   * Point `agent_members` at exactly `emails`, and mirror the same list back into
   * `agents.allowed_emails`.
   *
   * Two places, one write, because they answer different questions. The table answers
   * "which agents may this address open", which has to be indexable. The column
   * answers "who is on this agent's list", which every read of a row already needs —
   * so keeping it means `get()` stays a single-row read with no join, and the shape
   * the Worker and the browser see does not change at all.
   *
   * It is a projection, not a second opinion: this is the only method that writes
   * either of them, and it writes both inside one transaction.
   */
  private writeMembers(id: string, allowedEmails: string) {
    const emails = splitEmails(allowedEmails);
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(`DELETE FROM agent_members WHERE agent_id = ?`, id);
      for (const email of emails) {
        this.ctx.storage.sql.exec(
          `INSERT OR IGNORE INTO agent_members (agent_id, email) VALUES (?, ?)`,
          id,
          email
        );
      }
      this.ctx.storage.sql.exec(
        `UPDATE agents SET allowed_emails = ?, updated_at = ? WHERE id = ?`,
        emails.join("\n"),
        Date.now(),
        id
      );
    });
  }

  /**
   * Every agent, or — given an email — only the ones that address may open.
   *
   * Two ways onto the list, and both are an index lookup: the address administers the
   * agent, or it is one of the agent's members. An admin sees the agent they made
   * whether or not they are also on its access list — administering one you cannot
   * open is the ordinary case now that the two are separate.
   *
   * The match is exact on both sides. Addresses are stored already lowercased and
   * trimmed, by `normalizeEmails` on the way in, so there is nothing to normalize
   * here beyond the address being asked about.
   */
  list(email?: string): AgentRow[] {
    this.ensureSchema();
    if (email === undefined) {
      return this.ctx.storage.sql
        .exec(
          `SELECT id, name, created_at, updated_at, allowed_emails, admin_email,
                  fleet_id, fleet_name FROM agents
           ORDER BY created_at`
        )
        .toArray() as unknown as AgentRow[];
    }
    const wanted = email.trim().toLowerCase();
    if (!wanted) return [];
    // A `UNION` of the two ways on, rather than one `WHERE x OR EXISTS (…)`.
    //
    // They return the same rows, but SQLite cannot use an index for an `OR` across
    // two tables — it falls back to scanning every agent and running the subquery per
    // row, which is the walk this table exists to remove. Split in two, each half is
    // an index lookup: `idx_agents_admin_email` for the left, `idx_agent_members_email`
    // for the right. `UNION` is the deduplicating one, which is what keeps an admin
    // who is also on the access list from appearing twice.
    return this.ctx.storage.sql
      .exec(
        `SELECT a.id, a.name, a.created_at, a.updated_at, a.allowed_emails, a.admin_email,
                a.fleet_id, a.fleet_name
           FROM agents a
          WHERE a.admin_email = ?1
          UNION
         SELECT a.id, a.name, a.created_at, a.updated_at, a.allowed_emails, a.admin_email,
                a.fleet_id, a.fleet_name
           FROM agents a
           JOIN agent_members m ON m.agent_id = a.id
          WHERE m.email = ?1
          ORDER BY created_at`,
        wanted
      )
      .toArray() as unknown as AgentRow[];
  }

  /**
   * One page of the agents `email` sees on the home page, excluding the agents
   * inside fleets it administers.
   *
   * Those are left out because a fleet is read as a fleet: it is listed once, by
   * name and size, and its agents are only fetched when it is opened. Pouring a
   * thousand of them into this page would push everything else off the end of a
   * list that is meant to be a handful of doors.
   *
   * What is never left out is an agent you are a *member* of, fleet or not. To its
   * member it is simply their agent — the fleet is how it is administered, which is
   * a different matter — and an agent somebody has to go looking for inside a
   * collapsed fleet is one they will assume was never made. That includes a fleet
   * you administer yourself and put your own address in: it shows up here as yours,
   * and again inside the fleet as one of its agents, because it is both.
   */
  listPage(email: string, limit = 0, cursor = "", filter?: MetadataFilter): AgentPage {
    this.ensureSchema();
    const wanted = email.trim().toLowerCase();
    if (!wanted) return { agents: [], has_more: false, cursor: "" };
    const size = this.pageSize(limit);
    const after = decodeCursor(cursor);
    const meta = metadataClause(filter);
    // One row more than asked for: whether there is another page is then a fact
    // about this query rather than a second count over the whole list.
    const rows = this.ctx.storage.sql
      .exec(
        `SELECT * FROM (
           SELECT a.id, a.name, a.created_at, a.updated_at, a.allowed_emails,
                  a.admin_email, a.fleet_id, a.fleet_name, a.metadata
             FROM agents a
            WHERE a.admin_email = ? AND a.fleet_id = ''
            UNION
           SELECT a.id, a.name, a.created_at, a.updated_at, a.allowed_emails,
                  a.admin_email, a.fleet_id, a.fleet_name, a.metadata
             FROM agents a
             JOIN agent_members m ON m.agent_id = a.id
            WHERE m.email = ?
         ) a
         WHERE ${meta.sql}
           AND ((? = 0 AND ? = '') OR a.created_at > ? OR (a.created_at = ? AND a.id > ?))
         ORDER BY a.created_at, a.id
         LIMIT ?`,
        wanted,
        wanted,
        ...meta.args,
        after?.created_at ?? 0,
        after?.id ?? "",
        after?.created_at ?? 0,
        after?.created_at ?? 0,
        after?.id ?? "",
        size + 1
      )
      .toArray() as unknown as (AgentRow & { metadata: string })[];
    return this.page(rows.map(withoutMetadata), size);
  }

  /**
   * One page of the agents `email` may message as a guest: guests switched on, and
   * either no guest list (anyone signed in) or `email` on it.
   */
  listGuestPage(email: string, limit = 0, cursor = "", filter?: MetadataFilter): AgentPage {
    this.ensureSchema();
    const wanted = email.trim().toLowerCase();
    if (!wanted) return { agents: [], has_more: false, cursor: "" };
    const size = this.pageSize(limit);
    const after = decodeCursor(cursor);
    const meta = metadataClause(filter);
    const rows = this.ctx.storage.sql
      .exec(
        `SELECT a.id, a.name, a.created_at, a.updated_at, a.admin_email
           FROM agents a
          WHERE a.guests = 1
            AND (NOT EXISTS (SELECT 1 FROM agent_guests g WHERE g.agent_id = a.id)
                 OR EXISTS (SELECT 1 FROM agent_guests g WHERE g.agent_id = a.id AND g.email = ?))
            AND ${meta.sql}
            AND ((? = 0 AND ? = '') OR a.created_at > ? OR (a.created_at = ? AND a.id > ?))
          ORDER BY a.created_at, a.id
          LIMIT ?`,
        wanted,
        ...meta.args,
        after?.created_at ?? 0,
        after?.id ?? "",
        after?.created_at ?? 0,
        after?.created_at ?? 0,
        after?.id ?? "",
        size + 1
      )
      .toArray() as unknown as { id: string; name: string; created_at: number; updated_at: number; admin_email: string }[];
    // A guest learns the agent's name and nothing about who else is on it.
    return this.page(
      rows.map((r) => ({ ...r, allowed_emails: "", admin_email: "", fleet_id: "", fleet_name: "" })),
      size
    );
  }

  /** Mirror an agent's guest switch and list, as the registry holds them. */
  setGuests(id: string, guests: number, guestEmails: string) {
    this.ensureSchema();
    const emails = splitEmails(guestEmails);
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(`DELETE FROM agent_guests WHERE agent_id = ?`, id);
      for (const email of emails) {
        this.ctx.storage.sql.exec(
          `INSERT OR IGNORE INTO agent_guests (agent_id, email) VALUES (?, ?)`,
          id,
          email
        );
      }
      this.ctx.storage.sql.exec(`UPDATE agents SET guests = ? WHERE id = ?`, guests ? 1 : 0, id);
    });
  }

  /**
   * The fleets `email` administers, each with the number of agents in it.
   *
   * Not paged. A fleet is one create call, so this is a list of decisions somebody
   * made by hand — tens of rows where the agents under them are thousands — and it
   * is the counts, not the agents, that this page is built from.
   */
  listFleets(email: string): FleetRow[] {
    this.ensureSchema();
    const wanted = email.trim().toLowerCase();
    if (!wanted) return [];
    return this.ctx.storage.sql
      .exec(
        `SELECT fleet_id, MIN(fleet_name) AS fleet_name, COUNT(*) AS agents,
                MIN(created_at) AS created_at
           FROM agents
          WHERE admin_email = ? AND fleet_id <> ''
          GROUP BY fleet_id
          ORDER BY created_at`,
        wanted
      )
      .toArray() as unknown as FleetRow[];
  }

  /** One page of the agents inside a fleet, oldest first — the order they were made in. */
  listFleetPage(fleetId: string, limit = 0, cursor = ""): AgentPage {
    this.ensureSchema();
    if (!fleetId) return { agents: [], has_more: false, cursor: "" };
    const size = this.pageSize(limit);
    const after = decodeCursor(cursor);
    const rows = this.ctx.storage.sql
      .exec(
        `SELECT id, name, created_at, updated_at, allowed_emails, admin_email,
                fleet_id, fleet_name
           FROM agents
          WHERE fleet_id = ?1
            AND ((?2 = 0 AND ?3 = '')
                 OR created_at > ?2
                 OR (created_at = ?2 AND id > ?3))
          ORDER BY created_at, id
          LIMIT ?4`,
        fleetId,
        after?.created_at ?? 0,
        after?.id ?? "",
        size + 1
      )
      .toArray() as unknown as AgentRow[];
    return this.page(rows, size);
  }

  /**
   * The settings a fleet was created with, and that agents added to it are created
   * holding. Null when the fleet was never given any.
   */
  fleetMeta(fleetId: string): string {
    this.ensureSchema();
    const row = this.ctx.storage.sql
      .exec(`SELECT json FROM fleet_meta WHERE fleet_id = ? LIMIT 1`, fleetId)
      .toArray()[0] as { json: string } | undefined;
    return row?.json ?? "";
  }

  /** Write the fleet's settings. The document is stored whole, as the dialog sends it. */
  setFleetMeta(fleetId: string, json: string): void {
    this.ensureSchema();
    if (!fleetId) return;
    this.ctx.storage.sql.exec(
      `INSERT INTO fleet_meta (fleet_id, json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(fleet_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`,
      fleetId,
      json,
      Date.now()
    );
  }

  /** Forget a fleet's settings, once the last of its agents is gone. */
  removeFleetMeta(fleetId: string): void {
    this.ensureSchema();
    this.ctx.storage.sql.exec(`DELETE FROM fleet_meta WHERE fleet_id = ?`, fleetId);
  }

  /** Cut the extra row a page query asks for, and turn it into the cursor. */
  private page(rows: AgentRow[], size: number): AgentPage {
    const has_more = rows.length > size;
    const agents = has_more ? rows.slice(0, size) : rows;
    return {
      agents,
      has_more,
      cursor: has_more && agents.length ? encodeCursor(agents[agents.length - 1]) : "",
    };
  }

  get(id: string): AgentRow | undefined {
    this.ensureSchema();
    return this.ctx.storage.sql
      .exec(
        `SELECT id, name, created_at, updated_at, allowed_emails, admin_email,
                fleet_id, fleet_name FROM agents
         WHERE id = ? LIMIT 1`,
        id
      )
      .toArray()[0] as unknown as AgentRow | undefined;
  }

  /**
   * `adminEmail` is the address that made the agent. It is the only time it is ever
   * written: there is no route that changes it, because an agent whose administrator
   * can be handed over is one that can be taken.
   *
   * It falls back to the first address on the access list, which is what an unguarded
   * deployment — where there is no signed-in caller to name — has to go on.
   */
  create(
    id: string,
    name: string,
    allowedEmails: string,
    adminEmail: string,
    fleet?: { id: string; name: string },
    metadata: Record<string, string> = {}
  ): AgentRow {
    this.ensureSchema();
    const now = Date.now();
    const admin = adminEmail.trim().toLowerCase() || firstEmail(allowedEmails);
    const fleetId = fleet?.id ?? "";
    const fleetName = fleet?.name ?? "";
    this.ctx.storage.sql.exec(
      `INSERT INTO agents (id, name, created_at, updated_at, allowed_emails, admin_email,
                           fleet_id, fleet_name, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      name,
      now,
      now,
      allowedEmails,
      admin,
      fleetId,
      fleetName,
      JSON.stringify(metadata)
    );
    // The row is in; this puts the same addresses in `agent_members` beside it.
    this.writeMembers(id, allowedEmails);
    return {
      id,
      name,
      created_at: now,
      updated_at: now,
      allowed_emails: allowedEmails,
      admin_email: admin,
      fleet_id: fleetId,
      fleet_name: fleetName,
    };
  }

  /**
   * Replace the access list. The caller keeps their own address on it: a user who
   * could edit themselves out would lock everyone, themselves included, out of an
   * agent that only they could have unlocked. The admin is untouched either way —
   * it is not part of this list and is never rewritten.
   */
  setAllowedEmails(id: string, allowedEmails: string) {
    this.ensureSchema();
    this.writeMembers(id, allowedEmails);
  }

  rename(id: string, name: string) {
    this.ensureSchema();
    this.ctx.storage.sql.exec(
      `UPDATE agents SET name = ?, updated_at = ? WHERE id = ?`,
      name,
      Date.now(),
      id
    );
  }

  /**
   * Note that an agent was used, at most once every `TOUCH_INTERVAL`.
   *
   * This runs on every message, and it is the only *write* the hot path makes to the
   * directory — one object, one thread, for the whole deployment. A row write is also
   * about a thousand times the cost of a row read, so skipping the ones that would
   * change nothing anybody can see is the cheapest win available here.
   *
   * Nothing is lost by coarsening it. `list()` orders agents by `created_at`, so this
   * column decides no ordering at all; it is the "last used" date the home page
   * shows, and a few minutes of lag in a date is invisible. Session ordering is a
   * different column in a different object — `SessionRegistry.touch` — and is left
   * exact, because the sidebar really does reorder on it after every turn.
   */
  touch(id: string) {
    this.ensureSchema();
    const now = Date.now();
    const row = this.ctx.storage.sql
      .exec(`SELECT updated_at FROM agents WHERE id = ? LIMIT 1`, id)
      .toArray()[0] as { updated_at: number } | undefined;
    if (!row) return;
    if (now - row.updated_at < TOUCH_INTERVAL) return;
    this.ctx.storage.sql.exec(`UPDATE agents SET updated_at = ? WHERE id = ?`, now, id);
  }

  /**
   * One page of agents, as this deployment sizes them: the caller's ask, or
   * `agent_page` when it did not ask, clamped to `max_agent_page` either way.
   *
   * Read off the settings here rather than taken as a parameter because this object is
   * the one holding them — no hop, and no caller that could get it wrong.
   */
  private pageSize(limit: number): number {
    const settings = this.settings();
    const asked = Number.isFinite(limit) && limit > 0 ? limit : settings.agent_page;
    return Math.min(Math.max(1, Math.trunc(asked)), settings.max_agent_page);
  }

  /**
   * The deployment's own knobs, complete — or `SettingsIncompleteError` naming what
   * is not set yet. There are no shipped values to fill a gap with; see `settings.ts`.
   *
   * Every other object reads this through `deploymentSettings` in `settings.ts`,
   * which caches it per isolate — this method is one RPC hop and gets called on paths
   * that run per turn.
   */
  settings(): DeploymentSettings {
    return completeSettings(this.storedSettings());
  }

  /** The document as stored, complete or not. What the admin CLI reads and edits. */
  storedSettings(): StoredSettings {
    this.ensureSchema();
    const row = this.ctx.storage.sql
      .exec(`SELECT json FROM deployment_settings WHERE id = 1`)
      .toArray()[0] as { json: string } | undefined;
    return parseStoredSettings(String(row?.json ?? ""));
  }

  /**
   * Merge a patch into the stored document and return it, with what is still unset.
   *
   * Validation happens here rather than in the route so the stored document cannot be
   * made invalid by any caller, and so the merge and the cross-field checks
   * (`message_page` against `max_message_page`) see the same state.
   *
   * A rejection comes back as `{ error }` rather than as a throw. A thrown
   * `SettingsError` crossing a Durable Object RPC boundary arrives at the Worker as a
   * plain `Error`, so the route could not tell a value it should answer 400 for from a
   * failure it should answer 500 for — and answering 500 to "that number is too big"
   * is the difference between a dialog that can be corrected and one that looks broken.
   */
  setSettings(
    patch: unknown
  ): { settings: StoredSettings; missing: string[] } | { error: string } {
    this.ensureSchema();
    let next: StoredSettings;
    try {
      next = validateSettingsPatch(patch, this.storedSettings());
    } catch (err) {
      if (err instanceof SettingsError) return { error: err.message };
      throw err;
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO deployment_settings (id, json, updated_at) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`,
      JSON.stringify(next),
      Date.now()
    );
    return { settings: next, missing: missingSettings(next) };
  }

  /**
   * Drop the stored document. Not routed: with nothing to fall back to, this leaves
   * the deployment refusing every request, so it is for tests of exactly that.
   */
  clearSettings(): void {
    this.ensureSchema();
    this.ctx.storage.sql.exec(`DELETE FROM deployment_settings WHERE id = 1`);
  }

  /**
   * How many agents `email` may administer — itself included.
   *
   * The deployment's `default_agent_limit` unless the owner has raised this one
   * account, which is what `account_limits` holds: absence is the ordinary case.
   */
  getAgentLimit(email: string): number {
    this.ensureSchema();
    const wanted = email.trim().toLowerCase();
    const row = this.ctx.storage.sql
      .exec(`SELECT agent_limit FROM account_limits WHERE email = ? LIMIT 1`, wanted)
      .toArray()[0] as { agent_limit: number } | undefined;
    return row?.agent_limit ?? this.settings().default_agent_limit;
  }

  /**
   * Set how many agents `email` may administer. This is what "business account" is:
   * there is no separate flag, only a raised ceiling — a row here at all is the mark
   * of one. Only ever called from the owner's own admin route.
   */
  setAgentLimit(email: string, limit: number) {
    this.ensureSchema();
    const wanted = email.trim().toLowerCase();
    this.ctx.storage.sql.exec(
      `INSERT INTO account_limits (email, agent_limit) VALUES (?, ?)
       ON CONFLICT(email) DO UPDATE SET agent_limit = excluded.agent_limit`,
      wanted,
      limit
    );
  }

  /** How many agents `email` currently administers — the count `getAgentLimit` bounds. */
  countByAdmin(email: string): number {
    this.ensureSchema();
    const wanted = email.trim().toLowerCase();
    const row = this.ctx.storage.sql
      .exec(`SELECT COUNT(*) AS n FROM agents WHERE admin_email = ?`, wanted)
      .toArray()[0] as { n: number } | undefined;
    return row?.n ?? 0;
  }

  /**
   * The whole admin dashboard in one query: how many accounts, agents and sessions
   * the deployment holds. Sessions come from the cached per-agent counter rather
   * than from the session registries, which is what keeps this to a single read.
   */
  counts(): {
    users: number;
    agents: number;
    sessions: number;
    business_accounts: number;
    open_requests: number;
  } {
    this.ensureSchema();
    const row = this.ctx.storage.sql
      .exec(
        `SELECT
           (SELECT COUNT(*) FROM agents) AS agents,
           (SELECT COUNT(*) FROM account_limits) AS business_accounts,
           (SELECT COUNT(*) FROM business_requests) AS open_requests,
           (SELECT COALESCE(SUM(MAX(session_count, 0)), 0) FROM agents) AS sessions,
           (SELECT COUNT(*) FROM (
              SELECT admin_email AS email FROM agents WHERE admin_email != ''
              UNION
              SELECT email FROM agent_members
            )) AS users`
      )
      .toArray()[0] as
      | {
          users: number;
          agents: number;
          sessions: number;
          business_accounts: number;
          open_requests: number;
        }
      | undefined;
    return {
      users: row?.users ?? 0,
      agents: row?.agents ?? 0,
      sessions: row?.sessions ?? 0,
      business_accounts: row?.business_accounts ?? 0,
      open_requests: row?.open_requests ?? 0,
    };
  }

  /**
   * One page of every address the deployment knows — each admin and each member — in
   * email order, narrowed to those containing `query` when there is one. Admin CLI only.
   *
   * `cursor` is the last email of the previous page: the list is keyed on the address
   * itself, so a user added mid-scroll cannot make a page skip or repeat a row.
   */
  listUsers(limit = 20, cursor = "", query = ""): UserPage {
    this.ensureSchema();
    const size = Math.max(1, Math.min(limit, 100));
    const rows = this.ctx.storage.sql
      .exec(
        `SELECT u.email AS email,
                (SELECT COUNT(*) FROM agents a WHERE a.admin_email = u.email) AS agents
           FROM (SELECT admin_email AS email FROM agents WHERE admin_email != ''
                 UNION
                 SELECT email FROM agent_members) u
          WHERE u.email > ? AND instr(u.email, ?) > 0
          ORDER BY u.email ASC LIMIT ?`,
        cursor,
        query.trim().toLowerCase(),
        size + 1
      )
      .toArray() as unknown as { email: string; agents: number }[];
    const page = rows.slice(0, size);
    return {
      users: page,
      has_more: rows.length > size,
      cursor: rows.length > size ? page[page.length - 1].email : "",
    };
  }

  /**
   * One address's view for the admin CLI: its agent limit, and every agent it
   * administers or may open, with that agent's session count.
   */
  userDetail(email: string): UserDetail {
    this.ensureSchema();
    const wanted = email.trim().toLowerCase();
    const rows = this.ctx.storage.sql
      .exec(
        `SELECT id, name, admin_email, MAX(session_count, 0) AS sessions FROM agents
          WHERE admin_email = ?
             OR id IN (SELECT agent_id FROM agent_members WHERE email = ?)
          ORDER BY created_at ASC, id ASC`,
        wanted,
        wanted
      )
      .toArray() as unknown as { id: string; name: string; admin_email: string; sessions: number }[];
    return {
      email: wanted,
      agent_limit: this.getAgentLimit(wanted),
      agents: rows.map((r) => ({
        id: r.id,
        name: r.name,
        role: r.admin_email === wanted ? "admin" : "member",
        sessions: r.sessions,
      })),
    };
  }

  /** Agents whose session count has never been measured — the backfill `counts()` needs. */
  unmeasuredAgents(): string[] {
    this.ensureSchema();
    const rows = this.ctx.storage.sql
      .exec(`SELECT id FROM agents WHERE session_count < 0`)
      .toArray() as unknown as { id: string }[];
    return rows.map((r) => r.id);
  }

  /** Record how many sessions an agent has, after one was created, forked or deleted. */
  setSessionCount(id: string, count: number) {
    this.ensureSchema();
    this.ctx.storage.sql.exec(
      `UPDATE agents SET session_count = ? WHERE id = ?`,
      Math.max(0, count),
      id
    );
  }

  /** Every address that administers or may open at least one agent. Admin stats only. */
  distinctUsers(): number {
    this.ensureSchema();
    const row = this.ctx.storage.sql
      .exec(
        `SELECT COUNT(*) AS n FROM (
           SELECT admin_email AS email FROM agents WHERE admin_email != ''
           UNION
           SELECT email FROM agent_members
         )`
      )
      .toArray()[0] as { n: number } | undefined;
    return row?.n ?? 0;
  }

  /** How many accounts have a raised agent limit — the deployment's business accounts. */
  businessAccounts(): number {
    this.ensureSchema();
    const row = this.ctx.storage.sql
      .exec(`SELECT COUNT(*) AS n FROM account_limits`)
      .toArray()[0] as { n: number } | undefined;
    return row?.n ?? 0;
  }

  /** Every agent's admin's raised limit, keyed by email — for the stats route to join against `list()`. */
  agentLimits(): Record<string, number> {
    this.ensureSchema();
    const rows = this.ctx.storage.sql
      .exec(`SELECT email, agent_limit FROM account_limits`)
      .toArray() as unknown as { email: string; agent_limit: number }[];
    return Object.fromEntries(rows.map((r) => [r.email, r.agent_limit]));
  }

  remove(id: string) {
    this.ensureSchema();
    // The member rows go too. Nothing else points at them, so one left behind would
    // be invisible for good — and would put the agent back on somebody's list if its
    // id were ever reused.
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(`DELETE FROM agent_members WHERE agent_id = ?`, id);
      this.ctx.storage.sql.exec(`DELETE FROM agent_guests WHERE agent_id = ?`, id);
      this.ctx.storage.sql.exec(`DELETE FROM agents WHERE id = ?`, id);
    });
  }

  /** File a request to raise `email`'s agent limit by `increase`. Returns the queued row. */
  fileBusinessRequest(email: string, increase: number): BusinessRequest {
    this.ensureSchema();
    const row: BusinessRequest = {
      id: crypto.randomUUID().replace(/-/g, "").slice(0, 8),
      email: email.trim().toLowerCase(),
      requested_increase: increase,
      created_at: Date.now(),
    };
    this.ctx.storage.sql.exec(
      `INSERT INTO business_requests (id, email, requested_increase, created_at) VALUES (?, ?, ?, ?)`,
      row.id,
      row.email,
      row.requested_increase,
      row.created_at
    );
    return row;
  }

  /**
   * One page of open requests, oldest first, each carrying what the owner needs to
   * decide: the limit it would raise and how many agents that account already runs.
   *
   * Paged rather than returned whole because the queue has no ceiling — anyone signed
   * in can file one. `cursor` is keyset on `created_at`, with `id` breaking ties, so a
   * request filed mid-scroll cannot make the page skip or repeat a row.
   */
  listBusinessRequests(limit = 20, cursor = ""): BusinessRequestPage {
    this.ensureSchema();
    const size = Math.max(1, Math.min(limit, 100));
    const [afterTime, afterId] = cursor.split(":");
    const after = cursor && Number.isFinite(Number(afterTime))
      ? { created_at: Number(afterTime), id: afterId ?? "" }
      : undefined;
    // One row past the page: its existence is all `has_more` needs.
    const rows = (
      after
        ? this.ctx.storage.sql.exec(
            `SELECT id, email, requested_increase, created_at FROM business_requests
             WHERE created_at > ? OR (created_at = ? AND id > ?)
             ORDER BY created_at ASC, id ASC LIMIT ?`,
            after.created_at,
            after.created_at,
            after.id,
            size + 1
          )
        : this.ctx.storage.sql.exec(
            `SELECT id, email, requested_increase, created_at FROM business_requests
             ORDER BY created_at ASC, id ASC LIMIT ?`,
            size + 1
          )
    ).toArray() as unknown as BusinessRequest[];
    const page = rows.slice(0, size).map((r) => ({
      ...r,
      current_limit: this.getAgentLimit(r.email),
      current_agents: this.countByAdmin(r.email),
    }));
    const last = page[page.length - 1];
    return {
      requests: page,
      has_more: rows.length > size,
      cursor: rows.length > size && last ? `${last.created_at}:${last.id}` : "",
    };
  }

  /** Drop a request without acting on it — the owner declined it. */
  deleteBusinessRequest(id: string) {
    this.ensureSchema();
    this.ctx.storage.sql.exec(`DELETE FROM business_requests WHERE id = ?`, id);
  }

  /**
   * Grant a request: fold its increase into the account's limit, then remove it from
   * the queue. Undefined when the request is already gone — resolved, or raced by a
   * second click — so the route can tell the caller nothing happened.
   */
  approveBusinessRequest(id: string): { email: string; agent_limit: number } | undefined {
    this.ensureSchema();
    const row = this.ctx.storage.sql
      .exec(`SELECT email, requested_increase FROM business_requests WHERE id = ? LIMIT 1`, id)
      .toArray()[0] as { email: string; requested_increase: number } | undefined;
    if (!row) return undefined;
    const agent_limit = this.getAgentLimit(row.email) + row.requested_increase;
    this.ctx.storage.transactionSync(() => {
      this.setAgentLimit(row.email, agent_limit);
      this.ctx.storage.sql.exec(`DELETE FROM business_requests WHERE id = ?`, id);
    });
    return { email: row.email, agent_limit };
  }
}

/** One page of the deployment's addresses, with the cursor that continues it. */
export type UserPage = {
  users: { email: string; agents: number }[];
  has_more: boolean;
  cursor: string;
};

/** One address as the admin CLI shows it. */
export type UserDetail = {
  email: string;
  agent_limit: number;
  agents: { id: string; name: string; role: "admin" | "member"; sessions: number }[];
};

/** One page of pending asks, with the cursor that continues it. */
export type BusinessRequestPage = {
  requests: (BusinessRequest & { current_limit: number; current_agents: number })[];
  has_more: boolean;
  cursor: string;
};

/** A pending ask to raise one account's agent limit, waiting on the owner. */
export type BusinessRequest = {
  id: string;
  email: string;
  requested_increase: number;
  created_at: number;
};
