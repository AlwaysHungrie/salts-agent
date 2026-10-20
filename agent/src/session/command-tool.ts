import { jsonSchema, tool } from "ai";
import type { Command, CommandResult } from "../commands";
import { mcpList, modelList, runCommand } from "./commands";
import type { SessionHost } from "./types";

/**
 * The bang commands the model may run for the user. Left out: `stop` and `unstick`, which
 * exist for when a turn is wedged and so cannot be the turn's own doing; `delete`, which
 * only the user may ask for in so many words; and the `oom` probe.
 */
export const TOOL_COMMANDS = [
  "docs",
  "help",
  "settings",
  "mcp",
  "model",
  "new",
  "clear",
  "compact",
] as const;

type ToolCommand = (typeof TOOL_COMMANDS)[number];

/** These change the session the turn is running in, so they wait for the reply to be sent. */
const AFTER_REPLY = new Set<ToolCommand>(["new", "clear", "compact"]);

export const COMMAND_TOOL_NAME = "run_command";

/** The whole of what the model is told about operating itself: sent with every turn. */
export const COMMAND_TOOL_DESCRIPTION = [
  "Operate the Salts agent the user is talking to (you), the same as the user sending a `!command`.",
  "Use it when the user asks about Salts itself — setup, OpenRouter keys, Telegram/WhatsApp, MCP servers, salts-tools, models, limits, costs, commands — when they want one of these settings changed, or when their message looks like a mistyped command (e.g. `!setting`). Never answer a question about Salts from memory: read the guide first.",
  "",
  "Commands:",
  "- docs: the user guide's pages, one line each. docs <page>: that page in full; pick the page from the list.",
  "- help: the commands the user can send themselves.",
  "- settings: this agent's model, MCP servers, and the settings page link.",
  "- mcp: MCP servers and whether each is on. mcp <name> switches that server on if it is off and off if it is on, so only pass a name when the user asks to switch one.",
  "- model: models on offer by nickname. model <nickname> switches the agent from the next reply.",
  "- new / clear / compact: start a fresh session (clear deletes this one) or summarise this one. They run after your reply is sent, so say what is about to happen. Only when the user asks for it.",
].join("\n");

/**
 * The `run_command` tool. Commands answer at once, except those that change this very
 * session, which are queued on the turn and run by `runQueuedCommand` once it is over.
 */
export function commandTool(host: SessionHost) {
  return tool({
    description: COMMAND_TOOL_DESCRIPTION,
    inputSchema: jsonSchema<{ command: ToolCommand; argument?: string }>({
      type: "object",
      properties: {
        command: { type: "string", enum: [...TOOL_COMMANDS] },
        argument: {
          type: "string",
          description:
            "The page, MCP server name or model nickname, for the commands that take one.",
        },
      },
      required: ["command"],
      additionalProperties: false,
    }),
    execute: async ({ command, argument }) => (await commandForTool(host, command, argument)).text,
  });
}

/** What one `run_command` call does and says. */
export async function commandForTool(
  host: SessionHost,
  command: ToolCommand,
  argument?: string
): Promise<CommandResult> {
  const arg = argument?.trim() ?? "";
  if (command === "mcp") return await runCommand(host, arg ? { server: arg } : "mcp");
  if (command === "docs") return await runCommand(host, arg ? { page: arg } : "docs");
  if (command === "model") return await runCommand(host, arg ? { nickname: arg } : "model");
  if (command === "settings") {
    const parts = [await runCommand(host, "settings"), await modelList(host), await mcpList(host)];
    return { text: parts.map((p) => p.text).join("\n\n"), destroy: false };
  }
  if (AFTER_REPLY.has(command)) {
    if (command !== "compact" && !(await host.registry().get(host.sessionId()))?.chat_id) {
      return {
        text: "Not available here: this session is not tied to a Telegram or WhatsApp chat. The user starts a new session from the sidebar.",
        destroy: false,
      };
    }
    host.turn.after = command as Command;
    return {
      text: `Queued: \`${command}\` runs right after your reply is sent, and its result is sent to the user then. Tell them it is about to happen.`,
      destroy: false,
    };
  }
  return await runCommand(host, command as Command);
}

/**
 * The command a finished turn queued, run now that its reply is out. Dropped when the
 * turn did not complete or was stopped: the user did not get the reply that announced it.
 */
export async function runQueuedCommand(
  host: SessionHost,
  completed: boolean
): Promise<CommandResult | null> {
  const queued = host.turn.after;
  host.turn.after = null;
  if (!queued || !completed || host.turn.stoppedOnPurpose) return null;
  return await runCommand(host, queued);
}
