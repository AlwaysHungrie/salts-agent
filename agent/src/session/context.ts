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
import { ensureParsed, fileParts, mcpUploadNotes, parsedDocuments } from "./documents";
import { uploadPath } from "./files";
import { inWords, textOf } from "./format";
import { transcribeAttachment } from "./transcribe";
import type { SessionHost } from "./types";

/** What the model is told a compaction summary is, ahead of the summary itself. */
export const SUMMARY_PREAMBLE =
  "[Summary of the earlier part of this conversation, which was compacted to save context. The messages it covers are no longer shown.]";

export function systemPrompt(host: SessionHost): string {
  // The deployment's line first. Blank is the owner choosing to say nothing.
  const deployment = host.settings().system_prompt.trim();
  const parts = deployment ? [deployment] : [];
  // The name leads the custom instructions rather than living inside them: it is
  // set by renaming the agent, so it stays right when the name changes and cannot
  // be deleted by editing the instructions box.
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
  // Named apart from the capabilities, and with the limit spelled out. A channel is
  // how this conversation arrived, not a tool: the reply goes back the way the
  // message came, and nothing here can open a conversation with anyone else. Listed
  // among the capabilities it read as an ability, and the agent offered to send a
  // WhatsApp message to a number it was given — then reached for bash to do it.
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
 * The conversation as the model receives it. Think stores the words; the pictures
 * are put back here, read from the workspace at turn time rather than carried in
 * the transcript, so a session holding an 8MB PDF does not carry it in every row.
 *
 * A context window of N keeps only the last N messages, so a long session stops
 * growing its prompt — and its per-turn cost — without limit. 0 keeps everything.
 * The window is counted after compaction, so a summary counts as one message.
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
      if (text.trim()) messages.push({ role: "assistant", content: text });
      continue;
    }
    const attachments = attachmentsOf(host, message.id);
    // Parsed on the first turn that needs it, the way a clip is transcribed on the
    // first turn that needs its words.
    for (const a of attachments) await ensureParsed(host, a);
    const parsed = await parsedDocuments(host, attachments);
    const uploads = await mcpUploadNotes(host, config, attachments);
    // A PDF that has been parsed travels as its own words. The file itself is only
    // sent when there is no parse to send instead — a failed parse, or one that came
    // back empty — because carrying eight megabytes of base64 to a provider that
    // will only turn it back into this same text is work nobody needs done twice.
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
 * The capability tools, wrapped for the AI SDK. Their JSON Schema is reused as is,
 * so a tool added in `capabilities.ts` reaches the model with no work here. They
 * merge with Think's own workspace tools — read, write, edit, grep, bash.
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
      execute: async (args) =>
        (await runTool(spec.name, args as Record<string, unknown>, context, spec)).content,
    });
  }
  return tools;
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
      return `/agents/session-agent/${encodeURIComponent(host.name())}/files/${id}`;
    },
    transcribeAttachment: (id) => transcribeAttachment(host, id),
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
