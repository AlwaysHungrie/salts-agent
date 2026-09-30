import type { Migration } from "../schema";

/**
 * A session's own tables, in the order they were introduced.
 *
 * Step 0 is the baseline: the schema as it stood before this file had a ladder. It is
 * written idempotently because every existing session already has these tables and
 * will run it once anyway. Append below it; do not edit it.
 */
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
      // What OpenRouter's file parser made of a PDF, so the same PDF is parsed once per
      // session instead of once per turn. The parse output itself is a workspace file:
      // it carries the document's text and a base64 image per page, which is far too
      // large to want in a SQLite row.
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
    // Compaction. `context_tokens` is the largest prompt one model call in the turn
    // sent, which is what a context window is measured against — `prompt_tokens` is
    // summed across tool rounds. `compaction` holds the one summary the model reads in
    // place of a run of older messages; the transcript itself is never touched.
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
    // The id an MCP server handed back for an attachment's bytes, so a file goes to a
    // server once per session rather than once per turn. Keyed on the URL too: a server
    // pointed somewhere new has never seen the file.
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
