import type { Migration } from "../schema";

/** A session's migration ladder. Step 0 is the idempotent baseline; append, never edit. */
export const SESSION_AGENT_MIGRATIONS: readonly Migration[] = [
  {
    name: "baseline",
    up: (sql) => {
      sql.exec(
        `CREATE TABLE IF NOT EXISTS attachments (
           id TEXT PRIMARY KEY,
           kind TEXT NOT NULL,
           name TEXT NOT NULL,
           mime TEXT NOT NULL,
           text TEXT NOT NULL DEFAULT '',
           path TEXT NOT NULL DEFAULT '',
           thumb_path TEXT NOT NULL DEFAULT '',
           bytes INTEGER NOT NULL DEFAULT 0,
           ts INTEGER NOT NULL,
           used INTEGER NOT NULL DEFAULT 0
         )`
      );
      sql.exec(
        `CREATE TABLE IF NOT EXISTS message_files (
           message_id TEXT NOT NULL,
           attachment_id TEXT NOT NULL,
           PRIMARY KEY (message_id, attachment_id)
         )`
      );
      // What the user actually typed. The message Think stores also names the files the
      // turn carried, and that annotation is for the model, not for the chat bubble.
      sql.exec(
        `CREATE TABLE IF NOT EXISTS message_text (
           message_id TEXT PRIMARY KEY,
           text TEXT NOT NULL
         )`
      );
      // One row per assistant message: what the turn spent, which Think does not track.
      sql.exec(
        `CREATE TABLE IF NOT EXISTS usage (
           message_id TEXT PRIMARY KEY,
           prompt_tokens INTEGER NOT NULL DEFAULT 0,
           completion_tokens INTEGER NOT NULL DEFAULT 0,
           cost_usd REAL NOT NULL DEFAULT 0,
           ms INTEGER NOT NULL DEFAULT 0,
           ts INTEGER NOT NULL DEFAULT 0
         )`
      );
      // The PDF parse cache, so a document is parsed once per session. The text is a workspace
      // file, too large for a row.
      sql.exec(
        `CREATE TABLE IF NOT EXISTS file_cache (
           attachment_id TEXT PRIMARY KEY,
           path TEXT NOT NULL,
           ts INTEGER NOT NULL
         )`
      );
    },
  },
  {
    // `context_tokens` is a turn's largest single prompt (what the window is measured
    // against); `compaction` holds the one summary overlay.
    name: "compaction",
    up: (sql) => {
      sql.exec(`ALTER TABLE usage ADD COLUMN context_tokens INTEGER NOT NULL DEFAULT 0`);
      sql.exec(
        `CREATE TABLE compaction (
           id INTEGER PRIMARY KEY CHECK (id = 1),
           from_id TEXT NOT NULL,
           to_id TEXT NOT NULL,
           summary TEXT NOT NULL,
           ts INTEGER NOT NULL
         )`
      );
    },
  },
  {
    // Upload ids an MCP server returned, so a file goes to a server once per session. Keyed
    // on the URL too: a repointed server has never seen the file.
    name: "mcp_uploads",
    up: (sql) => {
      sql.exec(
        `CREATE TABLE mcp_uploads (
           attachment_id TEXT NOT NULL,
           server_id TEXT NOT NULL,
           url TEXT NOT NULL,
           upload_id TEXT NOT NULL,
           ts INTEGER NOT NULL,
           PRIMARY KEY (attachment_id, server_id, url)
         )`
      );
    },
  },
];
