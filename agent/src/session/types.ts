import type { OpenAIProvider } from "@ai-sdk/openai";
import { Workspace } from "@cloudflare/shell";
import type { UIMessage } from "ai";
import { SessionAgent } from "../agent";
import type { ScheduledTask } from "../capabilities";
import type { Env } from "../env";
import type { McpServerRow } from "../mcp";
import { type Config, type Memory, SessionRegistry } from "../registry";
import type { DeploymentSettings } from "../settings";
import { publicAttachment } from "./files";
import { LiveTurns } from "./live";

/**
 * A file the user attached or an image the agent drew. Bytes live in the workspace; this
 * row is what the UI and the turn need.
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
 * One segment of an assistant turn: text, or the tools run between texts. Derived from
 * Think's message parts, not stored.
 */
export type TurnStep =
  { kind: "text"; text: string } | { kind: "tools"; tools: { name: string; ok: boolean }[] };

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

/**
 * A pending task, reduced to what re-creating it needs. `when` is a cron expression
 * or an ISO timestamp — the two forms `scheduleTask` reads back.
 */
export type TaskHandover = { when: string; prompt: string };

/**
 * Usage accumulated for the turn that is running. `reported` is OpenRouter's own cost;
 * `peak` is the largest single prompt, which compaction measures against.
 */
export type TurnUsage = {
  prompt: number;
  completion: number;
  cached: number;
  cost: number;
  reported: number;
  peak: number;
  started: number;
};

export function emptyUsage(): TurnUsage {
  return { prompt: 0, completion: 0, cached: 0, cost: 0, reported: 0, peak: 0, started: 0 };
}

/**
 * What running turns have done that later code needs. `running` counts turns in flight
 * (approximate; `!stop`/`!unstick` zero it). `stoppedOnPurpose` marks a requested stop
 * until the next question. `scheduled`: WhatsApp owes a 24-hour-window note.
 */
export type TurnState = { running: number; stoppedOnPurpose: boolean; scheduled: boolean };

/**
 * What the `session/*` modules may use of a `SessionAgent`. The object builds this from
 * its private state, so the modules hold the logic without widening its RPC surface.
 */
export type SessionHost = {
  /** The routed object name, which may be URL-encoded; see `sessionId`. */
  name(): string;
  /** This session's id as the registry stores it. */
  sessionId(): string;
  agentId(): string;
  env: Env;
  ctx: DurableObjectState;
  workspace: Workspace;
  exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): T[];
  ensureSchema(): void;
  registry(): DurableObjectStub<SessionRegistry>;
  config(): Config;
  settings(): DeploymentSettings;
  settingsNow(): Promise<DeploymentSettings>;
  loadConfig(): Promise<void>;
  memories(): Memory[];
  mcpServers(): McpServerRow[];
  modelSeesImages(model: string): Promise<boolean>;
  openrouter(): OpenAIProvider;
  openrouterKey(): string;
  model(): string;
  usage(): TurnUsage;
  turn: TurnState;
  live: LiveTurns;
  getMessages(): Promise<UIMessage[]>;
  addMessages(messages: UIMessage[]): Promise<unknown>;
  deleteMessages(ids: string[]): unknown;
  runTurn: SessionAgent["runTurn"];
  unstick(): { cancelled: boolean };
  finishDelete(): Promise<void>;
  scheduleTask(when: string, prompt: string): Promise<ScheduledTask>;
  listTasks(): ScheduledTask[];
  cancelTask(id: string): Promise<boolean>;
  taskHandover(): TaskHandover[];
};
