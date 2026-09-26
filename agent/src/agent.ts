import { createOpenAI } from "@ai-sdk/openai";
import { Workspace } from "@cloudflare/shell";
import { Think, type StepContext, type TurnConfig, type TurnContext } from "@cloudflare/think";
import type { Schedule } from "agents";
import {
  generateText,
  jsonSchema,
  tool,
  type ModelMessage,
  type ToolSet,
  type UIMessage,
} from "ai";
import { COMPACTION_PREFIX, createCompactFunction } from "agents/experimental/memory/utils";
import {
  capabilityLabels,
  channelLabels,
  mcpServerReady,
  mcpToolSpecs,
  enabled,
  withMcpAuth,
  runTool,
  toolsFor,
  type ScheduledTask,
  type ToolContext,
} from "./capabilities";
import { parseCommand, type Command, type CommandResult, type McpCommand } from "./commands";
import type { McpServerRow } from "./mcp";
import { applyMigrations, type Migration } from "./schema";
import { deploymentSettings, type DeploymentSettings } from "./settings";
import {
  AGENT_SEPARATOR,
  DEFAULT_CONFIG,
  agentIdOf,
  type AgentDirectory,
  type Config,
  type Memory,
  sessionLimitMessage,
  storageFullMessage,
  type SessionRegistry,
  type SessionRow,
} from "./registry";
import {
  openChannel,
  telegramInbound,
  whatsappInbound,
  type Channel,
  type ChannelFile,
  type ChannelInbound,
  type ChannelTarget,
} from "./channel";
import type { TelegramMessage } from "./telegram";
import type { WhatsappInbound } from "./whatsapp";

export type Env = {
  SessionAgent: DurableObjectNamespace<SessionAgent>;
  SessionRegistry: DurableObjectNamespace<SessionRegistry>;
  /** The index of which agents exist; a DO namespace cannot be enumerated. */
  AgentDirectory: DurableObjectNamespace<AgentDirectory>;
  /** Object storage the workspace spills large files into: images, PDFs, clips. */
  FILES: R2Bucket;
  /**
   * The impersonation back door, and nothing else.
   *
   * Present it as `x-api-secret` and the Worker takes the `x-user-email` beside it at
   * face value: any address, no sign-in, no proof, treated as that person for the
   * whole request. It is not an origin check and not a gate — the gate is a verified
   * Clerk token — so this is best understood as a master key to every identity in the
   * deployment rather than as a password for the API.
   *
   * Optional. Unset means the back door does not exist, which is the safe direction:
   * a deployment that forgets it loses impersonation, not its access control.
   */
  API_SECRET?: string;
  /**
   * The Clerk instance whose session tokens this Worker will verify, as the exact
   * `iss` those tokens carry: `https://<subdomain>.clerk.accounts.dev` on a
   * development instance, `https://clerk.<your-domain>` on a production one.
   *
   * Set it and a call arriving with a valid `Authorization: Bearer <session token>`
   * is identified by that token's own claims — a signature this Worker checks against
   * Clerk's published keys, which is the only identity here that cannot be asserted
   * by whoever holds `API_SECRET`. Unset, there is nothing to verify against and
   * every call falls back to the `x-user-email` header.
   */
  CLERK_ISSUER?: string;
  /** Telegram's API host. Only set to stand a local Bot API server in its place. */
  TELEGRAM_API_BASE?: string;

  /** Graph's host. Only set to point the channel at a stand-in. */
  WHATSAPP_API_BASE?: string;
};

/**
 * A file the user attached, or an image the agent drew. The bytes live in the Think
 * workspace — a virtual filesystem the model reads with its own tools — and this row
 * is the metadata the UI needs to draw the file and the turn needs to name it.
 */
export type Attachment = {
  id: string;
  kind: "text" | "image" | "pdf";
  name: string;
  mime: string;
  /** Extracted text for a text file, a transcript for audio, a prompt for an image. */
  text: string;
  /** Workspace path holding the bytes. */
  path: string;
  /** Workspace path of a PNG of a PDF's first page. Empty for everything else. */
  thumb_path: string;
  bytes: number;
  ts: number;
  /** 0 until the attachment has been sent with a turn. */
  used: number;
};

/** An attachment with its bytes, which is how one session hands a file to another. */
export type PackedAttachment = Attachment & { data: string; thumb: string };

/** A conversation prefix plus its files: what one session hands another on a fork. */
export type Snapshot = {
  messages: UIMessage[];
  attachments: PackedAttachment[];
  /** Which message carried which file, and what each question actually said. */
  links: { message_id: string; attachment_id: string }[];
  texts: { message_id: string; text: string }[];
  /** Files of the question the fork dropped: they return to the composer, unsent. */
  pending?: PackedAttachment[];
};

/**
 * One segment of an assistant turn, in the order it happened — what it said, and the
 * tools it ran between saying things. Derived from Think's message parts on read
 * rather than stored, so the transcript stays the framework's to own.
 */
export type TurnStep =
  | { kind: "text"; text: string }
  | { kind: "tools"; tools: { name: string; ok: boolean }[] };

/** The shape the frontend reads a transcript in. */
export type StoredMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  ts: number;
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd: number;
  ms: number;
  attachments: ReturnType<typeof publicAttachment>[];
  /** JSON array of `TurnStep`. Empty for user messages and for tool-free turns. */
  steps: string;
};

/**
 * One window of a transcript, newest-last, plus what the client needs to ask for the
 * window before it.
 */
export type TranscriptPage = {
  messages: StoredMessage[];
  /** Whether anything sits before this window. */
  has_more: boolean;
  /** How many messages precede the window. A fork's count is absolute, so it needs this. */
  offset: number;
  /** Messages in the whole transcript. */
  total: number;
};

/** A model the settings page may offer: what it is called, and whether it sees images. */
export type ModelOption = { id: string; label: string; vision: boolean };

/** The models this deployment offers: its `models` setting, copied. */
export function modelCatalog(settings: DeploymentSettings): ModelOption[] {
  return settings.models.map((m) => ({ ...m }));
}

/** Fallback per-token pricing, used when OpenRouter does not return a cost. */
const MODEL_FALLBACK_PRICE: Record<string, { prompt: number; completion: number }> = {
  "deepseek/deepseek-v4-flash": { prompt: 0.000000088606, completion: 0.000000177212 },
};

/** Asked once, on the first turn, to turn the opening exchange into a sidebar title. */
const TITLE_PROMPT =
  "Name this conversation in at most four words. Reply with the title only: no quotes, no punctuation at the end, no preamble.";

/**
 * What a scheduled task's user message is prefixed with. It is the only durable trace
 * of why a turn ran: an alarm submits the turn and returns, so the reply is written by
 * a later invocation that has nothing in memory to tell it who asked.
 */
const SCHEDULED_PREFIX = "[scheduled task] ";

/**
 * A pending task, reduced to what re-creating it needs. `when` is a cron expression
 * or an ISO timestamp — the two forms `scheduleTask` reads back.
 */
export type TaskHandover = { when: string; prompt: string };

const TEXT_EXTENSIONS =
  /\.(txt|md|markdown|csv|tsv|json|jsonl|ya?ml|toml|ini|log|html?|xml|css|jsx?|tsx?|py|rb|go|rs|java|kt|c|h|cpp|sh|sql)$/i;

/**
 * Which parser OpenRouter runs over a PDF. `mistral-ocr` is the one that reads scans
 * and keeps a table's shape, and it is billed per page — which is affordable only
 * because a document is parsed once per session and replayed after that.
 */
const PDF_PARSE_ENGINE = "mistral-ocr";

/** Where parses are kept: outside the workspace tree the model is shown. */
const PARSE_CACHE_DIR = ".parse-cache";

/** What the model is told a compaction summary is, ahead of the summary itself. */
const SUMMARY_PREAMBLE =
  "[Summary of the earlier part of this conversation, which was compacted to save context. The messages it covers are no longer shown.]";

/**
 * The words out of a parse. The content array interleaves text with a rendered image
 * per page; the images are dropped, which is most of the bytes and none of the meaning
 * for anything that reads.
 */
function annotationText(annotation: FileAnnotation): string {
  const content = annotation.file?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: "text"; text: string } =>
      typeof (part as { text?: unknown })?.text === "string" &&
      (part as { type?: string }).type === "text"
    )
    .map((part) => part.text)
    // A parse arrives one page per entry; the blank line keeps them from running on.
    .join("\n\n")
    .trim();
}

/** One parsed document as OpenRouter hands it back on the assistant delta. */
type FileAnnotation = { type: string; file?: { name?: string; hash?: string; content?: unknown } };

/** Where an attachment's bytes sit in the workspace. */
function uploadPath(id: string, name: string): string {
  return `uploads/${id}/${safeName(name)}`;
}

/** A file name the workspace can hold: no separators, no traversal, never empty. */
function safeName(name: string): string {
  const cleaned = name.replace(/[/\\]+/g, "_").replace(/^\.+/, "").trim();
  return cleaned.slice(0, 100) || "file";
}


/**
 * A session's own tables, in the order they were introduced.
 *
 * Step 0 is the baseline: the schema as it stood before this file had a ladder. It is
 * written idempotently because every existing session already has these tables and
 * will run it once anyway. Append below it; do not edit it.
 */
const SESSION_AGENT_MIGRATIONS: readonly Migration[] = [
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
];

export class SessionAgent extends Think<Env> {
  /**
   * Attachment bytes, and anything the model writes, live in one workspace, with R2
   * taking the large files off SQLite.
   */
  override workspace = new Workspace({
    sql: this.ctx.storage.sql,
    r2: this.env.FILES,
    name: () => this.name,
  });

  private schemaReady = false;
  private currentConfig: Config | undefined;
  /** The deployment's ceilings and defaults, re-read per turn beside the config. */
  private currentSettings: DeploymentSettings | undefined;
  private memories: Memory[] = [];
  /** The external MCP servers, reloaded per turn so a connection made mid-session works. */
  private mcpServers: McpServerRow[] = [];

  /**
   * Usage accumulated by `onStepFinish` for the turn that is running now. `peak` is the
   * largest single prompt, which is what compaction measures against.
   */
  private turnUsage = { prompt: 0, completion: 0, cached: 0, cost: 0, reported: 0, peak: 0, started: 0 };

  /**
   * Whether the turn running now scheduled a task. Read by the WhatsApp channel,
   * which owes the user a word about the 24-hour window whenever one is made.
   */
  private scheduledInTurn = false;

  /**
   * How many turns are running right now, and whether the last thing to happen to
   * them was `!stop`.
   *
   * Two messages a second apart are two turns inside one object, so this is a count
   * and not a flag. It is kept because `!stop` has to be able to say whether it
   * stopped anything: a chat has no spinner, and "Stopped." when nothing was running
   * is how you learn the command does not work.
   *
   * It is only ever approximately right, and deliberately so. A turn that dies
   * without reaching `onChatResponse` — an evicted isolate, a throw on the way in —
   * leaves its count behind. Both `!stop` and `!unstick` zero it rather than
   * decrementing, so a leak is corrected by the next use of either.
   */
  private turnsRunning = 0;

  /**
   * Set by `!stop`, cleared when the next question opens a turn. An aborted turn reads it to
   * tell the stop it was asked for from the one it was not: the first has already
   * been answered in the chat, the second still owes an explanation.
   */
  private stoppedOnPurpose = false;

  /**
   * The turn that is streaming right now, if there is one. Every event it has sent is
   * kept so a browser that reloaded mid-reply can be handed the reply from the start
   * and then follow the rest of it live; `listeners` are the connections doing that.
   *
   * It only lives in memory, which is the right lifetime: if the object is evicted the
   * turn dies with it, and there is nothing left to replay.
   */
  private live: {
    events: Record<string, unknown>[];
    listeners: Set<(event: Record<string, unknown>) => void>;
    closers: Set<() => void>;
  } | null = null;

  /**
   * The turn that just finished, and the id of the message it wrote.
   *
   * A reload races the end of a turn: the transcript is read a moment before the reply
   * is banked, and the reconnection arrives a moment after, so neither carries it. The
   * browser says which message it already has; if this is a later one, it is replayed
   * instead of being missed until the next reload.
   */
  private finished: { events: Record<string, unknown>[]; messageId: string } | null = null;

  /** The message id of the reply Think wrote last, learned in `onChatResponse`. */
  private lastReplyId = "";

  /** Record an event against the running turn and hand it to everyone attached. */
  private emit(event: Record<string, unknown>) {
    const live = this.live;
    if (!live) return;
    live.events.push(event);
    for (const listener of live.listeners) {
      try {
        listener(event);
      } catch {
        // A connection that has gone away is dropped when its stream is cancelled.
      }
    }
  }

  /** The turn is over: release everyone still attached, and keep it for a late reader. */
  private endLive() {
    const live = this.live;
    this.live = null;
    if (!live) return;
    if (this.lastReplyId) {
      this.finished = { events: live.events, messageId: this.lastReplyId };
    }
    for (const close of live.closers) {
      try {
        close();
      } catch {
        // Already closed.
      }
    }
  }

  /** A finished turn, sent down in one go so the browser can draw the reply it missed. */
  private replay(events: Record<string, unknown>[]): Response {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of events) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        }
        controller.close();
      },
    });
    return new Response(body, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
    });
  }

  /**
   * Attach to the turn that is running: the events it has already sent, then the ones
   * it sends from here on. 204 when nothing is in flight, which is what tells the
   * browser its transcript is already complete.
   */
  private attachLive(has = ""): Response {
    const live = this.live;
    if (!live) {
      // Nothing is running. The only thing worth sending is a turn that ended after
      // the browser read its transcript, which it names by the last reply it holds.
      const missed = this.finished;
      if (!missed || missed.messageId === has) return new Response(null, { status: 204 });
      return this.replay(missed.events);
    }

    const encoder = new TextEncoder();
    let listener: ((event: Record<string, unknown>) => void) | null = null;
    let closer: (() => void) | null = null;

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        let open = true;
        const write = (event: Record<string, unknown>) => {
          if (!open) return;
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          } catch {
            open = false;
          }
        };
        for (const event of live.events) write(event);
        listener = write;
        closer = () => {
          if (!open) return;
          open = false;
          try {
            controller.close();
          } catch {
            // Already closed.
          }
        };
        live.listeners.add(listener);
        live.closers.add(closer);
      },
      cancel() {
        if (listener) live.listeners.delete(listener);
        if (closer) live.closers.delete(closer);
      },
    });

    return new Response(body, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    });
  }

  private exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): T[] {
    return this.ctx.storage.sql.exec(query, ...(bindings as never[])).toArray() as T[];
  }

  /**
   * Think owns the transcript, so these tables hold only what it has no opinion
   * about: what an attachment is, which message carried it, and what a turn cost.
   *
   * The ladder is in `SESSION_AGENT_MIGRATIONS`; see schema.ts for why it is a ladder
   * and not a list of tolerated failures. Every session object runs it lazily, so a
   * new step reaches a session the first time that session is touched after deploy.
   */
  private ensureSchema() {
    if (this.schemaReady) return;
    applyMigrations(this.ctx, SESSION_AGENT_MIGRATIONS);
    this.schemaReady = true;
  }

  /* ----------------------------------------------------------------- config -- */

  /**
   * The agent this session belongs to, read out of the session's own name. A Durable
   * Object knows nothing about itself but that name, and the owner is encoded in it
   * precisely so this lookup needs nothing else — see `sessionName` in registry.ts.
   */
  private agentId(): string {
    return agentIdOf(this.name);
  }

  /**
   * This session's id as the registry stores it.
   *
   * `this.name` is the URL path segment the request was routed on, so a session whose
   * id holds a character `encodeURIComponent` rewrites arrives here encoded — a colon
   * becomes `%3A` — while the row was written under the raw id. Every lookup an object
   * makes about itself has to undo that, or it silently finds nothing: that is how a
   * WhatsApp session named `tg-wa:<number>` by `!new` came to drop every scheduled
   * message it produced. Ids generated now are URL-safe (see `safeChatId` in
   * registry.ts); this is what keeps the ones already stored working.
   */
  private sessionId(): string {
    try {
      return decodeURIComponent(this.name);
    } catch {
      // Not valid percent-encoding, so not a name this code wrote. Use it as it is.
      return this.name;
    }
  }

  private registry() {
    return this.env.SessionRegistry.get(this.env.SessionRegistry.idFromName(this.agentId()));
  }

  /**
   * Settings are read per turn rather than per boot: an object can live for days
   * between messages, and a stale temperature is a confusing thing to debug.
   */
  private async loadConfig() {
    this.currentSettings = await deploymentSettings(this.env);
    // Tool rounds per turn, re-read every turn: an object can live for days between
    // messages, and a ceiling raised yesterday should apply to today's turn.
    this.maxSteps = this.currentSettings.max_tool_rounds;
    this.currentConfig = await this.registry().config(
      this.currentSettings.default_model,
      this.currentSettings.config_defaults
    );
    this.memories = enabled(this.currentConfig, "memory")
      ? await this.registry().recall("", 50)
      : [];
    this.mcpServers = enabled(this.currentConfig, "mcp") ? await this.registry().mcpServers() : [];
  }

  /**
   * Whether the chosen model can be sent an image at all.
   *
   * The agent's own list answers first: a model named in meta settings was typed in
   * beside a checkbox saying whether it sees images, and that answer is about this
   * agent. Failing that, the deployment's catalogue. An id in neither is taken at its
   * word — refusing images to every model nobody wrote down would make image input
   * unusable for exactly the deployments that went and picked their own, and a model
   * that cannot see them fails at the call with OpenRouter's own message.
   *
   * Read here rather than in `loadConfig` because it is only ever needed when an
   * image actually turns up, and a turn of plain text should not pay for the lookup.
   */
  private async modelSeesImages(model: string): Promise<boolean> {
    const chosen = (await this.registry().meta()).models.find((m) => m.id === model);
    if (chosen) return chosen.vision;
    const known = modelCatalog(this.settings()).find((m) => m.id === model);
    return known ? known.vision : true;
  }

  private config(): Config {
    const settings = this.settings();
    return (
      this.currentConfig ?? {
        model: settings.default_model,
        ...settings.config_defaults,
        ...DEFAULT_CONFIG,
      }
    );
  }

  /**
   * The deployment's ceilings and defaults, as last read by `loadConfig` or
   * `settingsNow()`. There is nothing to stand in before that: every path that reads a
   * ceiling runs inside a turn or a request that loads them first, and one that does
   * not is a bug this throw makes loud.
   */
  private settings(): DeploymentSettings {
    if (!this.currentSettings) throw new Error("deployment settings read before they were loaded");
    return this.currentSettings;
  }

  /**
   * The settings, fetched if this object has not read them this turn.
   *
   * For the request paths that are not turns — an upload, a transcript page, a fork —
   * which enforce a ceiling without having loaded a config first.
   */
  private async settingsNow(): Promise<DeploymentSettings> {
    this.currentSettings = await deploymentSettings(this.env);
    return this.currentSettings;
  }

  /**
   * The key every model call is billed to: the agent's own, and only ever its own.
   *
   * There is no deployment-wide fallback. One used to exist, and it meant an agent
   * created by anyone at all could spend the deployment's own credit — which is the
   * whole bill, not a share of it — without its maker ever pasting a key. An agent
   * with no key of its own now simply cannot answer, and says so.
   *
   * Read per call rather than cached, because settings are reloaded each turn and a
   * key pasted mid-conversation should take effect at once.
   */
  private openrouterKey(): string {
    return this.config().openrouter_api_key;
  }

  private model(): string {
    return this.config().model;
  }

  /**
   * OpenRouter through the AI SDK's OpenAI-compatible client.
   *
   * Failed calls are logged with their body before the SDK sees them. OpenRouter
   * answers an upstream failure with "Provider returned error" and puts what actually
   * happened in `error.metadata.raw` — which is the only part worth reading, and the
   * part that never survives to the chat.
   */
  private openrouter() {
    const session = this.name;
    const self = this;
    const key = this.openrouterKey();
    // Said here rather than left to OpenRouter, which answers a blank key with a bare
    // 401 that reaches the chat as "Provider returned error" and names nothing the
    // person reading it could act on.
    if (!key) {
      throw new Error(
        "OpenRouter API key is missing. Add it in Settings."
      );
    }
    return createOpenAI({
      apiKey: key,
      baseURL: "https://openrouter.ai/api/v1",
      async fetch(input, init) {
        // Meta's terms bar WhatsApp content from reaching providers that train on it.
        const request = prepareOpenRouterRequest(init as RequestInit, session.includes(`${AGENT_SEPARATOR}wa-`));
        const res = await fetch(input as RequestInfo, request as RequestInit);
        if (res.ok) {
          return stripUnsupportedAnnotations(
            res,
            (files) => {
              // Writing the parse output outlives the stream, so it is handed to the
              // object's own lifetime rather than awaited inside the reader.
              self.ctx.waitUntil(self.cacheFileAnnotations(files));
            },
            (cost) => {
              self.turnUsage.reported += cost;
            }
          );
        }
        // An error body is small and not streamed, so reading it here is safe — but
        // it is consumed by the read, so the response has to be rebuilt for the SDK.
        const text = await res.text();
        console.error(`openrouter ${res.status} in session ${session}: ${text.slice(0, 2000)}`);
        return new Response(text, {
          status: res.status,
          statusText: res.statusText,
          headers: res.headers,
        });
      },
    });
  }

  /**
   * Calling the provider directly would build a Responses API model — the AI SDK's
   * default for OpenAI itself. OpenRouter's own surface is chat completions, and its
   * Responses endpoint covers only some of the models behind it, which is why a model
   * that works everywhere else can come back as "Provider returned error". `.chat()`
   * is the endpoint OpenRouter actually implements for every model it offers.
   */
  getModel() {
    return this.openrouter().chat(this.model());
  }

  getSystemPrompt() {
    return this.systemPrompt();
  }

  private systemPrompt(): string {
    // The deployment's line first. Blank is the owner choosing to say nothing.
    const deployment = this.settings().system_prompt.trim();
    const parts = deployment ? [deployment] : [];
    // The name leads the custom instructions rather than living inside them: it is
    // set by renaming the agent, so it stays right when the name changes and cannot
    // be deleted by editing the instructions box.
    const name = this.config().agent_name.trim();
    const custom = this.config().system_prompt.trim();
    const instructions = [...(name ? [`Your name is ${name}.`] : []), ...(custom ? [custom] : [])];
    if (instructions.length > 0) parts.push(instructions.join("\n"));
    if (this.memories.length > 0) {
      // Memories are injected rather than recalled by tool call, so the model can use
      // what it knows without spending a round trip to find out that it knows it.
      parts.push(
        `What you remember about this user:\n${this.memories.map((m) => `- ${m.text}`).join("\n")}`
      );
    }
    const ready = capabilityLabels(this.config());
    if (ready.length > 0) parts.push(`Capabilities available to you: ${ready.join(", ")}.`);
    // Named apart from the capabilities, and with the limit spelled out. A channel is
    // how this conversation arrived, not a tool: the reply goes back the way the
    // message came, and nothing here can open a conversation with anyone else. Listed
    // among the capabilities it read as an ability, and the agent offered to send a
    // WhatsApp message to a number it was given — then reached for bash to do it.
    const channels = channelLabels(this.config());
    if (channels.length > 0) {
      parts.push(
        `You are reachable on ${inWords(channels)}. Your reply goes back to the chat the message came from — you cannot start a conversation, and you cannot message any other number or account.`
      );
    }
    // A connected MCP server's tools are named after it, so naming the servers tells
    // the model which prefix belongs to which provider.
    const connected = enabled(this.config(), "mcp") ? this.mcpServers.filter(mcpServerReady) : [];
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
   * Every knob the settings page owns, applied per turn: model, prompt, sampling,
   * reply cap, reasoning effort, context window, and the capability tools that are
   * ready to run.
   */
  override async beforeTurn(_ctx: TurnContext): Promise<TurnConfig> {
    this.ensureSchema();
    await this.loadConfig();
    const config = this.config();
    this.turnUsage = { prompt: 0, completion: 0, cached: 0, cost: 0, reported: 0, peak: 0, started: Date.now() };
    this.scheduledInTurn = false;
    this.turnsRunning++;
    await this.maybeCompact(config);

    return {
      // Chat completions, not Responses: see `getModel`.
      model: this.openrouter().chat(config.model),
      instructions: this.systemPrompt(),
      tools: this.capabilityTools(config),
      temperature: config.temperature,
      ...(config.max_tokens > 0 ? { maxOutputTokens: config.max_tokens } : {}),
      ...(config.reasoning_effort !== "off"
        ? { providerOptions: { openai: { reasoningEffort: config.reasoning_effort } } }
        : {}),
      messages: await this.modelMessages(config),
    };
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
  private async modelMessages(config: Config): Promise<ModelMessage[]> {
    const all = await this.compactedMessages();
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
      const attachments = this.attachmentsOf(message.id);
      // Parsed on the first turn that needs it, the way a clip is transcribed on the
      // first turn that needs its words.
      for (const a of attachments) await this.ensureParsed(a);
      const parsed = await this.parsedDocuments(attachments);
      // A PDF that has been parsed travels as its own words. The file itself is only
      // sent when there is no parse to send instead — a failed parse, or one that came
      // back empty — because carrying eight megabytes of base64 to a provider that
      // will only turn it back into this same text is work nobody needs done twice.
      const parts = await this.fileParts(attachments, new Set(parsed.map((p) => p.id)));
      const content = [
        { type: "text" as const, text },
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
   * The words of every attachment that has been parsed, in message order. A row whose
   * file has gone missing is forgotten rather than repaired: the PDF is still on hand,
   * so the worst case is one more parse.
   */
  private async parsedDocuments(
    attachments: Attachment[]
  ): Promise<{ id: string; name: string; text: string }[]> {
    const found: { id: string; name: string; text: string }[] = [];
    for (const a of attachments) {
      if (a.kind !== "pdf") continue;
      const row = this.exec<{ path: string }>(
        `SELECT path FROM file_cache WHERE attachment_id = ?`,
        a.id
      )[0];
      if (!row?.path) continue;
      // Parses were once cached whole, as JSON. Those rows are dropped rather than
      // read: their contents are a payload, not a document, and putting one in front
      // of the model would be worse than parsing the PDF again.
      if (!row.path.endsWith(".txt")) {
        this.exec(`DELETE FROM file_cache WHERE attachment_id = ?`, a.id);
        await this.workspace.rm(row.path, { force: true });
        continue;
      }
      try {
        const text = await this.workspace.readFile(row.path);
        if (!text?.trim()) throw new Error("empty");
        found.push({ id: a.id, name: a.name, text });
      } catch {
        this.exec(`DELETE FROM file_cache WHERE attachment_id = ?`, a.id);
      }
    }
    return found;
  }

  /**
   * Parse a PDF once, the way a clip is transcribed once: on the first turn that needs
   * it, not at upload, so nothing stands between the user and sending their message.
   *
   * It takes its own request because OpenRouter does not return annotations on a
   * streamed completion — the parse only comes back on an ordinary one. The reply is
   * thrown away; what is wanted is the parse riding along with it, whose text stands
   * in for the document on this turn and every turn after it.
   */
  private async ensureParsed(attachment: Attachment): Promise<void> {
    if (attachment.kind !== "pdf") return;
    if (this.exec(`SELECT attachment_id FROM file_cache WHERE attachment_id = ?`, attachment.id)[0]) {
      return;
    }
    const base64 = await this.readBase64(attachment.path);
    if (!base64) return;

    try {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.openrouterKey()}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: this.model(),
          // One token is enough: the annotation is attached to the message either way,
          // and nothing here reads what the model actually said.
          max_tokens: 1,
          usage: { include: true },
          plugins: [{ id: "file-parser", pdf: { engine: PDF_PARSE_ENGINE } }],
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "." },
                {
                  type: "file",
                  file: {
                    filename: attachment.name,
                    file_data: `data:application/pdf;base64,${base64}`,
                  },
                },
              ],
            },
          ],
        }),
      });
      if (!res.ok) {
        console.error(`pdf parse ${res.status} for ${attachment.id}: ${(await res.text()).slice(0, 500)}`);
        return;
      }
      const json = (await res.json()) as {
        choices?: { message?: { annotations?: FileAnnotation[] } }[];
        usage?: { cost?: number };
      };
      // The parse is billed on this call, so it belongs to the turn that triggered it.
      if (typeof json.usage?.cost === "number") this.turnUsage.reported += json.usage.cost;

      const files = (json.choices?.[0]?.message?.annotations ?? []).filter((a) => a?.type === "file");
      if (files.length === 0) {
        console.error(`pdf parse returned no annotations for ${attachment.id}`);
        return;
      }
      await this.cacheFileAnnotations(files);
      console.log(
        `parsed ${attachment.name} (${attachment.id}) once with ${PDF_PARSE_ENGINE}, cost ${json.usage?.cost ?? "?"}`
      );
    } catch (err) {
      // A failed parse is not a failed turn: the PDF is still sent as a file, and the
      // only cost is that OpenRouter parses it again on the way through.
      console.error(`pdf parse failed for ${attachment.id}: ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * Keep what the parse actually said, against the attachment it came from.
   *
   * Only the text is kept. A parse also carries a rendered image per page, and those
   * are the bulk of it — worth nothing to a model that reads text, and worth their
   * weight in tokens to one that does not. The words are what a question about a
   * document is answered from.
   *
   * The annotation names the file and nothing else, so the newest PDF with that name
   * wins the match, and an annotation matching nothing is dropped.
   */
  private async cacheFileAnnotations(files: FileAnnotation[]): Promise<void> {
    for (const annotation of files) {
      const name = annotation.file?.name;
      if (!name) continue;
      const row = this.exec<{ id: string }>(
        `SELECT id FROM attachments WHERE kind = 'pdf' AND name = ? ORDER BY ts DESC LIMIT 1`,
        name
      )[0];
      if (!row) continue;
      if (this.exec(`SELECT attachment_id FROM file_cache WHERE attachment_id = ?`, row.id)[0]) continue;
      const text = annotationText(annotation);
      if (!text.trim()) {
        console.error(`pdf parse for ${row.id} carried no text`);
        continue;
      }
      // Kept out of `uploads/`, and out of any directory the read and list tools walk:
      // the parse is plumbing, and a model that finds it sitting beside the PDF will
      // open it, reason about it, and spend a turn's tool budget on a cache file.
      const path = `${PARSE_CACHE_DIR}/${row.id}.txt`;
      try {
        await this.workspace.writeFile(path, text, "text/plain");
        this.exec(
          `INSERT OR REPLACE INTO file_cache (attachment_id, path, ts) VALUES (?, ?, ?)`,
          row.id,
          path,
          Date.now()
        );
      } catch (err) {
        // Caching is an optimisation; failing to cache costs a re-parse, nothing more.
        console.error(`file cache write failed for ${row.id}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  /**
   * Images and PDFs as model content parts. They are sent with the message rather
   * than read through a tool: a tool result has to be text, so handing a page back
   * that way is not something an OpenAI-shaped API will accept.
   */
  private async fileParts(
    attachments: Attachment[],
    skip: Set<string> = new Set()
  ): Promise<
    ({ type: "image"; image: string } | { type: "file"; data: string; mediaType: string; filename: string })[]
  > {
    const parts: (
      | { type: "image"; image: string }
      | { type: "file"; data: string; mediaType: string; filename: string }
    )[] = [];
    for (const a of attachments) {
      if (a.kind !== "image" && a.kind !== "pdf") continue;
      if (skip.has(a.id)) continue;
      const base64 = await this.readBase64(a.path);
      if (!base64) continue;
      parts.push(
        a.kind === "image"
          ? { type: "image", image: `data:${a.mime};base64,${base64}` }
          : {
            type: "file",
            data: `data:application/pdf;base64,${base64}`,
            mediaType: "application/pdf",
            filename: a.name,
          }
      );
    }
    return parts;
  }

  /**
   * The capability tools, wrapped for the AI SDK. Their JSON Schema is reused as is,
   * so a tool added in `capabilities.ts` reaches the model with no work here. They
   * merge with Think's own workspace tools — read, write, edit, grep, bash.
   */
  private capabilityTools(config: Config): ToolSet {
    const context = this.toolContext(config);
    const tools: ToolSet = {};
    // The built-in capability tools, plus whatever the connected MCP servers offer.
    const specs = [
      ...toolsFor(config),
      ...(enabled(config, "mcp") ? mcpToolSpecs(this.mcpServers) : []),
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

  private toolContext(config: Config): ToolContext {
    return {
      config,
      settings: this.settings(),
      sessionId: this.name,
      openrouterKey: this.openrouterKey(),
      registry: this.registry(),
      saveImage: async (dataUrl, prompt) => {
        const id = crypto.randomUUID().slice(0, 12);
        const mime = dataUrl.match(/^data:([^;]+)/)?.[1] ?? "image/png";
        const bytes = base64ToBytes(dataUrl.split(",", 2)[1] ?? "");
        const name = `${prompt.slice(0, 40) || "image"}.png`;
        const path = uploadPath(id, name);
        await this.workspace.writeFileBytes(path, bytes, mime);
        this.insertAttachment({
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
        this.exec(`UPDATE attachments SET used = 1 WHERE id = ?`, id);
        return `/agents/session-agent/${encodeURIComponent(this.name)}/files/${id}`;
      },
      transcribeAttachment: (id) => this.transcribeAttachment(id),
      sendVoiceNote: (bytes) => this.sendVoiceNote(bytes),
      schedule: async (when, prompt) => {
        const task = await this.scheduleTask(when, prompt);
        this.scheduledInTurn = true;
        return task;
      },
      listTasks: () => this.listTasks(),
      cancelTask: (id) => this.cancelTask(id),
    };
  }

  /* ------------------------------------------------------------------ usage -- */

  /** Token counts arrive per step; a turn's cost is their sum. */
  override onStepFinish(step: StepContext): void {
    const prompt = step.usage?.inputTokens ?? 0;
    const completion = step.usage?.outputTokens ?? 0;
    const cached = cachedPromptTokens(step);
    this.turnUsage.prompt += prompt;
    this.turnUsage.completion += completion;
    this.turnUsage.cached += cached;
    this.turnUsage.peak = Math.max(this.turnUsage.peak, prompt);
    this.turnUsage.cost += this.priceOf(prompt, completion, openrouterCost(step));
    // The one number that says whether the breakpoint is doing anything. A cache that
    // quietly stopped matching — a tool list that reordered, a memory written mid
    // conversation — costs full price and looks exactly like a cache that is working.
    if (prompt > 0) {
      console.log(`session ${this.name}: prompt ${prompt} tokens, ${cached} from cache`);
    }
  }

  /**
   * The turn is over: bank what it spent against the assistant message Think just
   * wrote, and name the session if this was its first exchange.
   */
  override async onChatResponse(result: {
    message: UIMessage;
    status: "completed" | "error" | "aborted";
  }): Promise<void> {
    this.ensureSchema();
    this.turnsRunning = Math.max(0, this.turnsRunning - 1);
    this.lastReplyId = result.message.id;
    this.exec(
      `INSERT OR REPLACE INTO usage (message_id, prompt_tokens, completion_tokens, cost_usd, ms, ts, context_tokens)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      result.message.id,
      this.turnUsage.prompt,
      this.turnUsage.completion,
      this.turnCost(),
      this.turnUsage.started ? Date.now() - this.turnUsage.started : 0,
      Date.now(),
      this.turnUsage.peak
    );

    // What the turn cost goes to the agent's registry as well as to this session's
    // own usage table. The registry is where the monthly ceiling is measured, and
    // it cannot be measured from here: the next turn may well be in a different
    // session object, which knows nothing about this one's spending.
    const spent = this.turnCost();
    if (spent > 0) this.ctx.waitUntil(this.registry().addSpend(spent));

    const messages = await this.getMessages();
    const questions = messages.filter((m) => m.role === "user");
    if (questions.length === 1 && result.status === "completed") {
      await this.nameSession(textOf(questions[0]), textOf(result.message));
    }
  }

  /**
   * Post a reply to the chat this session belongs to, over whichever channel it came
   * in on. Best effort throughout: the turn is already in the transcript, so a chat
   * that cannot be reached must not turn a completed task into a failed one.
   *
   * The channel is decided by the session's `source` rather than by which credentials
   * happen to be filled in: an agent may have both channels on, and a WhatsApp chat id
   * posted to Telegram would land in whichever chat that number happens to name.
   *
   * Every way this can come to nothing is logged, and that is deliberate: nobody is
   * watching a scheduled task, the answer is already in the transcript, and a silent
   * no-send is the one failure this path cannot afford.
   */
  private async deliverToChat(message: UIMessage, drawnBefore: Set<string>): Promise<void> {
    const row = await this.registry().get(this.sessionId());
    // A browser session, or one cut loose from its chat by `!new`, has nowhere to post.
    if (!row?.chat_id) {
      console.log(`delivery skipped for session ${this.name}: no chat to post to`);
      return;
    }
    const opened = openChannel(row.source, this.config(), this.env);
    if (!opened.channel) {
      console.warn(`delivery skipped for session ${this.name}: ${opened.reason}`);
      return;
    }
    const channel = opened.channel;
    // Nothing to quote: the task was scheduled in some earlier exchange, and quoting
    // the message that asked for it would be a reply to yesterday.
    const target = channel.targetOf(row);
    if (!target) {
      console.warn(`delivery skipped for session ${this.name}: chat id ${row.chat_id}`);
      return;
    }

    try {
      await channel.sendText(target, textOf(message) || "(no reply)");
      console.log(`${channel.id} delivered for session ${this.name} to ${target.to}`);
      await this.sendDrawn(channel, target, drawnBefore);
      if (this.scheduledInTurn && channel.scheduledNotice) {
        await channel.sendText(target, channel.scheduledNotice);
      }
    } catch (err) {
      const unreachable = channel.unreachable(err);
      if (unreachable) {
        console.warn(
          `${channel.id} unreachable for session ${this.name}: ${unreachable}; scheduled reply not delivered`
        );
        return;
      }
      console.error(
        `${channel.id} delivery failed for session ${this.name}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * Speak a note into this session's chat.
   *
   * Called by the `send_voice_note` tool, mid-turn, which is why every refusal here is
   * a thrown reason rather than a logged one: the model reads it as the tool's result
   * and can say something true to the user instead of promising audio that never
   * arrived.
   *
   * It asks the channel whether it does voice notes rather than asking which channel
   * it is, so the tool works on every channel that can carry one and on no channel
   * that cannot. The chat comes from the session's row and not from the message being
   * answered, so a note asked for by a scheduled task goes where an ordinary reply
   * would.
   */
  private async sendVoiceNote(bytes: Uint8Array): Promise<string> {
    const row = await this.registry().get(this.sessionId());
    if (!row?.chat_id) throw new Error("this session is not tied to a chat, so a voice note has nowhere to go");
    const opened = openChannel(row.source, this.config(), this.env);
    if (!opened.channel) throw new Error(opened.reason);
    const channel = opened.channel;
    const target = channel.targetOf(row);
    if (!target) throw new Error(`this session's chat id (${row.chat_id}) names no conversation`);
    if (!channel.sendVoice) throw new Error(`${channel.id} cannot carry a voice note`);

    // `sendVoice` takes the whole buffer, so a view over part of a larger one is
    // copied out first rather than sent with its neighbours attached.
    await channel.sendVoice(
      target,
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    );
    console.log(`${channel.id} voice note sent for session ${this.name} to ${target.to}`);
    return "Voice note sent. Say so in your reply rather than repeating the words you spoke.";
  }

  /**
   * What the turn cost. OpenRouter's own figure is the true one — it includes what the
   * token estimate cannot see, like a plugin's file-parsing fee — so the token maths is
   * only a fallback for a model the price table knows and the provider did not report.
   */
  private turnCost(): number {
    return this.turnUsage.reported > 0 ? this.turnUsage.reported : this.turnUsage.cost;
  }

  private priceOf(promptTokens: number, completionTokens: number, reported?: number) {
    if (typeof reported === "number") return reported;
    const p = MODEL_FALLBACK_PRICE[this.model()];
    return p ? promptTokens * p.prompt + completionTokens * p.completion : 0;
  }

  /**
   * Ask the model for a short name for the session and write it to the registry, so
   * the sidebar stops showing "New session". Best effort: a failed title must never
   * fail the turn it was generated from.
   */
  private async nameSession(userMessage: string, reply: string) {
    try {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.openrouterKey()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.model(),
          messages: [
            { role: "system", content: TITLE_PROMPT },
            { role: "user", content: `User: ${userMessage}\n\nAssistant: ${reply.slice(0, 500)}` },
          ],
        }),
      });
      if (!res.ok) return;
      const json = (await res.json()) as { choices: { message: { content: string } }[] };
      const title = (json.choices[0]?.message?.content ?? "")
        .replace(/^["'\s]+|["'\s.]+$/g, "")
        .slice(0, 60);
      if (!title) return;
      await this.registry().rename(this.sessionId(), title);
    } catch {
      // Leave the placeholder title in place.
    }
  }

  /* ----------------------------------------------------------------- routes -- */

  async onRequest(request: Request): Promise<Response> {
    this.ensureSchema();
    await this.loadConfig();

    const url = new URL(request.url);
    const segments = url.pathname.split("/").filter(Boolean);
    // Everything after /agents/session-agent/<session-id>.
    const route = segments.slice(segments.indexOf("session-agent") + 2);
    const path = route[0] ?? "";

    // Streaming owns its own metering: the object stays billable until the last token.
    if (request.method === "POST" && path === "stream") {
      const { message, retry } = (await request.json()) as {
        message?: string;
        retry?: boolean;
      };
      if (message === undefined) {
        return Response.json({ error: "body must be { message: string }" }, { status: 400 });
      }
      return await this.streamChat(message, retry === true);
    }

    // A browser that reloaded mid-reply asks here whether one is still in flight,
    // naming the last reply its transcript holds so a turn that ended in between is
    // sent rather than lost.
    if (request.method === "GET" && path === "live") {
      return this.attachLive(url.searchParams.get("has") ?? "");
    }

    // Attachment bytes are served raw so an <img> src can point straight at them.
    if (request.method === "GET" && path === "files" && route[1]) {
      return route[2] === "thumb"
        ? await this.serveThumbnail(route[1])
        : await this.serveAttachment(route[1]);
    }

    let body: unknown;
    let status = 200;
    let turn: Record<string, unknown> | undefined;

    try {
      if (request.method === "POST" && path === "chat") {
        const result = await this.runChat(((await request.json()) as { message: string }).message);
        body = result.body;
        turn = result.turn;
      } else if (request.method === "POST" && path === "files") {
        const result = await this.upload(request);
        body = result.body;
        status = result.status;
      } else if (request.method === "GET" && path === "files") {
        body = { attachments: this.pendingAttachments().map(publicAttachment) };
      } else if (request.method === "DELETE" && path === "files" && route[1]) {
        await this.removeAttachment(route[1]);
        body = { ok: true };
      } else if (request.method === "GET" && path === "tasks") {
        body = { tasks: this.listTasks() };
      } else if (request.method === "DELETE" && path === "tasks" && route[1]) {
        body = { ok: await this.cancelTask(route[1]) };
      } else if (request.method === "GET" && path === "messages") {
        const paging = await this.settingsNow();
        const asked = Number(url.searchParams.get("limit") ?? paging.message_page);
        body = await this.transcript(
          Number.isFinite(asked) ? asked : paging.message_page,
          url.searchParams.get("before") ?? ""
        );
      } else if (request.method === "GET" && path === "export") {
        body = await this.exportTurns(Number(url.searchParams.get("count") ?? "0"));
      } else if (request.method === "POST" && path === "import") {
        // A refused import is the fork's answer, not a crash: the route that asked
        // for it deletes the empty fork and passes this sentence back.
        try {
          await this.importTurns((await request.json()) as Snapshot);
          body = { ok: true };
        } catch (err) {
          body = { error: (err as Error).message };
          status = 413;
        }
      } else if (request.method === "GET" && path === "summary") {
        body = await this.summary();
      } else if (request.method === "POST" && path === "unstick") {
        body = { ok: true, ...this.unstick() };
      } else if (request.method === "POST" && path === "reset") {
        await this.reset();
        body = { ok: true };
      } else if (request.method === "POST" && path === "telegram") {
        const message = (await request.json()) as TelegramMessage;
        body = await this.channelTurn(telegramInbound(message, this.config(), this.env));
      } else if (request.method === "POST" && path === "whatsapp") {
        const inbound = (await request.json()) as WhatsappInbound;
        body = await this.channelTurn(whatsappInbound(inbound, this.config(), this.env));
      } else if (request.method === "POST" && path === "destroy") {
        // The bucket is swept before the reply, because `destroy()` aborts the
        // isolate: work left running behind it may never finish. Dropping the
        // object's own storage is what waits, and the runtime completes that.
        //
        // The agent's byte total is given back first, for the same reason: after
        // `destroy()` there is nobody left to report it.
        await this.registry().addStorageBytes(-this.storedBytes());
        await this.sweepBucket();
        this.ctx.waitUntil(this.destroy());
        body = { ok: true };
      } else {
        status = 404;
        body = { error: `no route for ${request.method} ${url.pathname}` };
      }
    } catch (err) {
      status = 500;
      body = { error: err instanceof Error ? err.message : String(err) };
    }

    return Response.json(
      { ...(body as object), _meta: { session: this.name, request: { ...turn } } },
      { status }
    );
  }

  /* ------------------------------------------------------------ attachments -- */

  private attachment(id: string): Attachment | undefined {
    return this.exec<Attachment>(`SELECT * FROM attachments WHERE id = ?`, id)[0];
  }

  /** Uploaded but not yet sent: what the next turn will carry. */
  private pendingAttachments(): Attachment[] {
    return this.exec<Attachment>(`SELECT * FROM attachments WHERE used = 0 ORDER BY ts ASC`);
  }

  /**
   * The files a turn is opening with: the ones it names, or every pending one when it
   * names none. Named ids are looked up whatever their `used` flag says — the caller
   * has just written them and is the only party that could claim them.
   */
  private claimed(only?: string[]): Attachment[] {
    if (!only) return this.pendingAttachments();
    if (only.length === 0) return [];
    const marks = only.map(() => "?").join(", ");
    return this.exec<Attachment>(
      `SELECT * FROM attachments WHERE id IN (${marks}) ORDER BY ts ASC`,
      ...only
    );
  }

  /**
   * Every file this session writes goes through here, so this is where the agent's
   * byte total is moved. Reported rather than awaited: the file is already written,
   * and a count that lands a moment later is better than an upload that waits on it.
   */
  private insertAttachment(row: Omit<Attachment, "ts" | "used">): Attachment {
    const full: Attachment = { ...row, ts: Date.now(), used: 0 };
    if (full.bytes > 0) this.ctx.waitUntil(this.registry().addStorageBytes(full.bytes));
    this.exec(
      `INSERT INTO attachments (id, kind, name, mime, text, path, thumb_path, bytes, ts, used)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      full.id,
      full.kind,
      full.name,
      full.mime,
      full.text,
      full.path,
      full.thumb_path,
      full.bytes,
      full.ts
    );
    return full;
  }

  /** What this session's files come to, in bytes. */
  private storedBytes(): number {
    try {
      const row = this.exec<{ total: number }>(
        `SELECT COALESCE(SUM(bytes), 0) AS total FROM attachments`
      )[0];
      return Math.max(0, Number(row?.total ?? 0));
    } catch {
      // A session that never got as far as its schema holds no files either.
      return 0;
    }
  }

  /**
   * Hand this session's bytes back to the agent's total.
   *
   * Called before the rows are deleted, never after — and before the object destroys
   * itself, because a destroyed object cannot report anything. A session whose
   * isolate dies mid-teardown leaves its bytes counted against the agent; the total
   * is a ceiling, not an invoice, so the cost of that is headroom.
   */
  private releaseStorage(): void {
    const held = this.storedBytes();
    if (held > 0) this.ctx.waitUntil(this.registry().addStorageBytes(-held));
  }

  /** Only an unsent attachment can be dropped; a sent one belongs to its message. */
  private async removeAttachment(id: string) {
    const row = this.attachment(id);
    if (!row || row.used === 1) return;
    this.exec(`DELETE FROM attachments WHERE id = ? AND used = 0`, id);
    if (row.bytes > 0) this.ctx.waitUntil(this.registry().addStorageBytes(-row.bytes));
    if (row.path) await this.workspace.rm(`uploads/${id}`, { recursive: true, force: true });
    // The parse outlives nothing: the file it describes is gone.
    this.exec(`DELETE FROM file_cache WHERE attachment_id = ?`, id);
    await this.workspace.rm(`${PARSE_CACHE_DIR}/${id}.txt`, { force: true });
  }

  private async serveAttachment(id: string): Promise<Response> {
    const row = this.attachment(id);
    if (!row?.path) return new Response("not found", { status: 404 });
    const stream = await this.workspace.readFileStream(row.path);
    if (!stream) return new Response("not found", { status: 404 });
    return new Response(stream, {
      headers: {
        "content-type": row.mime,
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
  }

  private async serveThumbnail(id: string): Promise<Response> {
    const row = this.attachment(id);
    if (!row?.thumb_path) return new Response("not found", { status: 404 });
    const stream = await this.workspace.readFileStream(row.thumb_path);
    if (!stream) return new Response("not found", { status: 404 });
    return new Response(stream, {
      headers: {
        "content-type": "image/png",
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
  }

  /**
   * Take one uploaded file. Which files are accepted is decided by the capabilities
   * that are on: text needs File ingest, images need Image input, audio needs Audio
   * input. Audio is stored untranscribed; transcribing it is the model's own call.
   */
  private async upload(request: Request): Promise<{ body: unknown; status: number }> {
    const form = await request.formData();
    // The Workers FormData types entries loosely; the runtime hands back a File here.
    const file = form.get("file") as unknown as File | null;
    if (!file || typeof file === "string") {
      return { body: { error: "expected a file field" }, status: 400 };
    }
    const config = this.config();
    const mime = file.type || "application/octet-stream";
    const id = crypto.randomUUID().slice(0, 12);
    const path = uploadPath(id, file.name);

    const settings = await this.settingsNow();
    const limit = isPdf(mime, file.name)
      ? settings.max_upload_bytes.pdf
      : mime.startsWith("image/")
        ? settings.max_upload_bytes.image
        : mime.startsWith("audio/") || mime.startsWith("video/")
          ? settings.max_upload_bytes.audio
          : settings.max_upload_bytes.text;
    if (file.size > limit) {
      return {
        body: {
          error: `${file.name} is ${formatMb(file.size)}; the limit for this kind of file is ${formatMb(limit)}.`,
        },
        status: 413,
      };
    }

    // The agent-wide ceiling, on top of the per-kind one. Asked before the bytes are
    // read off the request: a file that cannot be kept should not be uploaded first.
    const room = await this.registry().storageRoom(settings.max_agent_bytes);
    if (file.size > room) {
      const { bytes } = await this.registry().storageState(settings.max_agent_bytes);
      return {
        body: { error: storageFullMessage(bytes, file.size, settings.max_agent_bytes) },
        status: 413,
      };
    }

    if (isPdf(mime, file.name)) {
      if (!enabled(config, "file_ingest")) {
        return { body: { error: "File ingest is off. Turn it on under Capabilities." }, status: 400 };
      }
      // Nothing is extracted here: the file lands in the workspace whole, and the
      // read tool hands its pages to the model when a question needs them. The card's
      // first-page image is rendered by the browser and arrives beside the file.
      await this.workspace.writeFileBytes(path, await file.arrayBuffer(), "application/pdf");
      const attachment = this.insertAttachment({
        id,
        kind: "pdf",
        name: file.name,
        mime: "application/pdf",
        text: "",
        path,
        thumb_path: await this.putThumbnail(id, form.get("thumbnail")),
        bytes: file.size,
      });
      return { body: { attachment: publicAttachment(attachment) }, status: 200 };
    }

    if (mime.startsWith("image/")) {
      if (!enabled(config, "vision")) {
        return { body: { error: "Image input is off. Turn it on under Capabilities." }, status: 400 };
      }
      // Refuse here rather than at turn time: by the time the model refuses, the
      // message and the attachment have already been stored.
      if (!(await this.modelSeesImages(config.model))) {
        return {
          body: {
            error: `${config.model} cannot see images. Pick a multimodal model under Settings.`,
          },
          status: 400,
        };
      }
      await this.workspace.writeFileBytes(path, await file.arrayBuffer(), mime);
      const attachment = this.insertAttachment({
        id,
        kind: "image",
        name: file.name,
        mime,
        text: "",
        path,
        thumb_path: "",
        bytes: file.size,
      });
      return { body: { attachment: publicAttachment(attachment) }, status: 200 };
    }

    if (mime.startsWith("audio/") || mime.startsWith("video/")) {
      if (!enabled(config, "audio_input")) {
        return {
          body: { error: "Audio input is off. Turn it on under Capabilities." },
          status: 400,
        };
      }
      // Not transcribed here: the clip is stored as-is and the model decides whether
      // it needs the words, by calling transcribe_audio with this attachment's id.
      await this.workspace.writeFileBytes(path, await file.arrayBuffer(), mime);
      const attachment = this.insertAttachment({
        id,
        kind: "text",
        name: file.name,
        mime,
        text: "",
        path,
        thumb_path: "",
        bytes: file.size,
      });
      return { body: { attachment: publicAttachment(attachment) }, status: 200 };
    }

    if (!enabled(config, "file_ingest")) {
      return { body: { error: "File ingest is off. Turn it on under Capabilities." }, status: 400 };
    }
    if (!mime.startsWith("text/") && !isTextLike(mime, file.name)) {
      return {
        body: { error: `${file.name} is not a text format. Text, Markdown, CSV, JSON and source files work.` },
        status: 415,
      };
    }
    const text = await file.text();
    await this.workspace.writeFile(path, text, mime);
    const attachment = this.insertAttachment({
      id,
      kind: "text",
      name: file.name,
      mime,
      text,
      path,
      thumb_path: "",
      bytes: file.size,
    });
    return { body: { attachment: publicAttachment(attachment) }, status: 200 };
  }

  /**
   * Store the PNG of a PDF's first page. The browser renders it, so a malformed or
   * oversized image is dropped rather than trusted: the card falls back to its name.
   */
  private async putThumbnail(id: string, thumbnail: unknown): Promise<string> {
    const file = thumbnail as File | null;
    if (!file || typeof file === "string" || file.size === 0) return "";
    if (file.size > this.settings().max_thumbnail_bytes) return "";
    const path = `uploads/${id}/thumb.png`;
    await this.workspace.writeFileBytes(path, await file.arrayBuffer(), "image/png");
    return path;
  }

  /**
   * Turn audio into text. OpenRouter has no /audio/transcriptions route, but many of
   * its models take audio as a chat input part, so this spends the agent's existing
   * OpenRouter key rather than asking the user for a second provider.
   */
  private async transcribe(bytes: ArrayBuffer, mime: string, name: string): Promise<string> {
    const format = audioFormat(mime, name);
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.openrouterKey()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.config().transcription_model,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Transcribe this audio verbatim. Reply with the transcript alone — no preamble, no commentary, no quotation marks.",
              },
              { type: "input_audio", input_audio: { data: bytesToBase64(bytes), format } },
            ],
          },
        ],
      }),
    });
    if (!res.ok) throw new Error(`transcription ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return (json.choices?.[0]?.message?.content ?? "").trim();
  }

  /**
   * Transcribe a stored clip on demand, and cache the words on its row so a second
   * call — or a reopened session — does not pay for the same audio twice.
   */
  private async transcribeAttachment(id: string): Promise<string> {
    const row = this.attachment(id);
    if (!row) return `No attachment with id ${id}.`;
    if (!isAudioAttachment(row)) return `${row.name} is not audio.`;
    if (row.text.trim()) return row.text;
    if (!enabled(this.config(), "audio_input")) {
      return "Audio input is off. Turn it on under Capabilities.";
    }
    const bytes = row.path ? await this.workspace.readFileBytes(row.path) : null;
    if (!bytes) return `The bytes for ${row.name} are gone.`;
    const transcript = await this.transcribe(toArrayBuffer(bytes), row.mime, row.name);
    this.exec(`UPDATE attachments SET text = ? WHERE id = ?`, transcript, id);
    return transcript;
  }

  /* ------------------------------------------------------------------ turns -- */

  /**
   * The user's turn: their words, plus a note naming every file they attached and
   * where it sits in the workspace. The bytes are not inlined — the model opens what
   * it needs with the read tool, so a PDF is not re-sent with every later message.
   */
  private userText(message: string, attachments: Attachment[]): string {
    if (attachments.length === 0) return message;
    const notes = attachments.map((a) => {
      if (isAudioAttachment(a)) {
        return a.text.trim()
          ? `--- attached audio: ${a.name} (id ${a.id}), already transcribed ---\n${a.text}`
          : `--- attached audio: ${a.name} (id ${a.id}), not transcribed. Call transcribe_audio with attachment_id "${a.id}" if you need the words. ---`;
      }
      // Images and PDFs ride along as content parts, so naming them is enough. A text
      // file is not sent: the model opens it from the workspace when it needs to.
      if (a.kind === "image") return `--- attached image: ${a.name} ---`;
      if (a.kind === "pdf") return `--- attached PDF: ${a.name} ---`;
      return `--- attached file: ${a.name}, in the workspace at ${a.path} ---`;
    });
    return [message, ...notes].filter((part) => part.trim() !== "").join("\n\n");
  }

  /**
   * The message a turn sends, and the files it claims: the pending ones, or — on a
   * retry — the ones the question being asked again came with.
   *
   * `only` names them outright, and is how a chat channel says "these files, the ones
   * that arrived on this message". A browser turn passes nothing and takes the pending
   * pool, because that is exactly what it means there: files dropped on the composer
   * before the message was sent. A channel has no composer, and its pool is shared with
   * every other message being answered at that moment.
   */
  private async openTurn(message: string, retry: boolean, only?: string[]): Promise<UIMessage> {
    // A new question is the end of the last stop. Cleared here and not in
    // `beforeTurn`, which runs again on a retried attempt: an abort is one of the
    // things Think retries, so clearing it there would clear it on the way down from
    // the very stop that set it.
    this.stoppedOnPurpose = false;
    const attachments = retry ? await this.rewind() : this.claimed(only);
    const id = crypto.randomUUID();
    for (const a of attachments) {
      this.exec(`UPDATE attachments SET used = 1 WHERE id = ?`, a.id);
      this.exec(
        `INSERT OR REPLACE INTO message_files (message_id, attachment_id) VALUES (?, ?)`,
        id,
        a.id
      );
    }
    // The user row exists only for its timestamp; the reply's row carries the cost.
    this.exec(`INSERT OR REPLACE INTO usage (message_id, ts) VALUES (?, ?)`, id, Date.now());
    this.exec(`INSERT OR REPLACE INTO message_text (message_id, text) VALUES (?, ?)`, id, message);
    return {
      id,
      role: "user",
      parts: [{ type: "text", text: this.userText(message, attachments) }],
    };
  }

  /**
   * Undo the last exchange so it can be asked again: the trailing assistant messages
   * and the question that prompted them are deleted from the session, and that
   * question's attachments are handed back so the retry carries the same files.
   */
  private async rewind(): Promise<Attachment[]> {
    const messages = await this.getMessages();
    let cut = messages.length;
    while (cut > 0 && messages[cut - 1].role === "assistant") cut--;
    const question = cut > 0 && messages[cut - 1].role === "user" ? messages[cut - 1] : null;
    if (question) cut--;

    // Read the links before the rows go: the question's own row is among the ones
    // about to be deleted, and its files are exactly what the retry needs back.
    const attachments = question ? this.attachmentsOf(question.id) : [];

    const dropped = messages.slice(cut);
    if (dropped.length > 0) await this.session.deleteMessages(dropped.map((m) => m.id));
    for (const message of dropped) {
      this.exec(`DELETE FROM usage WHERE message_id = ?`, message.id);
      this.exec(`DELETE FROM message_files WHERE message_id = ?`, message.id);
      this.exec(`DELETE FROM message_text WHERE message_id = ?`, message.id);
    }
    // They are already marked used, so `pendingAttachments` would never find them.
    for (const a of attachments) this.exec(`UPDATE attachments SET used = 0 WHERE id = ?`, a.id);
    return attachments;
  }

  /**
   * The sentence to answer with instead of running a turn, when the agent has spent
   * its month. Empty when it may go ahead.
   *
   * Checked before the turn rather than during it: a reply cut off halfway through
   * costs what a whole one costs and is worth less than nothing. Going over by the
   * price of one turn is the deliberate trade — the cost is only known once the turn
   * has happened, so the ceiling is the point where it stops starting new ones.
   */
  private async spendBlocked(): Promise<string> {
    const { usd, limit } = await this.registry().spendState();
    if (limit <= 0 || usd < limit) return "";
    return (
      `This agent has reached its spending limit for this month ` +
      `($${usd.toFixed(2)} of $${limit.toFixed(2)}). ` +
      `It will answer again next month, or when its administrator raises the limit.`
    );
  }

  /** A whole turn, without streaming. */
  private async runChat(message: string, retry = false) {
    const command = parseCommand(message);
    if (command) {
      const { text, destroy } = await this.runCommand(command);
      if (destroy) this.ctx.waitUntil(this.finishDelete());
      return { body: { reply: text }, turn: { cost_usd: 0, llm_ms: 0 } };
    }
    const blocked = await this.spendBlocked();
    if (blocked) return { body: { reply: blocked }, turn: { cost_usd: 0, llm_ms: 0 } };
    const userMessage = await this.openTurn(message, retry);
    const result = await this.runTurn({ input: [userMessage] });
    const reply =
      result.status === "completed" ? textOf(result.message as unknown as UIMessage) : "";
    const usage = this.exec<{ cost_usd: number; ms: number }>(
      `SELECT cost_usd, ms FROM usage WHERE message_id = ?`,
      result.message?.id ?? ""
    )[0];

    return {
      body: { reply },
      turn: { cost_usd: usage?.cost_usd ?? 0, llm_ms: usage?.ms ?? 0 },
    };
  }

  /**
   * Stream a reply as SSE, in the event shape the browser already speaks. Think owns
   * the loop and the persistence; this translates its UI message chunks into the
   * `delta` / `tool` / `tool_done` / `usage` protocol the chat client reads.
   *
   * The object stays resident — and billable — for the whole stream. A stopped reply
   * keeps its partial text and its token cost, because the tokens were generated.
   */
  private async streamChat(message: string, retry = false): Promise<Response> {
    const command = parseCommand(message);
    if (command) return await this.streamCommand(command);
    // Said as the agent would say it, down the same stream: the chat has no other
    // way to show why nothing is coming back.
    const blocked = await this.spendBlocked();
    if (blocked) return this.streamSentence(blocked);
    const userMessage = await this.openTurn(message, retry);
    // Tool events name the call by id; the name arrives once, when it starts.
    const toolNames = new Map<string, string>();

    // The turn runs against the object, not against this request, and every event it
    // produces is banked as it goes. The response is one listener on that; a browser
    // that reloads mid-reply opens another and is caught up from the first token.
    this.finished = null;
    this.live = { events: [], listeners: new Set(), closers: new Set() };
    const turn = (async () => {
      try {
        await this.runTurn({
          mode: "stream",
          input: [userMessage],
          callback: {
            onStart: () => { },
            onEvent: (json: string) => {
              const chunk = JSON.parse(json) as {
                type: string;
                delta?: string;
                toolCallId?: string;
                toolName?: string;
              };
              if (chunk.type === "text-delta" && chunk.delta) {
                this.emit({ type: "delta", text: chunk.delta });
              } else if (chunk.type === "tool-input-start" && chunk.toolCallId) {
                toolNames.set(chunk.toolCallId, chunk.toolName ?? "tool");
                this.emit({ type: "tool", name: chunk.toolName ?? "tool" });
              } else if (chunk.type === "tool-output-available" && chunk.toolCallId) {
                this.emit({ type: "tool_done", name: toolNames.get(chunk.toolCallId) ?? "tool", ok: true });
              } else if (chunk.type === "tool-output-error" && chunk.toolCallId) {
                this.emit({ type: "tool_done", name: toolNames.get(chunk.toolCallId) ?? "tool", ok: false });
              }
            },
            onDone: () => { },
            onError: (error: string) => {
              this.emit({ type: "error", error: reportable(error, this.name) });
            },
          },
        });

        this.emit({
          type: "usage",
          prompt_tokens: this.turnUsage.prompt,
          completion_tokens: this.turnUsage.completion,
          cost_usd: this.turnCost(),
          llm_ms: this.turnUsage.started ? Date.now() - this.turnUsage.started : 0,
        });
      } catch (err) {
        this.emit({ type: "error", error: reportable(err, this.name) });
      } finally {
        this.emit({ type: "done" });
        this.endLive();
      }
    })();
    // The object stays resident — and billable — until the turn is done, whether or
    // not anyone is still listening.
    this.ctx.waitUntil(turn);

    return this.attachLive();
  }

  /**
   * A command's answer, sent down the same stream a reply would use so the browser
   * draws it as an ordinary message. No turn runs, so there is no cost to report.
   */
  private async streamCommand(command: Command): Promise<Response> {
    const { text, destroy } = await this.runCommand(command);
    if (destroy) this.ctx.waitUntil(this.finishDelete());
    return this.streamSentence(text);
  }

  /** One line of text, in the SSE shape the chat client already reads. */
  private streamSentence(text: string): Response {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of [
          { type: "delta", text },
          { type: "usage", prompt_tokens: 0, completion_tokens: 0, cost_usd: 0, llm_ms: 0 },
        ]) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        }
        controller.close();
      },
    });
    return new Response(body, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    });
  }

  /* ---------------------------------------------------------------- channels -- */

  /**
   * One message from a chat channel, answered.
   *
   * The same eight steps for every channel, because they were the same eight steps
   * when they were written twice: look busy, answer a command without a turn, check
   * the spend, take in what came attached, run, reply, send what was drawn, apologise
   * if it broke. What differs between Telegram and WhatsApp is held by the channel
   * object — see channel.ts — so nothing here branches on which one it is.
   *
   * The chat is a session like any other, so the turn is the turn the browser runs:
   * the same settings, tools, memory and transcript. What is different is the ends —
   * files arrive from the channel rather than from an upload, and the reply is posted
   * back rather than streamed.
   *
   * Who may talk is settled before this: the webhook checks the whitelist or the
   * configured number before a session exists, and these routes are only reachable
   * from it.
   */
  private async channelTurn(
    inbound: ChannelInbound | { skipped: string }
  ): Promise<{ ok: boolean; skipped?: string }> {
    if ("skipped" in inbound) return { ok: false, skipped: inbound.skipped };
    const { channel, target } = inbound;
    await channel.typing(target);

    try {
      // A command is answered by the session itself, without a turn: the model has no
      // say in whether it gets reset, and a wedged session could not run one anyway.
      const command = parseCommand(inbound.text);
      if (command) {
        const { text, destroy } = await this.runCommand(command);
        await channel.sendText(target, text);
        if (destroy) await this.finishDelete();
        return { ok: true };
      }

      const blocked = await this.spendBlocked();
      if (blocked) {
        await channel.sendText(target, blocked);
        return { ok: true };
      }

      const attached = await this.ingestFiles(inbound.files);
      const drawnBefore = this.drawnIds();

      const result = await this.runTurn({
        input: [await this.openTurn(inbound.text, false, attached)],
      });
      if (this.stoppedOnPurpose) {
        // `!stop` has already said so in this chat, so this turn owes it nothing —
        // not the half-answer to a question that was withdrawn, and least of all
        // "that turn was cut short", which reads as a fault when it was an
        // instruction. What it wrote is in the transcript either way.
        //
        // Read without looking at the status, because a turn cancelled before its
        // first chunk reports `completed` with nothing in it. The flag is the only
        // thing that tells a stop that was asked for from one that was not.
        return { ok: true };
      }
      if (result.status !== "completed") {
        // The turn carries why it stopped; a chat that only ever says "try again"
        // cannot be told apart from one that is broken in a way retrying will not fix.
        console.error(
          `${channel.id} turn ${result.status} in session ${this.name}: ${result.error ?? "no reason given"}`
        );
      }
      const reply =
        result.status === "completed"
          ? textOf(result.message as unknown as UIMessage)
          : turnFailure(result.status, result.error);

      await channel.sendText(target, reply || "(no reply)");
      // An image the agent drew during the turn is a file in a chat, not a link.
      await this.sendDrawn(channel, target, drawnBefore);
      // Said as its own message rather than folded into the answer, so the model
      // cannot paraphrase away the one thing the user has to do for the task to
      // arrive. The window is open by definition here — they just wrote.
      if (this.scheduledInTurn && channel.scheduledNotice) {
        await channel.sendText(target, channel.scheduledNotice);
      }
      return { ok: true };
    } catch (err) {
      // A chat that is out of reach for good takes no apology: on WhatsApp the send
      // that would carry it is the send being refused. The answer is already in the
      // transcript, and the browser can still read it.
      const unreachable = channel.unreachable(err);
      if (unreachable) {
        console.warn(`${channel.id} unreachable for session ${this.name}: ${unreachable}`);
        return { ok: false, skipped: unreachable };
      }
      // The same one line the browser gets: a raw platform error names SQL statements
      // and isolate resets, which is not an answer to someone who asked a question.
      // `reportable` logs the whole thing and returns the sentence worth sending.
      await channel
        .sendText({ ...target, replyTo: undefined }, `Something went wrong: ${reportable(err, this.name)}`)
        .catch(() => {
          // The chat is unreachable; the error is already the answer to the request.
        });
      return { ok: false };
    }
  }

  /**
   * Pull what a message carried into the workspace, as though it had been uploaded:
   * the same rows, the same paths, the same capability checks, so the turn that
   * follows cannot tell the difference.
   *
   * The files are `ChannelFile`s and not any one channel's shape, so a channel that
   * learns to hand over inbound media gets all of this — the capability gates, the
   * storage ceiling, the PDF and audio handling — without a line here.
   *
   * Returns the ids it took in, and the turn that follows claims those rather than
   * whatever is pending. The pool is the session's, and two messages sent a second
   * apart are two turns running side by side inside one Durable Object: downloading
   * the second clip while the first turn is still opening is enough for one turn to
   * claim both files and answer both questions, which is what it did.
   */
  private async ingestFiles(files: ChannelFile[]): Promise<string[]> {
    const taken: string[] = [];
    const config = this.config();
    for (const file of files) {
      const isImage = file.mime.startsWith("image/");
      const isAudio = file.mime.startsWith("audio/") || file.mime.startsWith("video/");
      const allowed = isImage
        ? enabled(config, "vision") && (await this.modelSeesImages(config.model))
        : isAudio
          ? enabled(config, "audio_input")
          : enabled(config, "file_ingest");
      if (!allowed) continue;

      const bytes = await file.read();
      // The agent's ceiling applies to what arrives over a chat channel too. The file
      // is dropped and the turn goes on with the text: the alternative is an agent
      // that stops answering because somebody sent it a video.
      const maxAgentBytes = this.settings().max_agent_bytes;
      if (bytes.byteLength > (await this.registry().storageRoom(maxAgentBytes))) {
        console.warn(
          `file dropped in session ${this.name}: agent is at its ${maxAgentBytes} byte storage limit`
        );
        continue;
      }
      const id = crypto.randomUUID().slice(0, 12);
      taken.push(id);
      const path = uploadPath(id, file.name);
      await this.workspace.writeFileBytes(path, bytes, file.mime);
      const pdf = isPdf(file.mime, file.name);
      const textual = !isImage && !isAudio && !pdf;
      this.insertAttachment({
        id,
        kind: isImage ? "image" : pdf ? "pdf" : "text",
        name: file.name,
        mime: file.mime,
        text: textual
          ? new TextDecoder().decode(bytes).slice(0, this.settings().max_upload_bytes.text)
          : "",
        path,
        thumb_path: "",
        bytes: bytes.byteLength,
      });
    }
    return taken;
  }

  /** Every image in this session so far, so the ones a turn adds can be told apart. */
  private drawnIds(): Set<string> {
    return new Set(
      this.exec<{ id: string }>(`SELECT id FROM attachments WHERE kind = 'image'`).map((r) => r.id)
    );
  }

  /**
   * Images created during this turn, sent to the chat as pictures rather than as the
   * links they are in the browser. A channel that cannot carry one sends nothing and
   * says nothing: the reply already describes what was drawn.
   */
  private async sendDrawn(
    channel: Channel,
    target: ChannelTarget,
    before: Set<string>
  ): Promise<void> {
    if (!channel.sendImage) return;
    const drawn = this.exec<Attachment>(
      `SELECT * FROM attachments WHERE kind = 'image' ORDER BY ts ASC`
    ).filter((a) => !before.has(a.id));
    for (const image of drawn) {
      const bytes = await this.workspace.readFileBytes(image.path);
      if (!bytes) continue;
      await channel.sendImage(target, toArrayBuffer(bytes), image.name, image.text);
    }
  }

  /* ------------------------------------------------------------- transcript -- */

  /**
   * A page of the transcript as the API serves it: Think's messages, plus what only
   * this agent knows — the files each question carried, and what each reply cost.
   *
   * Paged from the end, because that is the end a chat opens at. Each message costs
   * three extra SQL reads here (its usage row, its typed text, its attachments), so
   * a long session that returned whole would pay for its entire history on every
   * open. `before` walks backwards from the oldest message the client holds.
   */
  private async transcript(limit: number, before = ""): Promise<TranscriptPage> {
    const { max_message_page } = this.settings();
    const visible = (await this.getMessages()).filter(
      (m) => m.role === "user" || m.role === "assistant"
    );

    // `before` names the oldest message the caller already holds, so the window ends
    // just before it. An id that is no longer in the transcript — a session reset
    // under a stale scroll — falls back to the newest page rather than erroring.
    const end = before ? visible.findIndex((m) => m.id === before) : -1;
    const upTo = end === -1 ? visible.length : end;
    const size = Math.max(1, Math.min(limit, max_message_page));
    const start = Math.max(0, upTo - size);
    const page = visible.slice(start, upTo);

    const messages = page.map((m) => {
      const usage = this.exec<{
        prompt_tokens: number;
        completion_tokens: number;
        cost_usd: number;
        ms: number;
        ts: number;
      }>(`SELECT * FROM usage WHERE message_id = ?`, m.id)[0];
      const steps = stepsOf(m);
      const toolLines = steps.some((s) => s.kind === "tools");
      return {
        id: m.id,
        role: m.role as "user" | "assistant",
        content: this.spokenText(m),
        ts: usage?.ts ?? 0,
        prompt_tokens: usage?.prompt_tokens ?? 0,
        completion_tokens: usage?.completion_tokens ?? 0,
        cost_usd: usage?.cost_usd ?? 0,
        ms: usage?.ms ?? 0,
        attachments: this.attachmentsOf(m.id).map(publicAttachment),
        steps: toolLines ? JSON.stringify(steps) : "[]",
      };
    });

    return {
      messages,
      has_more: start > 0,
      // How many messages sit before this window. A fork counts from the start of
      // the transcript, so the client has to know what it is not holding.
      offset: start,
      total: visible.length,
    };
  }

  /**
   * What the message said, as a person wrote it: the file annotations the turn added
   * for the model are dropped, so the bubble and a forked draft read the way they did
   * when they were typed.
   */
  private spokenText(message: UIMessage): string {
    const typed = this.exec<{ text: string }>(
      `SELECT text FROM message_text WHERE message_id = ?`,
      message.id
    )[0];
    return typed ? typed.text : textOf(message);
  }

  private attachmentsOf(messageId: string): Attachment[] {
    return this.exec<{ attachment_id: string }>(
      `SELECT attachment_id FROM message_files WHERE message_id = ?`,
      messageId
    )
      .map((row) => this.attachment(row.attachment_id))
      .filter((a): a is Attachment => !!a);
  }

  /* ---------------------------------------------------------------- forking -- */

  /**
   * The first `count` messages with every attachment they reference, bytes included,
   * so the fork can stand on its own.
   */
  private async exportTurns(count: number): Promise<Snapshot> {
    const visible = (await this.getMessages()).filter(
      (m) => m.role === "user" || m.role === "assistant"
    );
    const kept = visible.slice(0, Math.max(0, count));
    const keep = new Set(kept.map((m) => m.id));

    const pack = async (ids: string[]): Promise<PackedAttachment[]> =>
      await Promise.all(
        ids
          .map((id) => this.attachment(id))
          .filter((a): a is Attachment => !!a)
          .map(async (a) => ({
            ...a,
            data: await this.readBase64(a.path),
            thumb: await this.readBase64(a.thumb_path),
          }))
      );

    const carried = kept.flatMap((m) => this.attachmentsOf(m.id).map((a) => a.id));
    // The message just past the cut is the question a fork hands back for editing;
    // its files travel too, so the new session's composer opens with the same chips.
    const dropped = visible[Math.max(0, count)];
    const pending =
      dropped?.role === "user" ? this.attachmentsOf(dropped.id).map((a) => a.id) : [];

    return {
      messages: (await this.getMessages()).filter((m) => keep.has(m.id)),
      attachments: await pack(carried),
      links: this.exec<{ message_id: string; attachment_id: string }>(
        `SELECT message_id, attachment_id FROM message_files`
      ).filter((row) => keep.has(row.message_id)),
      texts: this.exec<{ message_id: string; text: string }>(
        `SELECT message_id, text FROM message_text`
      ).filter((row) => keep.has(row.message_id)),
      pending: await pack(pending),
    };
  }

  private async readBase64(path: string): Promise<string> {
    if (!path) return "";
    const bytes = await this.workspace.readFileBytes(path);
    return bytes ? bytesToBase64(toArrayBuffer(bytes)) : "";
  }

  /**
   * Replay a snapshot into this (empty) session. Attachment ids are kept, so the
   * copied messages still name their files, but the bytes are written into this
   * session's own workspace so deleting either side leaves the other intact.
   */
  private async importTurns(snapshot: Snapshot): Promise<void> {
    const carried = (snapshot.attachments ?? []).map((a) => [a, 1] as const);
    // Copied unsent (used = 0), so they show as chips and ride the next turn.
    const pending = (snapshot.pending ?? []).map((a) => [a, 0] as const);

    // A fork copies the bytes rather than sharing them — either session can be
    // deleted without taking the other's files — so it is charged for them like any
    // other upload, and refused the same way when there is no room.
    const incoming = [...carried, ...pending].reduce((sum, [a]) => sum + (a.bytes ?? 0), 0);
    const { max_agent_bytes } = await this.settingsNow();
    if (incoming > 0 && incoming > (await this.registry().storageRoom(max_agent_bytes))) {
      const { bytes } = await this.registry().storageState(max_agent_bytes);
      throw new Error(storageFullMessage(bytes, incoming, max_agent_bytes));
    }

    for (const [a, used] of [...carried, ...pending]) {
      let path = "";
      if (a.data) {
        path = uploadPath(a.id, a.name);
        await this.workspace.writeFileBytes(path, base64ToBytes(a.data), a.mime);
      }
      // The first-page image is copied the same way: a fork that lost its thumbnails
      // would redraw every PDF card as a bare name.
      let thumb = "";
      if (a.thumb) {
        thumb = `uploads/${a.id}/thumb.png`;
        await this.workspace.writeFileBytes(thumb, base64ToBytes(a.thumb), "image/png");
      }
      if ((a.bytes ?? 0) > 0) this.ctx.waitUntil(this.registry().addStorageBytes(a.bytes));
      this.exec(
        `INSERT OR REPLACE INTO attachments (id, kind, name, mime, text, path, thumb_path, bytes, ts, used)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        a.id,
        a.kind,
        a.name,
        a.mime,
        a.text,
        path,
        thumb,
        a.bytes,
        a.ts,
        used
      );
    }

    const messages = snapshot.messages ?? [];
    if (messages.length > 0) await this.addMessages(messages);

    // Ids are preserved across the copy, so which question carried which file — and
    // what each question actually said — travels as its own rows.
    for (const link of snapshot.links ?? []) {
      this.exec(
        `INSERT OR REPLACE INTO message_files (message_id, attachment_id) VALUES (?, ?)`,
        link.message_id,
        link.attachment_id
      );
    }
    for (const row of snapshot.texts ?? []) {
      this.exec(
        `INSERT OR REPLACE INTO message_text (message_id, text) VALUES (?, ?)`,
        row.message_id,
        row.text
      );
    }
  }

  /**
   * Every object this session spilled into the bucket. It is swept by key prefix
   * rather than by what the workspace remembers, so a row lost to a failed write or
   * an interrupted delete cannot leave its bytes behind for good.
   */
  private async sweepBucket(): Promise<void> {
    let cursor: string | undefined;
    do {
      const page = await this.env.FILES.list({ prefix: `${this.name}/`, cursor });
      // R2 takes up to 1000 keys per delete call, and a page holds at most 1000.
      if (page.objects.length > 0) {
        await this.env.FILES.delete(page.objects.map((o) => o.key));
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }

  /** Clear the session in place: transcript, files, and pending tasks. */
  /**
   * Run a bang command and say what it did. The answer is written for whoever typed
   * it, because on Telegram it is the only feedback there is.
   *
   * A command that ends the session reports before it acts: destroying the object
   * aborts the isolate, so anything left to say afterwards may never be said. That is
   * what `destroy` is for — the caller sends the reply and then calls `finishDelete`.
   */
  private async runCommand(command: Command): Promise<CommandResult> {
    if (typeof command === "object") return await this.mcpCommand(command);
    // TEMP — remove with the `oom` command itself. Allocates a megabyte at a time
    // until the isolate is killed, to see what a session looks like on the way down
    // and what is left of it afterwards. The strings are held in an array so nothing
    // can be collected, and logged as they go so the log says how far it got.
    if (command === "oom") {
      // Byte buffers rather than strings: a string of one repeated character is the
      // kind of thing a runtime is free to represent cleverly, and 4 GB of them
      // surviving says the allocation was never real. A filled Uint8Array cannot be
      // anything but the bytes it holds.
      const held: Uint8Array[] = [];
      let mb = 0;
      try {
        for (let i = 0; i < 2048; i++) {
          const chunk = new Uint8Array(4 * 1024 * 1024);
          // Written through, so the pages are actually faulted in rather than promised.
          for (let o = 0; o < chunk.length; o += 4096) chunk[o] = (i + o) & 255;
          chunk[chunk.length - 1] = 1;
          held.push(chunk);
          mb += 4;
          if (mb % 16 === 0) {
            console.log(`[oom] holding ${mb} MB across ${held.length} buffers in session ${this.name}`);
          }
        }
      } catch (err) {
        // An allocation failure is a real answer: the runtime refused before it was killed.
        console.log(`[oom] allocation threw at ${mb} MB: ${err instanceof Error ? err.message : err}`);
        return {
          text: `Allocation failed at ${mb} MB: ${err instanceof Error ? err.message : String(err)}`,
          destroy: false,
        };
      }
      return {
        text: `Held ${mb} MB without dying — the limit is not being enforced on this path.`,
        destroy: false,
      };
    }
    if (command === "compact") return await this.compactCommand();
    if (command === "stop") {
      // Counted before the cancel, because cancelling is what makes it zero.
      const running = this.turnsRunning;
      this.stoppedOnPurpose = true;
      // The same teardown `!unstick` does, and for the same reason: cancelling a turn
      // aborts its model call but does not always settle it, and a turn that never
      // settles leaves the concurrency state that makes every later question fail.
      // Stopping one reply must not cost the session the next one.
      this.unstick();
      return {
        text: running
          ? "Stopped. What it had written is kept in the transcript — ask again when you are ready."
          : "Nothing to stop: this session is not answering anything right now.",
        destroy: false,
      };
    }
    if (command === "unstick") {
      this.unstick();
      return {
        text: "Cleared this session's turn state. Everything it holds is still here — ask again.",
        destroy: false,
      };
    }
    if (command === "new" || command === "clear") {
      const row = await this.registry().get(this.sessionId());
      if (!row?.chat_id) {
        return {
          text: "Nothing to move: this session is not tied to a chat. Start a new one from the sidebar.",
          destroy: false,
        };
      }
      return await this.startOver(row, command === "clear");
    }
    await this.registry().remove(this.sessionId());
    return {
      text: "Deleted this session and everything in it. The next message starts over.",
      destroy: true,
    };
  }

  /* -------------------------------------------------------------- compaction -- */

  /**
   * The conversation as the model is to read it: the transcript, with the run of older
   * messages a compaction covered replaced by one message holding its summary.
   *
   * Only the model's view changes. Think's own history — what the chat draws, pages,
   * forks and rewinds — is left exactly as it was, which is why this is an overlay kept
   * here rather than Think's `session.compact()`, whose overlay rewrites that history.
   * A summary whose ends are no longer both in the transcript (a rewind took one) is
   * not applied, and the model gets the whole transcript again.
   */
  private async compactedMessages(): Promise<UIMessage[]> {
    const all = (await this.getMessages()).filter(
      (m) => m.role === "user" || m.role === "assistant"
    );
    const row = this.exec<{ from_id: string; to_id: string; summary: string }>(
      `SELECT from_id, to_id, summary FROM compaction WHERE id = 1`
    )[0];
    if (!row) return all;
    const from = all.findIndex((m) => m.id === row.from_id);
    const to = all.findIndex((m) => m.id === row.to_id);
    if (from === -1 || to < from) return all;
    const summary: UIMessage = {
      id: `${COMPACTION_PREFIX}1`,
      role: "assistant",
      parts: [{ type: "text", text: row.summary }],
    };
    return [...all.slice(0, from), summary, ...all.slice(to + 1)];
  }

  /**
   * Summarise the older part of the conversation into the overlay, keeping the first
   * few messages and roughly `tailTokens` of the most recent ones word for word.
   *
   * Think's reference algorithm does the choosing and the prompt: it protects the
   * head, keeps tool calls with their results, and folds an existing summary into the
   * new one rather than summarising a summary. The call is made with the agent's own
   * model and key, through the same client a turn uses — so a WhatsApp session's
   * no-training rule holds for it too.
   *
   * Returns how many transcript messages the summary now stands for and what the call
   * cost, or null when there is nothing old enough to fold in yet.
   */
  private async compact(tailTokens: number): Promise<{ covered: number; cost: number } | null> {
    this.ensureSchema();
    const history = await this.compactedMessages();
    const previous = this.exec<{ from_id: string }>(
      `SELECT from_id FROM compaction WHERE id = 1`
    )[0];
    const overlaid = history.some((m) => m.id.startsWith(COMPACTION_PREFIX));
    let cost = 0;
    const summarise = createCompactFunction({
      tailTokenBudget: tailTokens,
      summarize: async (prompt) => {
        const result = await generateText({
          model: this.openrouter().chat(this.config().model),
          prompt,
        });
        const reported = result.usage.raw?.cost;
        cost = this.priceOf(
          result.usage.inputTokens ?? 0,
          result.usage.outputTokens ?? 0,
          typeof reported === "number" ? reported : undefined
        );
        return result.text;
      },
    });
    const result = await summarise(history as Parameters<typeof summarise>[0]);
    if (!result) return null;

    // A later summary covers everything the earlier one did, so it starts where that
    // one started — the earlier summary's text is already folded into this one.
    const from = overlaid && previous ? previous.from_id : result.fromMessageId;
    this.exec(
      `INSERT OR REPLACE INTO compaction (id, from_id, to_id, summary, ts) VALUES (1, ?, ?, ?, ?)`,
      from,
      result.toMessageId,
      result.summary,
      Date.now()
    );
    const all = (await this.getMessages()).filter(
      (m) => m.role === "user" || m.role === "assistant"
    );
    const covered =
      all.findIndex((m) => m.id === result.toMessageId) - all.findIndex((m) => m.id === from) + 1;
    return { covered, cost };
  }

  /**
   * Compact before a turn when the last one ran close to the window.
   *
   * Measured by what the provider reported for the largest prompt of the previous turn
   * — system prompt, tools, parsed files and all — rather than by an estimate of the
   * words, and only a turn since the last compaction counts, so one oversized turn does
   * not summarise again before the smaller prompt has been measured.
   *
   * Never costs the turn its answer: a summary that fails is logged and the turn runs
   * on the history as it stands, exactly as it would have without compaction.
   */
  private async maybeCompact(config: Config): Promise<void> {
    const threshold = this.settings().compact_after_tokens;
    if (threshold <= 0) return;
    this.ensureSchema();
    const last = this.exec<{ context_tokens: number; ts: number }>(
      // Questions have usage rows too, holding nothing; only a reply measured a prompt.
      `SELECT context_tokens, ts FROM usage WHERE context_tokens > 0 ORDER BY ts DESC LIMIT 1`
    )[0];
    if (!last || last.context_tokens <= threshold) return;
    const since = this.exec<{ ts: number }>(`SELECT ts FROM compaction WHERE id = 1`)[0];
    if (since && last.ts <= since.ts) return;
    try {
      // A fifth of the budget kept verbatim: recent enough to carry on from, small
      // enough that the next turn lands well under the line.
      const done = await this.compact(Math.floor(threshold / 5));
      if (!done) return;
      this.turnUsage.cost += done.cost;
      this.turnUsage.reported += done.cost;
      console.log(
        `session ${this.name}: compacted ${done.covered} messages at ${last.context_tokens} prompt tokens (${config.model})`
      );
    } catch (err) {
      console.error(
        `compaction failed in session ${this.name}: ${err instanceof Error ? err.message : err}`
      );
    }
  }

  /**
   * `!compact`: summarise now, whatever the size, keeping only the last exchange word
   * for word. Refused while a reply is being written — the turn has already read the
   * history it is answering from — and once the month's spend is used up, because the
   * summary is a model call like any other.
   */
  private async compactCommand(): Promise<CommandResult> {
    if (this.turnsRunning > 0) {
      return {
        text: "A reply is still being written. Wait for it to finish (or `!stop` it), then `!compact`.",
        destroy: false,
      };
    }
    const blocked = await this.spendBlocked();
    if (blocked) return { text: blocked, destroy: false };
    try {
      await this.loadConfig();
      const done = await this.compact(0);
      if (!done) {
        return { text: "Nothing to compact yet: the conversation is still short.", destroy: false };
      }
      if (done.cost > 0) await this.registry().addSpend(done.cost);
      return {
        text:
          `Compacted: ${done.covered} earlier messages are now a summary the agent reads instead. ` +
          "The transcript itself is unchanged.",
        destroy: false,
      };
    } catch (err) {
      return {
        text: `Could not compact: ${err instanceof Error ? err.message : String(err)}`,
        destroy: false,
      };
    }
  }

  /**
   * `!enable-mcp` / `!disable-mcp`. Enabling switches every tool back on and re-reads
   * the server's tool list, so a server that cannot be reached says so here rather
   * than on the next turn. Disabling leaves the tool selection alone.
   */
  private async mcpCommand({ mcp, server }: McpCommand): Promise<CommandResult> {
    const reg = this.registry();
    const wanted = server.toLowerCase();
    const row = (await reg.mcpServers()).find((s) => s.name.toLowerCase() === wanted);
    if (mcp === "disable") {
      const done = row && (await reg.updateMcpServer(row.id, { enabled: 0 }));
      return {
        text: done
          ? "Disabled. You can also partially enable a few tools that are required from the web UI."
          : "Error disabling MCP server, please visit the web UI.",
        destroy: false,
      };
    }
    if (!row) return { text: `No MCP server named "${server}".`, destroy: false };
    const updated = await reg.updateMcpServer(row.id, { enabled: 1, disabled_tools: "[]" });
    if (!updated || !mcpServerReady(updated)) {
      return {
        text: `${row.name} is not connected. Connect it from the web UI.`,
        destroy: false,
      };
    }
    try {
      const tools = await withMcpAuth(updated, reg, (client) => client.listTools());
      await reg.updateMcpServer(row.id, {
        tools_json: JSON.stringify(tools),
        tools_synced_at: Date.now(),
        last_error: "",
      });
      await this.loadConfig();
      if (!enabled(this.config(), "mcp")) {
        return {
          text: `${row.name} is enabled, but MCP is switched off for this agent. Turn it on from the web UI.`,
          destroy: false,
        };
      }
      return {
        text:
          `${row.name} enabled with all ${tools.length} tools. This can sharply raise token use — ` +
          `disable it when not needed, or switch off unused tools from the web UI.`,
        destroy: false,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await reg.noteMcpError(row.id, message);
      return { text: `Error connecting to ${row.name}: ${message}`, destroy: false };
    }
  }

  /**
   * Hand the chat to a fresh session and go quiet. The successor is created here
   * rather than left to the next message, because the scheduled tasks have to be
   * moved onto a session that already exists — and it has to be the same one the next
   * message will land in, which is what makes the id come from the registry.
   *
   * `discard` is the difference between `!new` and `!clear`. `!new` detaches the chat
   * and leaves the old conversation readable in the browser; `!clear` drops it. Either
   * way the old session loses the chat before the successor claims it, so no moment
   * exists where two sessions answer the same messages.
   *
   * Dropping the row rather than detaching it is also what lets `!clear` work at the
   * session ceiling: the slot is free by the time the successor asks for one. The cost
   * is that a create that still fails leaves nothing behind — which is what was asked
   * for, and the next message gets a fresh session in the same chat anyway.
   */
  private async startOver(row: SessionRow, discard: boolean): Promise<CommandResult> {
    // Asked before the chat is detached. A successor that cannot be created would
    // otherwise leave the chat belonging to nothing, and the next message would only
    // meet the same ceiling with the conversation already cut loose. `!clear` frees a
    // slot as it goes, so the ceiling cannot stop it.
    const { max_sessions } = await this.settingsNow();
    if (!discard && (await this.registry().countSessions()) >= max_sessions) {
      return { text: sessionLimitMessage(max_sessions), destroy: false };
    }
    const tasks = this.taskHandover();
    // Named before this session's row goes, and only then dropped. The successor is a
    // Durable Object picked by name, so a name this object already answers to would
    // make it *this* object — which `!clear` is about to destroy. Asking while the row
    // is still there is what guarantees a different one.
    const next = await this.registry().freeChatSessionId(
      this.agentId(),
      row.chat_id,
      row.chat_thread_id,
      row.source === "whatsapp" ? "wa" : "tg"
    );
    // Dropping the row also frees a session slot, which is what lets `!clear` work at
    // the ceiling: `create` counts below.
    if (discard) await this.registry().remove(this.sessionId());
    else await this.registry().detachChat(this.sessionId());
    try {
      await this.registry().create(
        next,
        "New session",
        this.env.SessionAgent.idFromName(next).toString(),
        {
          source: row.source,
          chat_id: row.chat_id,
          chat_type: row.chat_type,
          chat_username: row.chat_username,
          chat_thread_id: row.chat_thread_id,
        },
        max_sessions
      );
    } catch (err) {
      // Only reachable if the agent filled up between the check above and here. The
      // chat no longer belongs to this session either way, so say what state it is in
      // rather than pretending the handover worked.
      return {
        text: discard
          ? `${(err as Error).message} This conversation has been deleted; send a message to start a new one.`
          : `${(err as Error).message} This conversation has been closed; delete a session and send a message to start a new one.`,
        destroy: discard,
      };
    }

    const opening = discard
      ? "Starting fresh. This conversation and everything in it has been deleted; anything said here from now on goes to a new session."
      : "Starting fresh. This conversation is kept and still readable in the browser; anything said here from now on goes to a new session.";
    if (tasks.length === 0) return { text: opening, destroy: discard };

    try {
      const stub = this.env.SessionAgent.get(this.env.SessionAgent.idFromName(next));
      const { moved, failed } = await stub.adoptTasks(tasks);
      // Only what the successor actually took on is dropped here, so a task that
      // could not be re-created still runs somewhere rather than nowhere.
      if (moved > 0) for (const task of this.listTasks()) await this.cancelTask(task.id);
      const carried = `${moved} scheduled ${moved === 1 ? "task" : "tasks"} moved across.`;
      return {
        text:
          failed > 0
            ? `${opening}\n\n${carried} ${failed} could not be — their time has passed.`
            : `${opening}\n\n${carried}`,
        destroy: discard,
      };
    } catch (err) {
      console.error(
        `task handover failed from ${this.name} to ${next}: ${err instanceof Error ? err.message : String(err)}`
      );
      return {
        text: discard
          ? `${opening}\n\nIts scheduled tasks could not be moved and go with it.`
          : `${opening}\n\nIts scheduled tasks could not be moved and stay with the old session.`,
        destroy: discard,
      };
    }
  }

  /**
   * The half of `!delete` — and of `!clear`, once the chat has moved on — that cannot
   * be reported: the object drops its own storage, which ends the isolate running this
   * code.
   */
  private async finishDelete(): Promise<void> {
    this.releaseStorage();
    await this.sweepBucket();
    this.ctx.waitUntil(this.destroy());
  }

  /**
   * Free a session whose turns have stopped completing. A turn that dies without
   * settling — an isolate evicted mid-flight, a stream that never terminated — leaves
   * concurrency state behind that turns every later question into a failure, and no
   * amount of asking again clears it.
   *
   * This is deliberately narrower than a reset: in-flight turns are cancelled and the
   * execution state is dropped, but messages, files and memory all stay. The
   * conversation survives; only the stuck machinery around it goes.
   */
  private unstick(): { cancelled: boolean } {
    this.cancelAllChats();
    this.resetTurnState();
    // Nothing is running once those two have run, whatever the count had drifted to.
    this.turnsRunning = 0;
    return { cancelled: true };
  }

  private async reset(): Promise<void> {
    await this.session.clearMessages();
    // Counted before the rows go: after the delete there is nothing left to total.
    this.releaseStorage();
    this.exec(`DELETE FROM usage`);
    this.exec(`DELETE FROM compaction`);
    this.exec(`DELETE FROM message_files`);
    this.exec(`DELETE FROM message_text`);
    this.exec(`DELETE FROM attachments`);
    await this.workspace.rm("uploads", { recursive: true, force: true });
    await this.workspace.rm(PARSE_CACHE_DIR, { recursive: true, force: true });
    this.exec(`DELETE FROM file_cache`);
    // Anything the model wrote for itself goes too, bytes in the bucket included.
    for (const entry of await this.workspace.readDir("/")) {
      await this.workspace.rm(entry.path, { recursive: true, force: true });
    }
    for (const task of this.listTasks()) await this.cancelTask(task.id);
  }

  /* ------------------------------------------------------------- scheduling -- */

  /**
   * Accepts the three ways a task gets asked for: "in 900 seconds", "at this
   * timestamp", and "every day at nine" as a cron expression.
   */
  private async scheduleTask(when: string, prompt: string): Promise<ScheduledTask> {
    const seconds = Number(when);
    const isCron = /^[\d*/,\-\s]+$/.test(when) && when.trim().split(/\s+/).length === 5;
    let at: Date | number | string;
    if (Number.isFinite(seconds)) {
      at = seconds;
    } else if (isCron) {
      at = when.trim();
    } else {
      const date = new Date(when);
      if (Number.isNaN(date.getTime())) {
        throw new Error(`"${when}" is not a delay, a timestamp or a cron expression`);
      }
      at = date;
    }
    const schedule = await this.schedule(at as never, "runScheduledTask", { prompt });
    return describeSchedule(schedule as Schedule<{ prompt: string }>);
  }

  /**
   * The user's scheduled prompts. Think keeps schedules of its own — recovery and
   * turn continuations — so only this agent's own callback is listed.
   */
  private listTasks(): ScheduledTask[] {
    return [...this.getSchedules<{ prompt: string }>()]
      .filter((s) => s.callback === "runScheduledTask")
      .map(describeSchedule);
  }

  private async cancelTask(id: string): Promise<boolean> {
    return await this.cancelSchedule(id);
  }

  /**
   * The pending tasks as instructions another session can re-create them from. The
   * raw schedules are read rather than `listTasks`, because what that returns is
   * written to be read by a person — a cron expression there carries a "cron " label
   * that `scheduleTask` would not accept back.
   */
  private taskHandover(): TaskHandover[] {
    return [...this.getSchedules<{ prompt: string }>()]
      .filter((s) => s.callback === "runScheduledTask")
      .map((s) => ({
        when: s.type === "cron" ? s.cron : new Date(s.time * 1000).toISOString(),
        prompt: s.payload?.prompt ?? "",
      }));
  }

  /**
   * Take on the tasks of the session this chat used to point at. Called across
   * objects, so it is public: the old session hands its work over on `!new` and then
   * drops it, and a task the successor cannot re-create is reported rather than lost
   * silently.
   */
  async adoptTasks(tasks: TaskHandover[]): Promise<{ moved: number; failed: number }> {
    this.ensureSchema();
    let moved = 0;
    let failed = 0;
    for (const task of tasks) {
      try {
        await this.scheduleTask(task.when, task.prompt);
        moved++;
      } catch {
        // A one-off whose time passed during the handover can no longer be scheduled.
        failed++;
      }
    }
    return { moved, failed };
  }

  /**
   * A scheduled task runs a turn with nobody watching: the prompt is stored as the
   * user message and the reply lands in the transcript, so the session reads as a
   * conversation when the user comes back to it.
   *
   * The turn is awaited here rather than submitted, and the reply is posted from here
   * rather than from `onChatResponse`. A submitted turn finishes on an invocation that
   * has nothing left to wait for it: on staging the alarm was recorded `canceled`
   * about sixty milliseconds after `onChatResponse` read the session's chat row, which
   * is the Graph call being cut off mid-flight. The transcript had the answer and the
   * phone never got it, silently — the throw that would have been logged never
   * happened, because the whole invocation went away. Awaiting keeps the send inside
   * the alarm that caused it, which is the arrangement the webhook turn already has
   * and the one that demonstrably delivers.
   */
  async runScheduledTask(payload: { prompt: string }) {
    this.ensureSchema();
    await this.loadConfig();
    // A task that comes due over the ceiling is dropped, not queued: it was meant to
    // run at a time that has passed, and running it next month is not what was asked
    // for. Logged, because nobody is watching a scheduled task fail.
    console.log(`scheduled task running in session ${this.name}`);
    const blocked = await this.spendBlocked();
    if (blocked) {
      console.warn(`scheduled task skipped in session ${this.name}: ${blocked}`);
      return;
    }
    // Snapshotted before the turn, for the same reason a webhook turn snapshots: it is
    // the only way to tell the images this task drew from the session's whole history.
    const drawnBefore = this.drawnIds();
    const result = await this.runTurn({
      input: [
        {
          id: crypto.randomUUID(),
          role: "user",
          parts: [{ type: "text", text: `${SCHEDULED_PREFIX}${payload.prompt}` }],
        },
      ],
    });
    if (result.status !== "completed") {
      console.warn(
        `scheduled task ${result.status} in session ${this.name}: ${result.error ?? "no reason given"}`
      );
      return;
    }
    await this.deliverToChat(result.message as unknown as UIMessage, drawnBefore);
  }

  /**
   * What this session knows about itself: the transcript and the LLM spend, which
   * OpenRouter reports exactly per call.
   *
   * Cloudflare's own costs are deliberately absent. See
   * docs/cloudflare-durable-object-costs.md for how to read them from the GraphQL
   * Analytics API, and why measuring them from inside the object does not work.
   */
  private async summary() {
    const row = this.exec<{ prompt: number; completion: number; cost: number }>(
      `SELECT COALESCE(SUM(prompt_tokens), 0) AS prompt,
              COALESCE(SUM(completion_tokens), 0) AS completion,
              COALESCE(SUM(cost_usd), 0) AS cost
       FROM usage`
    )[0];
    const messages = await this.getMessages();

    return {
      session: this.name,
      messages: messages.filter((m) => m.role === "user" || m.role === "assistant").length,
      llm: {
        model: this.model(),
        prompt_tokens: row?.prompt ?? 0,
        completion_tokens: row?.completion ?? 0,
        cost_usd: row?.cost ?? 0,
      },
      tasks: this.listTasks(),
      sqlite_bytes: this.ctx.storage.sql.databaseSize,
      // Facets keep their own storage, which the object's own destroy does not
      // reach. Nothing here creates one; this is the tripwire if that changes.
      sub_agents: this.listSubAgents().length,
    };
  }
}

/* ---------------------------------------------------------------------- utils -- */

/** `a`, `a and b`, `a, b and c` — what a sentence needs and `join` does not give. */
function inWords(items: string[]): string {
  if (items.length < 2) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function isAudioAttachment(a: Attachment): boolean {
  return a.mime.startsWith("audio/") || a.mime.startsWith("video/");
}

/** A PDF by mime, or by name when the browser sends no type at all. */
function isPdf(mime: string, name: string): boolean {
  return mime === "application/pdf" || /\.pdf$/i.test(name);
}

/** Attachment rows carry a whole file; the API sends everything except the bytes. */
function publicAttachment(a: Attachment) {
  return {
    id: a.id,
    kind: a.kind,
    name: a.name,
    mime: a.mime,
    bytes: a.bytes,
    chars: a.text.length,
    // Enough of the text (or of an audio transcript, once one exists) for the UI.
    preview: a.kind === "text" ? a.text.slice(0, 400) : "",
    /** Whether a first-page image exists to draw on the file card. */
    thumb: a.thumb_path !== "",
  };
}

/**
 * What a failure may say in a chat bubble. The raw error can be a provider payload of
 * many thousands of characters — a schema dump with a whole parsed document inside it —
 * and pasting that at someone tells them nothing while burying the reply. The full text
 * goes to the log, where it can be read; the chat gets one line.
 */
function reportable(error: unknown, session: string): string {
  const raw = error instanceof Error ? error.message : String(error);
  console.error(`turn error in session ${session}: ${raw.slice(0, 4000)}`);

  // The platform's own failures name internals — SQL statements, isolates, reset
  // reasons — and none of that is an answer to the person who asked a question.
  if (/code was updated|reset because its code/i.test(raw)) {
    return "Session restarted before your message was processed.";
  }
  if (/exceeded its memory limit|Exceeded Memory/i.test(raw)) {
    return "This session ran out of memory and was reset. Send a new message or start a new conversation.";
  }
  if (/Durable Object.*(reset|reload)|isolate/i.test(raw)) {
    return "The session crashed while answering. Send a new message or start a new conversation.";
  }
  if (/Type validation failed|invalid_union|Invalid input/i.test(raw)) {
    return "The provider sent back a response this client could not read.";
  }
  if (/rate.?limit|429/i.test(raw)) return "The provider is rate limiting this key.";
  if (/credit|quota|402/i.test(raw)) return "The provider rejected the call for credits or quota.";
  if (/context length|too large|413/i.test(raw)) return "That turn was too large for the model's context.";

  // Anything unrecognised: the first line only, short enough to read.
  const first = raw.split("\n")[0].trim();
  return first.length > 200 ? `${first.slice(0, 200)}…` : first || "The turn failed.";
}

/**
 * OpenRouter attaches an `annotations` array to the assistant delta whenever a plugin
 * enriched the request — the file parser adds one entry per parsed document, carrying
 * the whole extracted PDF (text plus base64 page images). The AI SDK's OpenAI chat
 * schema only knows the `url_citation` annotation, so any other kind fails validation
 * and kills the stream after the request was already paid for. Nothing here reads
 * annotations, so the safe move is to drop the ones the SDK cannot parse before it
 * ever sees them.
 */
/**
 * OpenRouter only prices a call if it is asked to: without `usage.include`, the usage
 * object comes back with token counts and no `cost`, which is why an estimate from a
 * price table was the only figure available. The AI SDK has no field for this, so it
 * is set on the wire, next to the other things this wrapper fixes up.
 */
type ContentPart = { type?: string; text?: string; cache_control?: { type: string } };

type ChatRequestBody = {
  model?: string;
  usage?: { include?: boolean };
  provider?: { data_collection?: "allow" | "deny" };
  messages?: { role?: string; content?: string | ContentPart[] }[];
};

/** Anthropic's five-minute cache, the only kind a breakpoint here asks for. */
const CACHE_CONTROL = { type: "ephemeral" } as const;

/**
 * The two things an OpenRouter request wants that the AI SDK does not send: the usage
 * block carrying what the call actually cost, and — on Anthropic — the breakpoint
 * saying where the cacheable prefix ends.
 */
export function prepareOpenRouterRequest(
  init: RequestInit | undefined,
  noTrain = false
): RequestInit | undefined {
  if (!init || typeof init.body !== "string") return init;
  try {
    const body = JSON.parse(init.body) as ChatRequestBody;
    const reported = body.usage?.include === true;
    const marked = markCacheablePrefix(body);
    if (reported && !marked && !noTrain) return init;
    body.usage = { ...body.usage, include: true };
    if (noTrain) body.provider = { ...body.provider, data_collection: "deny" };
    return { ...init, body: JSON.stringify(body) };
  } catch {
    return init;
  }
}

/**
 * Mark where the cacheable prefix ends, for the provider that has to be asked.
 *
 * Every model this Worker offers caches prompt prefixes, but only Anthropic's needs
 * telling: OpenAI, DeepSeek and Gemini all do it on their own, and Anthropic does
 * nothing without an explicit breakpoint. It is worth asking for because of what sits
 * in that prefix — a connected MCP server can put tens of thousands of tokens of JSON
 * Schema in front of every request, and the tools are re-sent on every tool round of
 * every turn. A cache read costs a tenth of what writing it did.
 *
 * The breakpoint goes on the system prompt, the last thing before the conversation
 * starts. OpenRouter renders `tools` ahead of `system`, so one breakpoint there covers
 * the tool definitions as well — and because it sits before the messages, a new
 * message does not move it and cannot force the tools to be written again. That is
 * why it is not left to OpenRouter's own top-level `cache_control`, which advances
 * with the conversation and so pays to write the whole prefix afresh every turn.
 */
function markCacheablePrefix(body: ChatRequestBody): boolean {
  if (!(body.model ?? "").startsWith("anthropic/")) return false;
  const messages = body.messages;
  if (!Array.isArray(messages)) return false;
  // The last system message: what precedes it is prefix, what follows it is not.
  const system = [...messages].reverse().find((m) => m?.role === "system");
  if (!system) return false;

  if (typeof system.content === "string") {
    if (!system.content) return false;
    system.content = [{ type: "text", text: system.content, cache_control: CACHE_CONTROL }];
    return true;
  }
  if (!Array.isArray(system.content)) return false;
  // A second breakpoint on the same prefix would spend one of the four Anthropic
  // allows and cache nothing further.
  if (system.content.some((part) => part?.cache_control)) return false;
  const last = [...system.content].reverse().find((part) => part?.type === "text");
  if (!last) return false;
  last.cache_control = CACHE_CONTROL;
  return true;
}

function stripUnsupportedAnnotations(
  res: Response,
  onFiles?: (files: FileAnnotation[]) => void,
  onCost?: (cost: number) => void
): Response {
  const body = res.body;
  if (!body) return res;
  if (!/text\/event-stream/i.test(res.headers.get("content-type") ?? "")) return res;

  const dropped: FileAnnotation[] = [];
  const keep = (list: unknown) => {
    if (!Array.isArray(list)) return list;
    for (const a of list) {
      // The parse is worth keeping even though the SDK cannot read it: sending it back
      // on the next turn is what saves parsing the same PDF again.
      if ((a as FileAnnotation)?.type === "file") dropped.push(a as FileAnnotation);
    }
    return list.filter((a) => (a as { type?: string })?.type === "url_citation");
  };

  // The parse is reported as soon as a frame carries it: a reader that stops early
  // never reaches the flush, and losing the capture there costs a re-parse.
  const report = () => {
    if (dropped.length === 0) return;
    const files = dropped.splice(0, dropped.length);
    onFiles?.(files);
  };

  const clean = (payload: string): string => {
    // The priced usage rides on the last frame of the stream, and is read on the way
    // past — the SDK does not surface it, and it is the only true cost of the call.
    if (payload.includes('"cost"')) {
      try {
        const cost = (JSON.parse(payload) as { usage?: { cost?: unknown } }).usage?.cost;
        if (typeof cost === "number") onCost?.(cost);
      } catch {
        // Not a usage frame after all.
      }
    }
    if (!payload.includes('"annotations"')) return payload;
    try {
      const json = JSON.parse(payload) as {
        choices?: { delta?: { annotations?: unknown }; message?: { annotations?: unknown } }[];
      };
      let touched = false;
      for (const choice of json.choices ?? []) {
        for (const slot of [choice.delta, choice.message]) {
          if (!slot || slot.annotations == null) continue;
          const kept = keep(slot.annotations);
          if (Array.isArray(kept) && kept.length === 0) delete slot.annotations;
          else slot.annotations = kept;
          touched = true;
        }
      }
      return touched ? JSON.stringify(json) : payload;
    } catch {
      // Not JSON we understand — pass it through and let the SDK decide.
      return payload;
    }
  };

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  const rewrite = (line: string) => {
    if (!line.startsWith("data: ") || line.slice(6).trim() === "[DONE]") return line;
    const out = `data: ${clean(line.slice(6))}`;
    report();
    return out;
  };

  const stream = body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        // Rewriting needs whole lines, so only complete ones are forwarded here.
        let cut: number;
        while ((cut = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 1);
          controller.enqueue(encoder.encode(`${rewrite(line)}\n`));
        }
      },
      flush(controller) {
        buffer += decoder.decode();
        if (buffer) controller.enqueue(encoder.encode(rewrite(buffer)));
        report();
      },
    })
  );

  return new Response(stream, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
}

/**
 * What to say in the chat when a turn does not complete. The status says what kind of
 * failure it was, and Think's own error says why — worth passing on, because the two
 * cases want opposite things from the user: an aborted or errored turn is worth
 * retrying, while a turn that never ran is a session to reset, and "try again" sends
 * someone in a loop.
 */
function turnFailure(status: string, error?: string): string {
  const why = error ? ` (${reportable(error, "turn")})` : "";
  if (status === "aborted") return `That turn was cut short${why}. Ask again?`;
  if (status === "skipped") {
    return `That turn was skipped${why} — an earlier one is probably still running. Give it a moment, then ask again.`;
  }
  // The model refusing the request is not the session being broken, and telling
  // someone to reset a session that is fine costs them the conversation for nothing.
  if (/provider|upstream|rate.?limit|credit|quota|context length|too large/i.test(error ?? "")) {
    return `The model could not answer that${why}. Nothing here is broken — this is the provider, so it is worth trying again, or switching model in settings.`;
  }
  return `That turn did not finish${why}. If it keeps happening, !unstick clears this session's turn state.`;
}

/** Every text part of a message, joined — what the transcript API calls its content. */
function textOf(message: UIMessage | undefined): string {
  if (!message) return "";
  return message.parts
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("");
}

/**
 * How a turn unfolded, read back off the message Think stored: text it wrote, and the
 * tools it ran between writing. A tool part carries its own outcome, so a failed tool
 * still draws as a failed line when the session is reopened.
 */
function stepsOf(message: UIMessage): TurnStep[] {
  const steps: TurnStep[] = [];
  for (const part of message.parts) {
    if (part.type === "text") {
      const last = steps[steps.length - 1];
      if (last?.kind === "text") last.text += part.text;
      else steps.push({ kind: "text", text: part.text });
      continue;
    }
    if (!part.type.startsWith("tool-") && part.type !== "dynamic-tool") continue;
    const called = part as { type: string; toolName?: string; state?: string };
    const name = called.toolName ?? called.type.replace(/^tool-/, "");
    const ok = called.state !== "output-error";
    const last = steps[steps.length - 1];
    if (last?.kind === "tools") last.tools.push({ name, ok });
    else steps.push({ kind: "tools", tools: [{ name, ok }] });
  }
  return steps;
}

/**
 * OpenRouter reports the exact dollar cost of a call, and the AI SDK passes the raw
 * usage object through untouched, which is where it lands.
 */
/**
 * What of this step's prompt was served from cache, as OpenRouter reports it. Zero
 * when the provider says nothing, which is also what a miss looks like — the two are
 * worth separating only against a provider known to be caching.
 */
export function cachedPromptTokens(step: StepContext): number {
  const raw = (step.usage as { raw?: Record<string, unknown> } | undefined)?.raw;
  const details = raw?.prompt_tokens_details as { cached_tokens?: unknown } | undefined;
  return typeof details?.cached_tokens === "number" ? details.cached_tokens : 0;
}

function openrouterCost(step: StepContext): number | undefined {
  const raw = (step.usage as { raw?: Record<string, unknown> } | undefined)?.raw;
  const cost = raw?.cost;
  return typeof cost === "number" ? cost : undefined;
}

function describeSchedule(schedule: Schedule<{ prompt: string }>): ScheduledTask {
  const when =
    schedule.type === "cron"
      ? `cron ${(schedule as { cron: string }).cron}`
      : new Date(schedule.time * 1000).toISOString();
  return { id: schedule.id, prompt: schedule.payload?.prompt ?? "", when };
}

function isTextLike(mime: string, name: string): boolean {
  return (
    mime === "application/json" ||
    mime === "application/xml" ||
    mime === "application/x-yaml" ||
    TEXT_EXTENSIONS.test(name)
  );
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;
}

function base64ToBytes(encoded: string): ArrayBuffer {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function formatMb(bytes: number): string {
  return bytes >= 1_000_000
    ? `${(bytes / 1_000_000).toFixed(1)} MB`
    : `${Math.round(bytes / 1000)} kB`;
}

function bytesToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  // Chunked, because spreading a megabyte into String.fromCharCode blows the stack.
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(binary);
}

/**
 * The format name OpenRouter wants beside the audio bytes. It is picky about the
 * container, so anything unrecognised is reported here rather than as a 400 from
 * upstream.
 */
function audioFormat(mime: string, name: string): string {
  const subtype = mime.split("/")[1]?.split(";")[0]?.toLowerCase() ?? "";
  const extension = name.split(".").pop()?.toLowerCase() ?? "";
  const candidate = AUDIO_FORMATS[subtype] ?? AUDIO_FORMATS[extension];
  if (!candidate) {
    throw new Error(
      `${name} is not an audio format transcription accepts. WAV, MP3 and Ogg Opus work.`
    );
  }
  return candidate;
}

/**
 * Ogg is here because every voice note is one — both chat apps record Opus in Ogg and
 * neither offers anything else — so refusing it would mean refusing the clips people
 * actually send. Whether it goes through is the transcription model's call: the default
 * one reads Ogg, and a model that does not answers with a 400 that the tool reports.
 */
const AUDIO_FORMATS: Record<string, string> = {
  wav: "wav",
  wave: "wav",
  "x-wav": "wav",
  mp3: "mp3",
  mpeg: "mp3",
  mpga: "mp3",
  ogg: "ogg",
  opus: "ogg",
};
