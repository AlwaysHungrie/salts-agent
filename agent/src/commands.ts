/**
 * Bang commands: the few things you need to say to a session rather than to the model.
 *
 * They exist because the surfaces that need them most are the ones with no UI — a
 * Telegram chat has no "reset" button — and because a wedged session cannot answer a
 * question about itself. So they are handled before a turn is ever started, and behave
 * the same wherever they are typed.
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
  | McpCommand;

/** `!enable-mcp <name>` / `!disable-mcp <name>`: the one command that takes an argument. */
export type McpCommand = { mcp: "enable" | "disable"; server: string };

const COMMANDS = ["unstick", "delete", "new", "clear", "stop", "compact", "oom"] as const;

/**
 * What running a command produced: the line to say, and whether the session it ran in
 * is finished.
 *
 * `destroy` is separate from the command name because it is not decided by the name.
 * `!clear` only ends the session once the chat has somewhere else to go, and a
 * `!clear` in a browser session — which has no chat — does nothing at all.
 */
export type CommandResult = { text: string; destroy: boolean };

/**
 * The command a message is, or nothing if it is just a message.
 *
 * Only a message that is *nothing but* the command counts. Matching it anywhere in the
 * text would mean a sentence about `!delete` deletes the session, which is a bad way
 * to find out how the feature works. A leading or trailing @mention is allowed and
 * ignored: a group chat requires one to reach the bot at all.
 */
export function parseCommand(text: string): Command | null {
  const bare = text
    .replace(/@[A-Za-z0-9_]{3,}/g, " ")
    .trim();
  const mcp = bare.match(/^!(enable|disable)-mcp\s+(.+)$/i);
  if (mcp) return { mcp: mcp[1].toLowerCase() as McpCommand["mcp"], server: mcp[2].trim() };
  const found = COMMANDS.find((c) => bare.toLowerCase() === `!${c}`);
  return found ?? null;
}
