import type { McpAuth } from "../mcp";
import type { SettableConfigKey } from "../settings";

/**
 * One agent's settings: tuning (how it talks) and capabilities (`cap_*` plus their
 * credentials). One typed column each in a single-row table; integers stand in for
 * booleans. Keys are stored in plain text, deliberately for now (see README).
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
   * The owner's notes: `private_notes` only the model reads; `public_notes` guests see
   * before starting (and the model is told). Longer than `system_prompt` on purpose.
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
   * The agent's own OpenRouter key, billed for every call. No fallback: blank means the
   * agent cannot answer, which keeps the deployment's credit out of reach.
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
   * The WhatsApp Business Account: not used to send, but the account the Meta app is
   * subscribed to on every save.
   */
  whatsapp_waba_id: string;
  /** System-user token with `whatsapp_business_messaging`. Sends every reply. */
  whatsapp_access_token: string;
  /** The Meta app's secret. Every inbound delivery's signature is checked against it. */
  whatsapp_app_secret: string;
  /** Chosen by the owner, pasted into Meta's callback settings. Must match exactly. */
  whatsapp_verify_token: string;
  /**
   * The one number this agent answers, in international form. A single required value,
   * not a whitelist, so there is no empty state meaning "everyone".
   */
  whatsapp_number: string;
};

/**
 * Per-agent columns every agent starts blank on. The model and `SETTABLE_CONFIG_KEYS`
 * come from the deployment's `default_model` and `config_defaults`.
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
 * Meta settings: what the agent should be set to by default, what it may be offered and
 * what is locked. Applying writes them into `Config`; turns read only `Config`.
 */
export type MetaSettings = {
  /**
   * Models the settings page may offer, typed in (empty = the deployment's list). Each
   * carries its own `vision`, since only whoever adds an id can say.
   */
  models: ModelChoice[];
  /** Default tuning values. A key that is absent keeps the factory default. */
  defaults: Partial<Pick<Config, MetaTunableKey>>;
  /** Capability ids and config columns the agent's own pages may not show or change. */
  locked: string[];
  /** Per capability: whether it starts on, and what its fields start out holding. */
  capabilities: Record<string, MetaCapability>;
  /**
   * Replacement menus for fixed-choice fields (image and transcription models), by column.
   * Empty leaves the deployment's menu.
   */
  field_options: Record<string, string[]>;
  mcp: {
    /** Template ids offered on the capabilities page, out of the catalogue. Empty means every one. */
    templates: string[];
    /** Templates from whoever provisioned the agent, replacing the deployment's `mcp_catalog`. */
    catalog: McpCatalogEntry[];
    /** Servers added to the agent when the defaults are applied, matched by name. */
    servers: MetaMcpServer[];
    /**
     * Whether the agent's own pages may add, rename, repoint or remove servers. Off suits an
     * agent handed to someone else: they can still use, tune and connect what they were given.
     */
    user_servers: boolean;
  };
  /**
   * Monthly model spend ceiling in USD (0 = none). Over the ceiling, new turns are refused
   * rather than cut off mid-answer.
   */
  monthly_spend_limit: number;
  /**
   * Ceiling on the agent's access list (0 = only the deployment's `max_members`): the
   * administrator's say over how far a fleet agent's user may share it.
   */
  member_limit: number;
};

/** One MCP provider tile: an optional SVG `icon`, else a mark from `letter` and `color`. */
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
 * A model an agent may use, and whether it accepts images. `label` names it (brackets in it
 * are nicknames for `!model`); without one it is labelled from the catalogue.
 */
export type ModelChoice = { id: string; vision: boolean; label?: string };

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

/** An MCP server the agent is created with. OAuth is still approved per server. */
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
  /** The forum topic within the chat, or empty for the whole chat (one session per topic). */
  chat_thread_id: string;
};

/** One page of the session list, plus the cursor that continues it. */
export type SessionPage = {
  sessions: SessionRow[];
  has_more: boolean;
  /** Pass back as `cursor` for the next page. Empty when the list is exhausted. */
  cursor: string;
};

/**
 * One agent's access row. `seeded` = 0 means not yet copied from the directory; it is
 * stripped before anything is returned.
 */
export type AccessRow = {
  allowed_emails: string;
  admin_email: string;
  seeded: number;
  /**
   * Guests may start, read, continue and delete their own sessions, nothing else. With
   * `guests` on, an empty `guest_emails` means any signed-in address.
   */
  guests: number;
  guest_emails: string;
};

/** An agent: a bot, its settings, its MCP servers, its memories, its sessions. */
export type AgentRow = {
  id: string;
  name: string;
  created_at: number;
  updated_at: number;
  /**
   * Who may open this agent: newline-separated lowercase emails. By email because agents
   * are shared before people sign in.
   */
  allowed_emails: string;
  /**
   * The address that administers the agent (its creator): owns the meta document and
   * deletion, set once. Not membership: an admin off the list cannot open the agent.
   */
  admin_email: string;
  /** The fleet this agent was created in, or '' when it stands alone. */
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

export type MetadataFilter = { with?: [string, string]; without?: string };

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
