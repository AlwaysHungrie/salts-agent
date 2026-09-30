import { addColumnIfMissing, type Migration } from "../schema";

/** `ALTER TABLE` fragments for every column added after `config` first shipped. */
export const CONFIG_MIGRATIONS = [
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
 * WhatsApp's `config` columns, as their own rung: entries appended to `CONFIG_MIGRATIONS`
 * never reach objects that already ran the baseline. New columns go in new steps.
 */
export const WHATSAPP_CONFIG_COLUMNS = [
  `cap_whatsapp INTEGER NOT NULL DEFAULT 0`,
  `whatsapp_phone_number_id TEXT NOT NULL DEFAULT ''`,
  `whatsapp_access_token TEXT NOT NULL DEFAULT ''`,
  `whatsapp_app_secret TEXT NOT NULL DEFAULT ''`,
  `whatsapp_verify_token TEXT NOT NULL DEFAULT ''`,
  `whatsapp_number TEXT NOT NULL DEFAULT ''`,
];

/** One agent's migration ladder. Step 0 is the idempotent baseline; append, never edit. */
export const SESSION_REGISTRY_MIGRATIONS: readonly Migration[] = [
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
      ])
        addColumnIfMissing(sql, "sessions", col);
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
      // Monthly spend is a running total here, so the ceiling check is one row, not a scan of
      // every session. Storage bytes are likewise one agent-wide row (see `max_agent_bytes`).
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
      // Access lives in its own table, not on `config`, which the browser can read and patch:
      // the gate must not be reachable from what it guards.
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
      for (const col of [`disabled_tools TEXT NOT NULL DEFAULT ''`])
        addColumnIfMissing(sql, "mcp_servers", col);
    },
  },
  {
    name: "whatsapp delivery dedupe",
    up: (sql) => {
      // Meta retries slow webhooks, so the same `wamid` arrives repeatedly. Deduped here, at the
      // webhook, before a session exists, so concurrent first messages cannot create two.
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
      // `addColumnIfMissing`: objects created while these sat in `CONFIG_MIGRATIONS` have them.
      for (const col of WHATSAPP_CONFIG_COLUMNS) addColumnIfMissing(sql, "config", col);
    },
  },
  {
    name: "whatsapp waba id",
    up: (sql) => {
      // Added later: older agents have it blank and are asked for it in settings.
      addColumnIfMissing(sql, "config", `whatsapp_waba_id TEXT NOT NULL DEFAULT ''`);
    },
  },
  {
    name: "voice note columns",
    up: (sql) => {
      // Older agents get the capability off and the default voice model, as a new agent does.
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
