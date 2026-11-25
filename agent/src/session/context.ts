import { COMPACTION_PREFIX } from "agents/experimental/memory/utils";
import { jsonSchema, type ModelMessage, tool, type ToolSet } from "ai";
import {
  capabilityInstructions,
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
import { attachmentsOf, insertAttachment, latestFiles, sharedFiles } from "./attachments";
import { COMMAND_TOOL_NAME, commandTool } from "./command-tool";
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
import { type SearchDocument } from "./search";
import type { Attachment, SessionHost } from "./types";

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
  parts.push(...capabilityInstructions(host.config()));
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
  // Each server's own guide to its tools: tool descriptions say what one call does, not
  // the order a task takes, and a weaker model guesses that order wrong without it.
  for (const server of connected) {
    if (!server.instructions.trim()) continue;
    parts.push(
      `How to use the ${server.name} tools, from that server:\n\n${server.instructions.trim()}`
    );
  }
  // Said once here rather than as today's date, which would change the prompt and break
  // the cache every day: the time travels on each message instead (see `sentAt`).
  parts.push(
    "Each user message starts with when it was sent, in UTC, like [Sent 2026-01-31 14:05 UTC]. Use it as the current date and time."
  );
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
  /** The last reply's tool notes, waiting for the user message after it (see `toolNotesOf`). */
  let notes = "";
  for (const message of kept) {
    let text = message.id.startsWith(COMPACTION_PREFIX)
      ? `${SUMMARY_PREAMBLE}\n\n${textOf(message)}`
      : textOf(message);
    if (message.role === "assistant") {
      notes = toolNotesOf(message);
      if (text.trim()) messages.push({ role: "assistant", content: text });
      continue;
    }
    const stamp = sentAt(host, message.id);
    if (stamp) text = `${stamp}\n${text}`;
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
      ...(notes ? [{ type: "text" as const, text: notes }] : []),
      ...uploads.map((note) => ({ type: "text" as const, text: note })),
      // Its text stays out of the conversation: search_files finds the passages a
      // question needs, so a long PDF is not resent with every later turn.
      ...parsed.map((p) => ({
        type: "text" as const,
        text: `--- ${p.name} has been read and is searchable: use search_files to find the passages you need, or to read it part by part ---`,
      })),
      ...parts,
    ];
    notes = "";
    messages.push(
      content.length === 1 ? { role: "user", content: text } : { role: "user", content }
    );
  }
  if (notes) messages.push({ role: "user", content: notes });
  return messages;
}

/**
 * When a user message was sent, as `[Sent YYYY-MM-DD HH:MM UTC]`, from the time its turn
 * opened. Fixed per message, so earlier turns render the same and stay cached. Empty for
 * a message with no recorded time (a compaction summary).
 */
export function sentAt(host: SessionHost, messageId: string): string {
  const ts = host.exec<{ ts: number }>(`SELECT ts FROM usage WHERE message_id = ?`, messageId)[0]
    ?.ts;
  if (!ts) return "";
  const iso = new Date(ts).toISOString();
  return `[Sent ${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC]`;
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
        // A weaker model can call one tool with the same arguments round after round,
        // never reading the result, until the turn's rounds run out. A repeat is refused
        // as a failure, so three in a row end the turn with an explanation.
        const call = `${spec.name}(${stableJson(args)})`;
        if (host.turn.calls.includes(call)) {
          host.turn.failedCalls.push(toolCallId);
          return `Tool ${spec.name} failed: it was already called with exactly these arguments in this turn, and its result is above. Do not call it again with the same arguments: use that result and go on to the next step.`;
        }
        const result = await runTool(spec.name, args as Record<string, unknown>, context, spec);
        // Returned, so the SDK records a result; `failedInARow` needs to know it failed.
        if (!result.ok) host.turn.failedCalls.push(toolCallId);
        else host.turn.calls.push(call);
        return result.content;
      },
    });
  }
  // Always offered: it is how the agent knows about, and operates, itself.
  tools[COMMAND_TOOL_NAME] = commandTool(host);
  return tools;
}

/** JSON with object keys sorted, so the same arguments in another order read the same. */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v
  );
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

/** A step that must answer in words. */
type ForcedAnswer = { toolChoice: "none"; instructions: string; activeTools?: string[] };

/**
 * A forced answer is sent no tools at all, not only a ban on calling them: a model that
 * still sees its tools writes the call out as text in its own markup (DeepSeek's DSML,
 * GLM's `<tool_call>`). Anthropic is left as it was: it refuses a request whose history
 * holds tool calls but which defines no tools, and it does not write calls out.
 */
function noTools(host: SessionHost): { activeTools?: string[] } {
  return host.config().model.startsWith("anthropic/") ? {} : { activeTools: [] };
}

/**
 * Once tools have failed `MAX_FAILED_TOOL_CALLS` times running, the next step may not call
 * any: a model repeating one mistake otherwise spends every tool round and answers nothing.
 */
export function stopAfterFailures(
  host: SessionHost,
  steps: readonly StepParts[]
): ForcedAnswer | undefined {
  const failed = failedInARow(host, steps);
  if (failed < MAX_FAILED_TOOL_CALLS) return undefined;
  return {
    ...noTools(host),
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
): ForcedAnswer | undefined {
  if (stepNumber < maxSteps - 1) return undefined;
  host.turn.outOfRounds = true;
  return {
    ...noTools(host),
    toolChoice: "none",
    instructions: `${systemPrompt(host)}\n\nThis is the last step of this turn: do not call any more tools. Answer now with what you have found so far, say plainly what is still left to do, and tell the user they can say "continue" to carry on.`,
  };
}

/**
 * The chat's readable documents for `search_files`: text files (uploaded, or kept by a
 * tool such as a video transcript), voice-note transcripts, and parsed PDFs. Pending
 * uploads are left out until their message is sent.
 */
export async function chatDocuments(host: SessionHost): Promise<SearchDocument[]> {
  const rows = host.exec<Attachment>(
    `SELECT * FROM attachments WHERE used = 1 AND kind IN ('text', 'pdf') ORDER BY ts ASC`
  );
  const texts = rows
    .filter((a) => a.kind === "text" && a.text.trim())
    .map((a) => ({ name: a.name, text: a.text }));
  const pdfs = await parsedDocuments(
    host,
    rows.filter((a) => a.kind === "pdf")
  );
  return [...texts, ...pdfs.map((p) => ({ name: p.name, text: p.text }))];
}

/** Passages per embedding request. */
const EMBED_BATCH = 64;

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Embed texts with the deployment's embedding model, billed to the agent's key. */
async function embed(host: SessionHost, model: string, texts: string[]): Promise<number[][]> {
  const res = await fetch("https://openrouter.ai/api/v1/embeddings", {
    method: "POST",
    headers: {
      authorization: `Bearer ${host.openrouterKey()}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ model, input: texts }),
  });
  if (!res.ok) throw new Error(`embeddings ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = (await res.json()) as {
    data?: { embedding?: number[]; index?: number }[];
    usage?: { cost?: number };
  };
  // Spent on this turn's search, so it is this turn's cost.
  if (typeof json.usage?.cost === "number") host.usage().reported += json.usage.cost;
  const data = json.data ?? [];
  if (data.length !== texts.length) throw new Error("embeddings came back short");
  return [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((d) => d.embedding ?? []);
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/**
 * How close in meaning each text is to the query, from -1 to 1. A passage is embedded
 * once and its vector kept in this session; only the query is embedded on every search.
 * Null when embedding fails, so search falls back to words alone rather than failing.
 */
export async function similarities(
  host: SessionHost,
  query: string,
  texts: string[]
): Promise<number[] | null> {
  const model = host.settings().embedding_model;
  try {
    const keys = await Promise.all(texts.map(async (t) => `${model}:${await sha256(t)}`));
    const vectors = new Map<string, number[]>();
    for (const key of new Set(keys)) {
      const row = host.exec<{ vector: string }>(
        `SELECT vector FROM embeddings WHERE key = ?`,
        key
      )[0];
      if (row) vectors.set(key, JSON.parse(row.vector) as number[]);
    }
    const missing = [...new Set(keys)].filter((k) => !vectors.has(k));
    const textOf = new Map(keys.map((k, i) => [k, texts[i]]));
    const batches: string[][] = [];
    for (let i = 0; i < missing.length; i += EMBED_BATCH) {
      batches.push(missing.slice(i, i + EMBED_BATCH));
    }
    const [queryVector, ...embedded] = await Promise.all([
      embed(host, model, [query]).then((v) => v[0]),
      ...batches.map((batch) =>
        embed(
          host,
          model,
          batch.map((k) => textOf.get(k)!)
        )
      ),
    ]);
    batches.forEach((batch, b) =>
      batch.forEach((key, i) => {
        vectors.set(key, embedded[b][i]);
        host.exec(
          `INSERT OR REPLACE INTO embeddings (key, vector) VALUES (?, ?)`,
          key,
          JSON.stringify(embedded[b][i])
        );
      })
    );
    return keys.map((k) => cosine(queryVector, vectors.get(k) ?? []));
  } catch (err) {
    console.error(`search embeddings failed: ${err instanceof Error ? err.message : err}`);
    return null;
  }
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
    sharedFiles: () => sharedFiles(host),
    documents: () => chatDocuments(host),
    similarities: (query, texts) => similarities(host, query, texts),
    latestFiles: () => latestFiles(host),
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
