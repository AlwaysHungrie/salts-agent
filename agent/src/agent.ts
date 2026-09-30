import { createOpenAI } from "@ai-sdk/openai";
import { Workspace } from "@cloudflare/shell";
import { type StepContext, Think, type TurnConfig, type TurnContext } from "@cloudflare/think";
import type { Schedule } from "agents";
import type { UIMessage } from "ai";
import { enabled, type ScheduledTask } from "./capabilities";
import { telegramInbound, whatsappInbound } from "./channel";
import type { Env } from "./env";
import type { McpServerRow } from "./mcp";
import { modelCatalog } from "./models";
import {
  cachedPromptTokens,
  openrouterCost,
  prepareOpenRouterRequest,
  priceOf,
  stripUnsupportedAnnotations,
  turnCost,
} from "./openrouter";
import { AGENT_SEPARATOR, agentIdOf, type Config, DEFAULT_CONFIG, type Memory } from "./registry";
import { applyMigrations } from "./schema";
import {
  drawnIds,
  pendingAttachments,
  releaseStorage,
  removeAttachment,
  serveAttachment,
  serveThumbnail,
  storedBytes,
  sweepBucket,
  upload,
} from "./session/attachments";
import { channelTurn, deliverToChat } from "./session/channels";
import { maybeCompact } from "./session/compaction";
import { capabilityTools, modelMessages, systemPrompt } from "./session/context";
import { cacheFileAnnotations } from "./session/documents";
import { PARSE_CACHE_DIR, publicAttachment } from "./session/files";
import { describeSchedule, textOf } from "./session/format";
import { LiveTurns } from "./session/live";
import { SESSION_AGENT_MIGRATIONS } from "./session/migrations";
import { exportTurns, importTurns, transcriptPage } from "./session/transcript";
import { nameSession, runChat, spendBlocked, streamChat } from "./session/turns";
import {
  emptyUsage,
  type SessionHost,
  type Snapshot,
  type TaskHandover,
  type TurnState,
  type TurnUsage,
} from "./session/types";
import { type DeploymentSettings, deploymentSettings } from "./settings";
import type { TelegramMessage } from "./telegram";
import type { WhatsappInbound } from "./whatsapp";

/**
 * Prefix on a scheduled task's user message: the only durable trace of why the turn ran,
 * since the reply is written by a later invocation with no memory of who asked.
 */
export const SCHEDULED_PREFIX = "[scheduled task] ";

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

  /** Usage accumulated by `onStepFinish` for the turn that is running now. */
  private turnUsage: TurnUsage = emptyUsage();

  /** What the running turns have done that later code reads; see `TurnState`. */
  private turn: TurnState = { running: 0, stoppedOnPurpose: false, scheduled: false };

  /** The streaming turn, kept so a browser that reloads mid-reply can catch up. */
  private live = new LiveTurns();

  /**
   * What the `session/*` modules see of this object. The object stays one Durable
   * Object; the modules hold the logic and reach its state only through here.
   */
  private host: SessionHost = {
    name: () => this.name,
    sessionId: () => this.sessionId(),
    agentId: () => this.agentId(),
    env: this.env,
    ctx: this.ctx,
    workspace: this.workspace,
    exec: (query, ...bindings) => this.exec(query, ...bindings),
    ensureSchema: () => this.ensureSchema(),
    registry: () => this.registry(),
    config: () => this.config(),
    settings: () => this.settings(),
    settingsNow: () => this.settingsNow(),
    loadConfig: () => this.loadConfig(),
    memories: () => this.memories,
    mcpServers: () => this.mcpServers,
    modelSeesImages: (model) => this.modelSeesImages(model),
    openrouter: () => this.openrouter(),
    openrouterKey: () => this.openrouterKey(),
    model: () => this.model(),
    usage: () => this.turnUsage,
    turn: this.turn,
    live: this.live,
    getMessages: () => this.getMessages(),
    addMessages: (messages) => this.addMessages(messages),
    deleteMessages: (ids) => this.session.deleteMessages(ids),
    runTurn: this.runTurn.bind(this),
    unstick: () => this.unstick(),
    finishDelete: () => this.finishDelete(),
    scheduleTask: (when, prompt) => this.scheduleTask(when, prompt),
    listTasks: () => this.listTasks(),
    cancelTask: (id) => this.cancelTask(id),
    taskHandover: () => this.taskHandover(),
  };

  private exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): T[] {
    return this.ctx.storage.sql.exec(query, ...(bindings as never[])).toArray() as T[];
  }

  /**
   * Session tables for what Think's transcript does not hold: attachments, which message
   * carried them, and turn cost. Migrations run lazily on first touch after a deploy.
   */
  private ensureSchema() {
    if (this.schemaReady) return;
    applyMigrations(this.ctx, SESSION_AGENT_MIGRATIONS);
    this.schemaReady = true;
  }

  /** The owning agent, read from this session's own name (see `sessionName`). */
  private agentId(): string {
    return agentIdOf(this.name);
  }

  /**
   * This session's id as the registry stores it. `this.name` arrives URL-encoded (a colon
   * becomes `%3A`), so lookups must decode it or silently miss the stored row.
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
   * Whether the chosen model accepts images: the agent's own list, then the deployment's
   * catalogue; an unknown id is assumed to (OpenRouter reports a real refusal itself).
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
   * The deployment settings last loaded. Every caller runs after a load; reading them
   * before one is a bug, so this throws.
   */
  private settings(): DeploymentSettings {
    if (!this.currentSettings) throw new Error("deployment settings read before they were loaded");
    return this.currentSettings;
  }

  /**
   * The settings, fetched now: for request paths (upload, transcript page, fork) that
   * enforce a ceiling without loading a config first.
   */
  private async settingsNow(): Promise<DeploymentSettings> {
    this.currentSettings = await deploymentSettings(this.env);
    return this.currentSettings;
  }

  /**
   * The agent's own OpenRouter key. There is deliberately no deployment-wide fallback, so
   * no agent can spend the deployment's credit. Read per call so a new key applies at once.
   */
  private openrouterKey(): string {
    return this.config().openrouter_api_key;
  }

  private model(): string {
    return this.config().model;
  }

  /**
   * OpenRouter through the AI SDK's OpenAI-compatible client. Failed calls are logged with
   * their body first, because the useful detail (`error.metadata.raw`) never reaches the chat.
   */
  private openrouter() {
    const session = this.name;
    const key = this.openrouterKey();
    // Said here: OpenRouter answers a blank key with a bare 401 that names nothing actionable.
    if (!key) {
      throw new Error("OpenRouter API key is missing. Add it in Settings.");
    }
    return createOpenAI({
      apiKey: key,
      baseURL: "https://openrouter.ai/api/v1",
      fetch: async (input, init) => {
        // Meta's terms bar WhatsApp content from reaching providers that train on it.
        const request = prepareOpenRouterRequest(
          init as RequestInit,
          session.includes(`${AGENT_SEPARATOR}wa-`)
        );
        const res = await fetch(input as RequestInfo, request as RequestInit);
        if (res.ok) {
          return stripUnsupportedAnnotations(
            res,
            (files) => {
              // Writing the parse output outlives the stream, so it is handed to the
              // object's own lifetime rather than awaited inside the reader.
              this.ctx.waitUntil(cacheFileAnnotations(this.host, files));
            },
            (cost) => {
              this.turnUsage.reported += cost;
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
   * Chat completions, not the Responses API: it is the endpoint OpenRouter implements for
   * every model, whereas its Responses endpoint covers only some.
   */
  getModel() {
    return this.openrouter().chat(this.model());
  }

  getSystemPrompt() {
    return systemPrompt(this.host);
  }

  /**
   * Applies the settings page per turn: model, prompt, sampling, reply cap, reasoning
   * effort, context window, and the capability tools that are ready.
   */
  override async beforeTurn(_ctx: TurnContext): Promise<TurnConfig> {
    this.ensureSchema();
    await this.loadConfig();
    const config = this.config();
    this.turnUsage = { ...emptyUsage(), started: Date.now() };
    this.turn.scheduled = false;
    this.turn.running++;
    await maybeCompact(this.host, config);

    return {
      // Chat completions, not Responses: see `getModel`.
      model: this.openrouter().chat(config.model),
      instructions: systemPrompt(this.host),
      tools: capabilityTools(this.host, config),
      temperature: config.temperature,
      ...(config.max_tokens > 0 ? { maxOutputTokens: config.max_tokens } : {}),
      ...(config.reasoning_effort !== "off"
        ? { providerOptions: { openai: { reasoningEffort: config.reasoning_effort } } }
        : {}),
      messages: await modelMessages(this.host, config),
    };
  }

  /** Token counts arrive per step; a turn's cost is their sum. */
  override onStepFinish(step: StepContext): void {
    const prompt = step.usage?.inputTokens ?? 0;
    const completion = step.usage?.outputTokens ?? 0;
    const cached = cachedPromptTokens(step);
    this.turnUsage.prompt += prompt;
    this.turnUsage.completion += completion;
    this.turnUsage.cached += cached;
    this.turnUsage.peak = Math.max(this.turnUsage.peak, prompt);
    this.turnUsage.cost += priceOf(this.model(), prompt, completion, openrouterCost(step));
    // Logged because a cache that silently stopped matching costs full price and otherwise
    // looks exactly like one that works.
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
    this.turn.running = Math.max(0, this.turn.running - 1);
    this.live.lastReplyId = result.message.id;
    this.exec(
      `INSERT OR REPLACE INTO usage (message_id, prompt_tokens, completion_tokens, cost_usd, ms, ts, context_tokens)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      result.message.id,
      this.turnUsage.prompt,
      this.turnUsage.completion,
      turnCost(this.turnUsage),
      this.turnUsage.started ? Date.now() - this.turnUsage.started : 0,
      Date.now(),
      this.turnUsage.peak
    );

    // Also banked in the registry, where the monthly ceiling is measured across sessions.
    const spent = turnCost(this.turnUsage);
    if (spent > 0) this.ctx.waitUntil(this.registry().addSpend(spent));

    const messages = await this.getMessages();
    const questions = messages.filter((m) => m.role === "user");
    if (questions.length === 1 && result.status === "completed") {
      await nameSession(this.host, textOf(questions[0]), textOf(result.message));
    }
  }

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
      return await streamChat(this.host, message, retry === true);
    }

    // A reloaded browser asks whether a reply is still in flight, naming the last reply it
    // holds so a turn that ended in between is replayed.
    if (request.method === "GET" && path === "live") {
      return this.live.attach(url.searchParams.get("has") ?? "");
    }

    // Attachment bytes are served raw so an <img> src can point straight at them.
    if (request.method === "GET" && path === "files" && route[1]) {
      return route[2] === "thumb"
        ? await serveThumbnail(this.host, route[1])
        : await serveAttachment(this.host, route[1]);
    }

    let body: unknown;
    let status = 200;
    let turn: Record<string, unknown> | undefined;

    try {
      if (request.method === "POST" && path === "chat") {
        const result = await runChat(
          this.host,
          ((await request.json()) as { message: string }).message
        );
        body = result.body;
        turn = result.turn;
      } else if (request.method === "POST" && path === "files") {
        const result = await upload(this.host, request);
        body = result.body;
        status = result.status;
      } else if (request.method === "GET" && path === "files") {
        body = { attachments: pendingAttachments(this.host).map(publicAttachment) };
      } else if (request.method === "DELETE" && path === "files" && route[1]) {
        await removeAttachment(this.host, route[1]);
        body = { ok: true };
      } else if (request.method === "GET" && path === "tasks") {
        body = { tasks: this.listTasks() };
      } else if (request.method === "DELETE" && path === "tasks" && route[1]) {
        body = { ok: await this.cancelTask(route[1]) };
      } else if (request.method === "GET" && path === "messages") {
        const paging = await this.settingsNow();
        const asked = Number(url.searchParams.get("limit") ?? paging.message_page);
        body = await transcriptPage(
          this.host,
          Number.isFinite(asked) ? asked : paging.message_page,
          url.searchParams.get("before") ?? ""
        );
      } else if (request.method === "GET" && path === "export") {
        body = await exportTurns(this.host, Number(url.searchParams.get("count") ?? "0"));
      } else if (request.method === "POST" && path === "import") {
        // A refused import is the fork's answer, not a crash: the route that asked
        // for it deletes the empty fork and passes this sentence back.
        try {
          await importTurns(this.host, (await request.json()) as Snapshot);
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
        body = await channelTurn(this.host, telegramInbound(message, this.config(), this.env));
      } else if (request.method === "POST" && path === "whatsapp") {
        const inbound = (await request.json()) as WhatsappInbound;
        body = await channelTurn(this.host, whatsappInbound(inbound, this.config(), this.env));
      } else if (request.method === "POST" && path === "destroy") {
        // Storage totals and the bucket sweep happen before replying, because `destroy()` aborts
        // the isolate and nothing after it is guaranteed to run.
        await this.registry().addStorageBytes(-storedBytes(this.host));
        await sweepBucket(this.host);
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

  /** The unreportable half of `!delete` (and `!clear`): the object drops its storage and ends. */
  private async finishDelete(): Promise<void> {
    releaseStorage(this.host);
    await sweepBucket(this.host);
    this.ctx.waitUntil(this.destroy());
  }

  /**
   * Free a session whose turns stopped settling (evicted isolate, unterminated stream).
   * Cancels turns and drops execution state; messages, files and memory stay.
   */
  private unstick(): { cancelled: boolean } {
    this.cancelAllChats();
    this.resetTurnState();
    // Nothing is running once those two have run, whatever the count had drifted to.
    this.turn.running = 0;
    return { cancelled: true };
  }

  private async reset(): Promise<void> {
    await this.session.clearMessages();
    // Counted before the rows go: after the delete there is nothing left to total.
    releaseStorage(this.host);
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

  /** Pending tasks in a form `scheduleTask` accepts back (`listTasks` labels cron entries). */
  private taskHandover(): TaskHandover[] {
    return [...this.getSchedules<{ prompt: string }>()]
      .filter((s) => s.callback === "runScheduledTask")
      .map((s) => ({
        when: s.type === "cron" ? s.cron : new Date(s.time * 1000).toISOString(),
        prompt: s.payload?.prompt ?? "",
      }));
  }

  /**
   * Adopt the tasks of this chat's previous session on `!new`. Public for cross-object
   * RPC; a task that cannot be re-created is counted as failed, not lost silently.
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
   * Run a scheduled prompt as a turn and deliver the reply from here. Awaited inside the
   * alarm: a submitted turn let the alarm end mid-send and the reply never arrived.
   */
  async runScheduledTask(payload: { prompt: string }) {
    this.ensureSchema();
    await this.loadConfig();
    // Over the spend ceiling the task is dropped, not queued for next month; logged, since
    // nobody watches a scheduled task.
    console.log(`scheduled task running in session ${this.name}`);
    const blocked = await spendBlocked(this.host);
    if (blocked) {
      console.warn(`scheduled task skipped in session ${this.name}: ${blocked}`);
      return;
    }
    // Snapshotted before the turn, for the same reason a webhook turn snapshots: it is
    // the only way to tell the images this task drew from the session's whole history.
    const drawnBefore = drawnIds(this.host);
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
    await deliverToChat(this.host, result.message as unknown as UIMessage, drawnBefore);
  }

  /**
   * Transcript size and LLM spend. Cloudflare's own costs are measured from outside; see
   * docs/cloudflare-durable-object-costs.md.
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
