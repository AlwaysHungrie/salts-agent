/**
 * Bang commands: things said to the session, not the model. Handled before any turn, so
 * they work in UI-less chats and in a wedged session.
 */

// TEMP — `oom` is a probe for the 128 MB isolate limit, not a feature. Remove it, and
// its branch in `runCommand`, once the behaviour it exposes has been seen.
export type Command =
  "unstick" | "delete" | "new" | "clear" | "stop" | "compact" | "oom" | McpCommand;

/** `!enable-mcp <name>` / `!disable-mcp <name>`: the one command that takes an argument. */
export type McpCommand = { mcp: "enable" | "disable"; server: string };

const COMMANDS = ["unstick", "delete", "new", "clear", "stop", "compact", "oom"] as const;

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
  const mcp = bare.match(/^!(enable|disable)-mcp\s+(.+)$/i);
  if (mcp) return { mcp: mcp[1].toLowerCase() as McpCommand["mcp"], server: mcp[2].trim() };
  const found = COMMANDS.find((c) => bare.toLowerCase() === `!${c}`);
  return found ?? null;
}
