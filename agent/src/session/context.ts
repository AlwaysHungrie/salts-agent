import { COMPACTION_PREFIX } from "agents/experimental/memory/utils";
import { jsonSchema, type ModelMessage, tool, type ToolSet } from "ai";
import {
  capabilityLabels,
  channelLabels,
  enabled,
  mcpServerReady,
  mcpToolSpecs,
  runTool,
  type ToolContext,
  toolsFor,
} from "../capabilities";
import type { Config } from "../registry";
import { base64ToBytes } from "../util/bytes";
import { attachmentsOf, insertAttachment } from "./attachments";
import { sendVoiceNote } from "./channels";
import { compactedMessages } from "./compaction";
import {
  ensureParsed,
  fileParts,
  mcpUploadNotes,
  parsedDocuments,
  uploadAttachment,
} from "./documents";
import { isPdf, isSheet, isTextLike, safeName, uploadPath } from "./files";
import { inWords, textOf, toolNotesOf } from "./format";
import { transcribeAttachment } from "./transcribe";
import type { SessionHost } from "./types";

/** What the model is told a compaction summary is, ahead of the summary itself. */
export const SUMMARY_PREAMBLE =
  "[Summary of the earlier part of this conversation, which was compacted to save context. The messages it covers are no longer shown.]";

export function systemPrompt(host: SessionHost): string {
  // The deployment's line first. Blank is the owner choosing to say nothing.
  const deployment = host.settings().system_prompt.trim();
  const parts = deployment ? [deployment] : [];
  // The name comes from renaming the agent, so it is kept outside the editable instructions.
  const name = host.config().agent_name.trim();
  const custom = host.config().system_prompt.trim();
  const instructions = [...(name ? [`Your name is ${name}.`] : []), ...(custom ? [custom] : [])];
  if (instructions.length > 0) parts.push(instructions.join("\n"));
  // The owner's notes: the brief only the model sees, then what the person talking
  // to it was shown before starting, so it knows exactly what they have read.
  const privateNotes = (host.config().private_notes ?? "").trim();
  if (privateNotes) parts.push(privateNotes);
  const publicNotes = (host.config().public_notes ?? "").trim();
  if (publicNotes) {
    parts.push(`What the person you are talking with was shown before starting:\n\n${publicNotes}`);
  }
  if (host.memories().length > 0) {
    // Memories are injected rather than recalled by tool call, so the model can use
    // what it knows without spending a round trip to find out that it knows it.
    parts.push(
      `What you remember about this user:\n${host
        .memories()
        .map((m) => `- ${m.text}`)
        .join("\n")}`
    );
  }
  const ready = capabilityLabels(host.config());
  if (ready.length > 0) parts.push(`Capabilities available to you: ${ready.join(", ")}.`);
  // Channels are named apart from capabilities, with the limit spelled out: listed as a
  // capability, the model offered to message numbers it has no way to reach.
  const channels = channelLabels(host.config());
  if (channels.length > 0) {
    parts.push(
      `You are reachable on ${inWords(channels)}. Your reply goes back to the chat the message came from — you cannot start a conversation, and you cannot message any other number or account.`
    );
  }
  // A connected MCP server's tools are named after it, so naming the servers tells
  // the model which prefix belongs to which provider.
  const connected = enabled(host.config(), "mcp") ? host.mcpServers().filter(mcpServerReady) : [];
  if (connected.length > 0) {
    parts.push(
      `Connected MCP servers, whose tools are prefixed with their name: ${connected
        .map((s) => s.name)
        .join(", ")}.`
    );
  }
  parts.push(
    "Files the user attaches are written to the workspace under uploads/, and every message names the ones it carries. Open one with the read tool when the question is about it."
  );
  return parts.join("\n\n");
}

/**
 * The conversation as the model receives it, with files re-attached from the workspace at
 * turn time. `context_messages` keeps the last N (0 = all), counted after compaction.
 */
export async function modelMessages(host: SessionHost, config: Config): Promise<ModelMessage[]> {
  const all = await compactedMessages(host);
  const limit = config.context_messages;
  const kept = limit > 0 ? all.slice(-limit) : all;

  const messages: ModelMessage[] = [];
  for (const message of kept) {
    const text = message.id.startsWith(COMPACTION_PREFIX)
      ? `${SUMMARY_PREAMBLE}\n\n${textOf(message)}`
      : textOf(message);
    if (message.role === "assistant") {
      const notes = toolNotesOf(message);
      const content = notes ? `${text}\n\n${notes}`.trim() : text;
      if (content.trim()) messages.push({ role: "assistant", content });
      continue;
    }
    const attachments = attachmentsOf(host, message.id);
    // Parsed on the first turn that needs it, the way a clip is transcribed on the
    // first turn that needs its words.
    for (const a of attachments) await ensureParsed(host, a);
    const parsed = await parsedDocuments(host, attachments);
    const uploads = mcpUploadNotes(host, config, attachments);
    // A parsed PDF travels as its text; the file is sent only when there is no parse.
    const parts = await fileParts(host, attachments, new Set(parsed.map((p) => p.id)));
    const content = [
      { type: "text" as const, text },
      ...uploads.map((note) => ({ type: "text" as const, text: note })),
      ...parsed.map((p) => ({
        type: "text" as const,
        text: `--- contents of ${p.name} ---\n${p.text}`,
      })),
      ...parts,
    ];
    messages.push(
      content.length === 1 ? { role: "user", content: text } : { role: "user", content }
    );
  }
  return messages;
}

/**
 * The capability and MCP tools, wrapped for the AI SDK with their JSON Schema as-is.
 * They sit beside Think's own workspace tools.
 */
export function capabilityTools(host: SessionHost, config: Config): ToolSet {
  const context = toolContext(host, config);
  const tools: ToolSet = {};
  // The built-in capability tools, plus whatever the connected MCP servers offer.
  const specs = [
    ...toolsFor(config),
    ...(enabled(config, "mcp") ? mcpToolSpecs(host.mcpServers()) : []),
  ];
  for (const spec of specs) {
    tools[spec.name] = tool({
      description: spec.description,
      inputSchema: jsonSchema(spec.parameters as never),
      // A failure is returned rather than thrown, so the model reads what went
      // wrong and can correct itself on the next round.
      execute: async (args, { toolCallId }) => {
        const result = await runTool(spec.name, args as Record<string, unknown>, context, spec);
        // Returned, so the SDK records a result; `failedInARow` needs to know it failed.
        if (!result.ok) host.turn.failedCalls.push(toolCallId);
        return result.content;
      },
    });
  }
  return tools;
}

/** Tool calls that may fail in a row before the turn is made to stop and say so. */
export const MAX_FAILED_TOOL_CALLS = 3;

/** The parts of an AI SDK step this reads. */
type StepParts = { content: readonly { type: string; toolCallId?: string }[] };

/**
 * How many of the turn's latest tool calls failed one after another: an error the SDK
 * recorded (an unknown tool, bad input) or a failure one of our tools returned.
 */
export function failedInARow(host: SessionHost, steps: readonly StepParts[]): number {
  let run = 0;
  for (const part of steps.flatMap((s) => s.content)) {
    if (part.type === "tool-error") run++;
    else if (part.type === "tool-result")
      run = host.turn.failedCalls.includes(part.toolCallId ?? "") ? run + 1 : 0;
  }
  return run;
}

/**
 * Once tools have failed `MAX_FAILED_TOOL_CALLS` times running, the next step may not call
 * any: a model repeating one mistake otherwise spends every tool round and answers nothing.
 */
export function stopAfterFailures(
  host: SessionHost,
  steps: readonly StepParts[]
): { toolChoice: "none"; instructions: string } | undefined {
  const failed = failedInARow(host, steps);
  if (failed < MAX_FAILED_TOOL_CALLS) return undefined;
  return {
    toolChoice: "none",
    instructions: `${systemPrompt(host)}\n\n${failed} tool calls in a row have failed. Do not call any more tools this turn. Tell the user, briefly and in plain words, what you were trying to do and what went wrong (the errors the tools returned), and ask how they want to proceed.`,
  };
}

/**
 * The turn's last tool round may not call tools. The SDK ends a turn when its rounds run
 * out, and a model still calling tools then has done the work and answered nothing.
 */
export function answerOnLastRound(
  host: SessionHost,
  stepNumber: number,
  maxSteps: number
): { toolChoice: "none"; instructions: string } | undefined {
  if (stepNumber < maxSteps - 1) return undefined;
  return {
    toolChoice: "none",
    instructions: `${systemPrompt(host)}\n\nThis is the last step of this turn: do not call any more tools. Answer now with what you have found so far, say plainly what is still left to do, and tell the user they can say "continue" to carry on.`,
  };
}

export function toolContext(host: SessionHost, config: Config): ToolContext {
  return {
    config,
    settings: host.settings(),
    sessionId: host.name(),
    openrouterKey: host.openrouterKey(),
    registry: host.registry(),
    saveImage: async (dataUrl, prompt) => {
      const id = crypto.randomUUID().slice(0, 12);
      const mime = dataUrl.match(/^data:([^;]+)/)?.[1] ?? "image/png";
      const bytes = base64ToBytes(dataUrl.split(",", 2)[1] ?? "");
      const name = `${prompt.slice(0, 40) || "image"}.png`;
      const path = uploadPath(id, name);
      await host.workspace.writeFileBytes(path, bytes, mime);
      insertAttachment(host, {
        id,
        kind: "image",
        name,
        mime,
        text: prompt,
        path,
        thumb_path: "",
        bytes: bytes.byteLength,
      });
      // Marked used straight away: it belongs to the reply, not to the next turn.
      host.exec(`UPDATE attachments SET used = 1 WHERE id = ?`, id);
      host.turn.made.push(id);
      return `/agents/session-agent/${encodeURIComponent(host.name())}/files/${id}`;
    },
    saveFile: async (bytes, name, mime) => {
      const fileName = safeName(name);
      const settings = host.settings();
      const sheet = isSheet(mime, fileName);
      const pdf = !sheet && isPdf(mime, fileName);
      const text = !sheet && !pdf && (mime.startsWith("text/") || isTextLike(mime, fileName));
      if (!sheet && !pdf && !text) throw new Error(`${mime} files cannot be kept in the chat`);
      const limit = settings.max_upload_bytes[sheet ? "sheet" : pdf ? "pdf" : "text"];
      if (bytes.byteLength > limit) throw new Error(`it is larger than the ${limit} byte limit`);
      if (bytes.byteLength > (await host.registry().storageRoom(settings.max_agent_bytes))) {
        throw new Error("the agent's file storage is full");
      }
      const id = crypto.randomUUID().slice(0, 12);
      const path = uploadPath(id, fileName);
      await host.workspace.writeFileBytes(path, bytes, mime);
      insertAttachment(host, {
        id,
        kind: sheet ? "sheet" : pdf ? "pdf" : "text",
        name: fileName,
        mime,
        text: text ? new TextDecoder().decode(bytes).slice(0, settings.max_upload_bytes.text) : "",
        path,
        thumb_path: "",
        bytes: bytes.byteLength,
      });
      // Like a drawn image: it belongs to the reply, not to the next turn.
      host.exec(`UPDATE attachments SET used = 1 WHERE id = ?`, id);
      host.turn.made.push(id);
      return `/agents/session-agent/${encodeURIComponent(host.name())}/files/${id}`;
    },
    transcribeAttachment: (id) => transcribeAttachment(host, id),
    uploadAttachment: (server, id) => uploadAttachment(host, server, id),
    sendVoiceNote: (bytes) => sendVoiceNote(host, bytes),
    schedule: async (when, prompt) => {
      const task = await host.scheduleTask(when, prompt);
      host.turn.scheduled = true;
      return task;
    },
    listTasks: () => host.listTasks(),
    cancelTask: (id) => host.cancelTask(id),
  };
}
