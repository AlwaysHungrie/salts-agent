/**
 * Bang commands: things said to the session, not the model. Handled before any turn, so
 * they work in UI-less chats and in a wedged session.
 */

// TEMP — `oom` is a probe for the 128 MB isolate limit, not a feature. Remove it, and
// its branch in `runCommand`, once the behaviour it exposes has been seen.
export type Command =
  | "unstick"
  | "delete"
  | "new"
  | "clear"
  | "stop"
  | "compact"
  | "oom"
  | "help"
  | "docs"
  | "settings"
  | "mcp"
  | "model"
  | McpCommand
  | ModelCommand
  | DocsCommand;

/** `!mcp <name>`: switch that MCP server on if it is off, off if it is on. */
export type McpCommand = { server: string };

/** `!model <nickname>`: switch to the offered model whose label carries it in brackets. */
export type ModelCommand = { nickname: string };

/** `!docs <page>`: one user-guide page, by its slug. */
export type DocsCommand = { page: string };

/** Bare `!mcp` and `!model` list what there is; with an argument they act (see below). */
const COMMANDS = [
  "unstick",
  "delete",
  "new",
  "clear",
  "stop",
  "compact",
  "oom",
  "help",
  "docs",
  "settings",
  "mcp",
  "model",
] as const;

/**
 * A command's reply, and whether the session is finished. `destroy` depends on context:
 * `!clear` only ends a session that has a chat to hand over to.
 */
export type CommandResult = { text: string; destroy: boolean };

/**
 * The command a message is, if it is nothing but the command (so a sentence mentioning
 * `!delete` does not delete). A leading or trailing @mention is ignored.
 */
export function parseCommand(text: string): Command | null {
  const bare = text.replace(/@[A-Za-z0-9_]{3,}/g, " ").trim();
  const mcp = bare.match(/^!mcp\s+(.+)$/i);
  if (mcp) return { server: mcp[1].trim() };
  const model = bare.match(/^!model\s+(.+)$/i);
  if (model) return { nickname: model[1].trim() };
  const docs = bare.match(/^!docs\s+(.+)$/i);
  if (docs) return { page: docs[1].trim() };
  const found = COMMANDS.find((c) => bare.toLowerCase() === `!${c}`);
  return found ?? null;
}
