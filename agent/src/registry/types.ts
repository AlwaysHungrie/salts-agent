import type { McpAuth } from "../mcp";
import type { SettableConfigKey } from "../settings";

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

/** One page of the session list, plus the cursor that continues it. */
export type SessionPage = {
  sessions: SessionRow[];
  has_more: boolean;
  /** Pass back as `cursor` for the next page. Empty when the list is exhausted. */
  cursor: string;
};

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
