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
 * What a scheduled task's user message is prefixed with. It is the only durable trace
 * of why a turn ran: an alarm submits the turn and returns, so the reply is written by
 * a later invocation that has nothing in memory to tell it who asked.
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
    const key = this.openrouterKey();
    // Said here rather than left to OpenRouter, which answers a blank key with a bare
    // 401 that reaches the chat as "Provider returned error" and names nothing the
    // person reading it could act on.
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
    return systemPrompt(this.host);
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

    // What the turn cost goes to the agent's registry as well as to this session's
    // own usage table. The registry is where the monthly ceiling is measured, and
    // it cannot be measured from here: the next turn may well be in a different
    // session object, which knows nothing about this one's spending.
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

    // A browser that reloaded mid-reply asks here whether one is still in flight,
    // naming the last reply its transcript holds so a turn that ended in between is
    // sent rather than lost.
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
        // The bucket is swept before the reply, because `destroy()` aborts the
        // isolate: work left running behind it may never finish. Dropping the
        // object's own storage is what waits, and the runtime completes that.
        //
        // The agent's byte total is given back first, for the same reason: after
        // `destroy()` there is nobody left to report it.
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

  /**
   * The half of `!delete` — and of `!clear`, once the chat has moved on — that cannot
   * be reported: the object drops its own storage, which ends the isolate running this
   * code.
   */
  private async finishDelete(): Promise<void> {
    releaseStorage(this.host);
    await sweepBucket(this.host);
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
