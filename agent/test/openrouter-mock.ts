/**
 * A stand-in for OpenRouter, wired in as miniflare's `outboundService`.
 *
 * Every `fetch` the Worker or any of its Durable Objects makes goes through here, so
 * the turn loop can be driven end to end — the real `SessionAgent`, the real Think
 * integration, the real AI SDK client, the real transcript and usage writes — with
 * nothing but the provider replaced. No production code knows this exists.
 *
 * Anything that is not OpenRouter is refused with a 503 rather than allowed out. A
 * test suite that can reach the network is a test suite that fails when someone else's
 * service is down, and a Telegram webhook sync firing at a real bot token during a
 * test run is worse than a failure.
 *
 * ## Driving it from a test
 *
 * The mock is a pure function of the request, so tests steer it by what they send
 * rather than by shared mutable state — which cannot work anyway, since the mock runs
 * in Node and the tests run inside workerd. A message beginning with one of these
 * triggers changes the reply:
 *
 * - `!!fail500` — the provider answers 500.
 * - `!!fail401` — the provider rejects the key.
 * - `!!toolcall` — the model calls the `list` tool, then answers using its result.
 *   The second leg is recognised by the tool message the SDK sends back, so the whole
 *   two-step exchange stays deterministic.
 * - `!!schedule` — the model schedules a task a second out, then confirms it. The task
 *   itself comes back through here as an ordinary message, prefixed `[scheduled task]`.
 * - `!!voice` — the model sends a voice note, then confirms it. The speaking call is
 *   answered here too, with a token Ogg Opus file.
 * - `!!draw` — the model draws an image, then confirms it. The drawing call is
 *   answered here too, with a one-pixel PNG.
 * - anything else — the model replies `You said: <message>`.
 *
 * A compaction's summary call is recognised by Think's summary prompt and answered
 * with `FIRST_SUMMARY`, or `UPDATED_SUMMARY` when it folds in an earlier one.
 *
 * Every successful turn reports `COST_PER_TURN` in its usage, so spend accounting is
 * exercised rather than assumed.
 */

/* ---------------------------------------------------------------- telegram -- */

/**
 * What the Telegram stand-in was asked to send, oldest first.
 *
 * Read over the wire by a test, the same way the Graph log is: `GET
 * https://telegram.test/__sent`. The host is a stand-in rather than `api.telegram.org`
 * so that the suite's seal on the real host — and the test that proves it — stays
 * exactly as it was. The Worker is pointed here by `TELEGRAM_API_BASE`, which is what
 * production uses to reach a local Bot API server.
 */
const tgSent: {
  chatId: string;
  text: string;
  replyTo?: number;
  threadId?: number;
  /** Set on a photo: the file's name. */
  photo?: string;
  /** Set on a voice note: how many bytes were uploaded. */
  voice?: number;
  caption?: string;
}[] = [];

/** The Bot API, enough of it to answer a message and to be told about a webhook. */
async function telegramMock(request: Request, url: URL): Promise<Response> {
  if (url.pathname === "/__sent") {
    const chatId = url.searchParams.get("chat");
    return json(chatId ? tgSent.filter((s) => s.chatId === chatId) : tgSent);
  }
  const method = url.pathname.split("/").at(-1) ?? "";

  // The webhook is registered whenever an agent's settings are saved. Nothing leaves
  // the process, so the seal the suite keeps on api.telegram.org is untouched.
  if (method === "setWebhook" || method === "deleteWebhook") return json({ ok: true, result: true });
  if (method === "getMe") return json({ ok: true, result: { id: 1, username: "mock_bot" } });
  if (method === "getWebhookInfo") {
    return json({ ok: true, result: { url: "https://worker.test/hook", pending_update_count: 0 } });
  }
  // The indicator, which nothing depends on.
  if (method === "sendChatAction") return json({ ok: true, result: true });

  // A file the user attached: one call to resolve it, one to fetch the bytes.
  if (method === "getFile") {
    const body = (await request.json().catch(() => ({}))) as { file_id?: string };
    // A file id a test uses to make the step before the turn fail the way the platform
    // fails it — see RESET_FILE_ID.
    if (body.file_id === RESET_FILE_ID) return json({ ok: false, description: PLATFORM_RESET }, 500);
    return json({ ok: true, result: { file_path: `files/${body.file_id ?? "unknown"}` } });
  }
  if (url.pathname.includes("/file/bot")) {
    return new Response(TELEGRAM_FILE_BODY, { headers: { "content-type": "text/plain" } });
  }

  if (method === "sendPhoto" || method === "sendVoice") {
    const form = await request.formData();
    const file = form.get(method === "sendPhoto" ? "photo" : "voice");
    tgSent.push({
      chatId: String(form.get("chat_id") ?? ""),
      text: "",
      threadId: Number(form.get("message_thread_id")) || undefined,
      caption: String(form.get("caption") ?? "") || undefined,
      ...(method === "sendPhoto"
        ? { photo: file instanceof File ? file.name : "" }
        : { voice: file instanceof File ? file.size : 0 }),
    });
    return json({ ok: true, result: { message_id: tgSent.length } });
  }

  if (method !== "sendMessage") {
    return json({ ok: false, description: `unmocked telegram method ${method}` }, 404);
  }
  const body = (await request.json().catch(() => ({}))) as {
    chat_id?: string;
    text?: string;
    message_thread_id?: number;
    reply_parameters?: { message_id?: number };
  };
  tgSent.push({
    chatId: String(body.chat_id ?? ""),
    text: body.text ?? "",
    replyTo: body.reply_parameters?.message_id,
    threadId: body.message_thread_id,
  });
  return json({ ok: true, result: { message_id: tgSent.length } });
}

/** What the Telegram stand-in serves for any file a message attached. */
export const TELEGRAM_FILE_BODY = "a document the agent was sent";

/**
 * What Cloudflare says when a Durable Object is restarted under a running request —
 * a deploy, most often. It names a SQL statement and an isolate reset, neither of
 * which is an answer to the person whose message was in flight.
 */
export const PLATFORM_RESET =
  "SQL query failed. Durable object reset because its code was updated.";

/**
 * A file id `getFile` refuses with `PLATFORM_RESET`, so a test can make the ingest
 * step — which runs inside the channel turn but outside the model loop — throw a real
 * platform error rather than a tidy one.
 */
export const RESET_FILE_ID = "file-platform-reset";

/* ------------------------------------------------------------------- graph -- */

/**
 * What the Graph stand-in has been asked to send, oldest first.
 *
 * It lives in Node, beside the mock, and the tests run inside workerd — so a test
 * cannot read this array directly. It reads it over the wire instead: a `fetch` from
 * a test goes through this same `outboundService`, so `GET
 * https://graph.facebook.com/__sent` is answered here rather than by Meta. That is
 * also why each test uses a recipient number of its own: the log is shared.
 */
const graphSent: {
  to: string;
  body: string;
  replyTo?: string;
  /** The media id a voice note named. */
  audio?: string;
  /** The media id a picture named, and what was written under it. */
  image?: string;
  caption?: string;
}[] = [];

/** What the Worker has uploaded to Graph's media store, oldest first. */
const graphUploads: { id: string; mime: string; bytes: number; name: string }[] = [];

/** Which inbound media ids the Worker has fetched the bytes of, oldest first. */
const graphDownloads: string[] = [];

/** What the Graph stand-in serves for any file a message attached. */
export const WHATSAPP_FILE_BODY = "a note the agent was sent";

/**
 * A recipient whose sends are refused with 131047, so the closed-window path can be
 * exercised without waiting a day.
 */
export const WINDOW_CLOSED_WA_ID = "10000000001";

/** Which WhatsApp Business Accounts the Worker asked to subscribe, oldest first. */
const graphSubscribed: string[] = [];

/** A WABA id Graph refuses to subscribe, so the reported failure can be tested. */
export const UNSUBSCRIBABLE_WABA_ID = "999999999999999";

/**
 * Meta's Graph API, enough of it to answer a message: send text, mark read, and tell
 * a test what it was asked to send.
 */
async function graphMock(request: Request, url: URL): Promise<Response> {
  if (url.pathname === "/__sent") {
    const to = url.searchParams.get("to");
    return json(to ? graphSent.filter((s) => s.to === to) : graphSent);
  }

  if (url.pathname === "/__subscribed") {
    return json(graphSubscribed);
  }

  if (url.pathname === "/__media") {
    return json(graphUploads);
  }

  // Inbound media: an id resolves to a URL, and the URL serves the bytes. Meta puts
  // that URL on its own CDN; here it is one more path on the stand-in, because the
  // Worker fetches whatever it is given.
  if (url.pathname.startsWith("/__inbound/")) {
    graphDownloads.push(url.pathname.slice("/__inbound/".length));
    return new Response(WHATSAPP_FILE_BODY, { headers: { "content-type": "text/plain" } });
  }
  if (url.pathname === "/__downloaded") {
    return json(graphDownloads);
  }
  if (/^\/v\d+\.\d+\/media-[\w-]+$/.test(url.pathname)) {
    const id = url.pathname.split("/").at(-1) ?? "";
    return json({ id, url: `https://graph.facebook.com/__inbound/${id}`, file_size: WHATSAPP_FILE_BODY.length });
  }

  // The media store. A voice note is uploaded here first and named by id on the send,
  // so a test can check the bytes that went out as well as the message that named them.
  if (url.pathname.endsWith("/media")) {
    const form = await request.formData();
    const file = form.get("file");
    const id = `media-mock${graphUploads.length + 1}`;
    graphUploads.push({
      id,
      mime: String(form.get("type") ?? ""),
      bytes: file instanceof File ? file.size : 0,
      name: file instanceof File ? file.name : "",
    });
    return json({ id });
  }

  // The account-level subscription, which is what makes Meta deliver anything.
  if (url.pathname.endsWith("/subscribed_apps")) {
    const waba = url.pathname.split("/").at(-2) ?? "";
    if (waba === UNSUBSCRIBABLE_WABA_ID) {
      return json(
        { error: { message: "Unsupported post request on this account", code: 100 } },
        400
      );
    }
    graphSubscribed.push(waba);
    return json({ success: true });
  }

  if (!url.pathname.endsWith("/messages")) {
    return json({ error: { message: `unmocked graph path ${url.pathname}`, code: 100 } }, 404);
  }

  const body = (await request.json().catch(() => ({}))) as {
    to?: string;
    status?: string;
    text?: { body?: string };
    audio?: { id?: string };
    image?: { id?: string; caption?: string };
    context?: { message_id?: string };
  };
  // A read receipt names no recipient and sends nothing.
  if (body.status === "read") return json({ success: true });

  if (body.to === WINDOW_CLOSED_WA_ID) {
    return json(
      {
        error: {
          message: "Message failed to send because more than 24 hours have passed",
          code: 131047,
        },
      },
      400
    );
  }

  graphSent.push({
    to: body.to ?? "",
    body: body.text?.body ?? "",
    replyTo: body.context?.message_id,
    audio: body.audio?.id,
    image: body.image?.id,
    caption: body.image?.caption,
  });
  return json({
    messaging_product: "whatsapp",
    contacts: [{ input: body.to, wa_id: body.to }],
    messages: [{ id: `wamid.mock${graphSent.length}` }],
  });
}

/** What a mocked turn reports spending, in US dollars. */
export const COST_PER_TURN = 0.0025;

/** Tokens a mocked turn reports, so usage rows have something to hold. */
export const PROMPT_TOKENS = 11;
export const COMPLETION_TOKENS = 7;

/** What the mock replies with, absent a trigger. */
export const replyTo = (message: string) => `You said: ${message}`;

/** What a first compaction summarises a conversation to. */
export const FIRST_SUMMARY = "MOCK-SUMMARY-FIRST";

/** What a compaction that folds in an earlier summary answers with. */
export const UPDATED_SUMMARY = "MOCK-SUMMARY-UPDATED";

/** What `!!schedule` asks the agent to run later. */
export const SCHEDULED_PROMPT = "the standup digest";

/** What `!!voice` asks to have spoken. */
export const SPOKEN_TEXT = "Here is the answer, out loud.";

/**
 * How many samples a mocked voice note is spoken in: a quarter-second at 24 kHz, which
 * is what the real model returns the rate of. Two chunks rather than one, because the
 * samples arrive split across deltas and the agent has to join them.
 */
const SPOKEN_SAMPLES = 6000;
const SPOKEN_CHUNKS = 2;

/**
 * The samples the speaking model returns: a quiet tone, because an Opus encoder has to
 * be handed something and silence encodes to nothing recognisable. Not words — nothing
 * in a test listens — but the right rate, the right depth, and the right container once
 * the agent has packed it.
 */
function spokenPcm(offset: number, samples: number): string {
  const pcm = new Int16Array(samples);
  for (let i = 0; i < samples; i++) {
    pcm[i] = Math.round(8000 * Math.sin((2 * Math.PI * 220 * (offset + i)) / 24000));
  }
  const bytes = new Uint8Array(pcm.buffer);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

type ChatBody = {
  model?: string;
  stream?: boolean;
  modalities?: string[];
  audio?: { voice?: string; format?: string };
  messages?: { role: string; content?: unknown }[];
};

/**
 * Every chat request the Worker has made, oldest first — read by a test the same way
 * the Telegram and Graph logs are, over the wire at `GET
 * https://openrouter.ai/__requests`. It is what lets a test assert on the body the AI
 * SDK actually produced rather than on a body assembled beside it: whether the system
 * prompt carries a cache breakpoint is a fact about the real request or it is nothing.
 *
 * The log is shared by the whole file, so a test finds its own request by a token it
 * put in the message it sent: `?contains=<token>`.
 */
const chatRequests: ChatBody[] = [];

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

/** The last thing the user actually typed, which is where the triggers live. */
function lastUserMessage(body: ChatBody): string {
  const messages = body.messages ?? [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "user") continue;
    const content = message.content;
    if (typeof content === "string") return content;
    // The SDK sends an array of parts once a turn carries files.
    if (Array.isArray(content)) {
      const text = content.find(
        (part): part is { type: string; text: string } =>
          typeof part === "object" && part !== null && (part as { type?: string }).type === "text"
      );
      if (text) return text.text;
    }
  }
  return "";
}

/** Whether this request is the second leg of a tool call — the SDK sending the result back. */
const carriesToolResult = (body: ChatBody) =>
  (body.messages ?? []).some((m) => m.role === "tool");

const usage = () => ({
  prompt_tokens: PROMPT_TOKENS,
  completion_tokens: COMPLETION_TOKENS,
  total_tokens: PROMPT_TOKENS + COMPLETION_TOKENS,
  cost: COST_PER_TURN,
});

/** A non-streamed completion, which is what the title call asks for. */
function completion(content: string) {
  return json({
    id: "chatcmpl-mock",
    object: "chat.completion",
    created: 1,
    model: "mock/model",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: usage(),
  });
}

/** A one-pixel PNG, as a data URL: what the drawing model answers with. */
const PIXEL_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** A completion carrying a drawn image, which is how an image model answers. */
function drawn() {
  return json({
    id: "chatcmpl-mock",
    object: "chat.completion",
    created: 1,
    model: "mock/image",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "", images: [{ image_url: { url: PIXEL_PNG } }] },
        finish_reason: "stop",
      },
    ],
    usage: usage(),
  });
}

/**
 * How a voice model answers: a stream of sample chunks.
 *
 * The two refusals above it are the real ones, quoted from OpenRouter, and they are
 * mocked because the agent was once written against neither. Audio output is served
 * only on a stream, and a stream carries no container — `pcm16` is the only format its
 * providers accept, so anything that plays as a voice note is packed by the Worker.
 */
function spoken(body: ChatBody) {
  if (!body.stream) {
    return json({ error: { message: "Audio output requires stream: true", code: 400 } }, 400);
  }
  if (body.audio?.format !== "pcm16") {
    return json(
      {
        error: {
          message: `Provider returned error`,
          code: 400,
          metadata: {
            raw: `Unsupported value: 'audio.format' does not support '${body.audio?.format}' when stream=true. Supported values are: 'pcm16'.`,
          },
        },
      },
      400
    );
  }
  const per = SPOKEN_SAMPLES / SPOKEN_CHUNKS;
  const chunks = Array.from({ length: SPOKEN_CHUNKS }, (_, i) => ({
    id: "chatcmpl-mock",
    object: "chat.completion.chunk",
    created: 1,
    model: "mock/voice",
    choices: [
      { index: 0, delta: { role: "assistant", audio: { data: spokenPcm(i * per, per) } }, finish_reason: null },
    ],
  }));
  return stream([
    ...chunks,
    {
      id: "chatcmpl-mock",
      object: "chat.completion.chunk",
      created: 1,
      model: "mock/voice",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: usage(),
    },
  ]);
}

/**
 * An SSE stream in the shape the AI SDK reads: deltas, then a final chunk carrying
 * `finish_reason` and the usage the turn is billed on.
 */
function stream(chunks: Record<string, unknown>[]) {
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
}

const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({
  id: "chatcmpl-mock",
  object: "chat.completion.chunk",
  created: 1,
  model: "mock/model",
  choices: [{ index: 0, delta, finish_reason: finish }],
});

const finalChunk = () => ({
  id: "chatcmpl-mock",
  object: "chat.completion.chunk",
  created: 1,
  model: "mock/model",
  choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  usage: usage(),
});

/** How long a `!!slow` reply keeps the turn waiting before a word of it arrives. */
export const SLOW_REPLY_MS = 700;

/** The text reply, streamed one word at a time so the SSE path is genuinely exercised. */
function streamedText(text: string) {
  const words = text.split(" ");
  return stream([
    chunk({ role: "assistant", content: "" }),
    ...words.map((word, i) => chunk({ content: i === 0 ? word : ` ${word}` })),
    finalChunk(),
  ]);
}

/** A streamed tool call, which is how a turn that uses a tool begins. */
function streamedToolCall(name: string, args: Record<string, unknown>) {
  return stream([
    chunk({ role: "assistant", content: "" }),
    chunk({
      tool_calls: [
        {
          index: 0,
          id: "call_mock_1",
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    }),
    {
      id: "chatcmpl-mock",
      object: "chat.completion.chunk",
      created: 1,
      model: "mock/model",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      usage: usage(),
    },
  ]);
}

/* ------------------------------------------------------------- mcp server -- */

/**
 * The tools the MCP stand-in advertises.
 *
 * Shaped like a real server's list and not like a convenient one: a handful that do
 * the work, and two whose names say `admin`, which is what the recommendation is meant
 * to leave behind. Exported so a test asserts against the same names the Worker saw.
 */
export const MCP_TOOLS = [
  { name: "search_pages", description: "Search every page in the workspace by text." },
  { name: "read_page", description: "Read one page's blocks and properties." },
  { name: "create_page", description: "Create a page in a database." },
  { name: "update_page", description: "Change a page's properties." },
  { name: "admin_list_users", description: "List every user in the workspace." },
  { name: "admin_audit_log", description: "Read the workspace audit log." },
].map((tool) => ({ ...tool, inputSchema: { type: "object", properties: {} } }));

/** The names the recommendation is expected to keep, once `admin_*` is dropped. */
export const MCP_KEPT = MCP_TOOLS.filter((t) => !t.name.includes("admin")).map((t) => t.name);

/**
 * An MCP server, enough of one to be connected to and asked what it can do.
 *
 * Plain JSON-RPC over one POST, which is the half of Streamable HTTP this Worker uses.
 * A server at `/empty` lists nothing, which is how a test reaches the route's "refresh
 * it first" answer without deleting a row's tools behind its back.
 */
async function mcpMock(request: Request, url: URL): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { id?: number; method?: string };
  const reply = (result: unknown) =>
    json({ jsonrpc: "2.0", id: body.id ?? 1, result }, 200);

  if (body.method === "initialize") {
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: body.id ?? 1,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "mock-mcp", version: "1.0" },
        },
      }),
      { headers: { "content-type": "application/json", "mcp-session-id": "mock-session" } }
    );
  }
  if (body.method === "tools/list") {
    return reply({ tools: url.pathname === "/empty" ? [] : MCP_TOOLS });
  }
  if (body.method === "tools/call") return reply({ content: [{ type: "text", text: "done" }] });
  // A notification, which carries no id and expects no envelope.
  return json({ jsonrpc: "2.0", result: {} });
}

/* ------------------------------------------------------------ openrouter -- */

/** A tool name the server never advertised, which the Worker is expected to drop. */
export const INVENTED_TOOL = "mock_tool_that_does_not_exist";

/**
 * Whether this is the "which of these tools should the agent keep" call rather than a
 * turn. Recognised by its own system prompt, so a test never has to know the route.
 */
function isToolChoice(body: ChatBody): boolean {
  return (body.messages ?? []).some(
    (m) =>
      m.role === "system" &&
      typeof m.content === "string" &&
      m.content.includes("which of an MCP server's tools")
  );
}

/**
 * The choice, made from the catalog the Worker sent rather than from a fixed list — so
 * a test asserts on real filtering of its own server's tools.
 *
 * Keeps everything whose name does not say `admin`, and adds one tool the server never
 * offered: the Worker is supposed to drop a name it cannot match, and a mock that only
 * ever answers truthfully never proves that. A server named `nonsense` gets prose
 * instead of JSON, which is the unparseable case.
 */
function chosenTools(catalog: string): Response {
  if (/The server "[^"]*nonsense/.test(catalog)) {
    return completion("I would keep the useful ones, I think.");
  }
  const names = [...catalog.matchAll(/^- ([^:\n]+):/gm)].map((m) => m[1]);
  const keep = names.filter((name) => !name.includes("admin"));
  return completion(JSON.stringify({ keep: [...keep, INVENTED_TOOL] }));
}

/**
 * Handle one outbound request. Returns a 503 for any host that is not OpenRouter, so
 * a test that reaches for the network fails loudly instead of going out to it.
 */
export async function openrouterMock(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.hostname === "graph.facebook.com") return graphMock(request, url);
  if (url.hostname === "telegram.test") return telegramMock(request, url);
  if (url.hostname === "mcp.test") return mcpMock(request, url);
  if (url.hostname !== "openrouter.ai") {
    return new Response(`blocked outbound request to ${url.hostname}`, { status: 503 });
  }

  // The key check the create-agent route makes before an agent is written.
  if (url.pathname === "/api/v1/key") {
    const auth = request.headers.get("authorization") ?? "";
    if (auth.includes("sk-invalid")) return json({ error: "invalid" }, 401);
    return json({ data: { label: "mock key" } });
  }

  if (url.pathname === "/__requests") {
    const contains = url.searchParams.get("contains");
    return json(
      contains
        ? chatRequests.filter((b) => JSON.stringify(b).includes(contains))
        : chatRequests
    );
  }

  if (url.pathname !== "/api/v1/chat/completions") {
    return json({ error: `unmocked OpenRouter path ${url.pathname}` }, 404);
  }

  const body = (await request.json().catch(() => ({}))) as ChatBody;
  chatRequests.push(body);
  const message = lastUserMessage(body);

  if (message.startsWith("!!fail500")) {
    return json({ error: { message: "Provider returned error" } }, 500);
  }
  if (message.startsWith("!!fail401")) {
    return json({ error: { message: "No auth credentials found" } }, 401);
  }

  // The speaking call. Answered before the title call below, which would otherwise
  // hand a voice note the words "Mock Title".
  if (body.modalities?.includes("audio")) return spoken(body);
  if (body.modalities?.includes("image")) return drawn();

  // Choosing which of a server's tools to keep. Not streamed either, so it has to be
  // answered before the title call below, which would hand it the words "Mock Title".
  if (isToolChoice(body)) return chosenTools(message);

  // A compaction: Think's summary prompt, not streamed. Answered before the title
  // call, which would hand the summary the words "Mock Title".
  if (!body.stream && message.includes("NEW TURNS TO INCORPORATE")) return completion(UPDATED_SUMMARY);
  if (!body.stream && message.includes("CONVERSATION TO SUMMARIZE")) return completion(FIRST_SUMMARY);

  // The title call: no streaming, and a system prompt asking for a name.
  if (!body.stream) return completion("Mock Title");

  if (message.startsWith("!!schedule")) {
    if (carriesToolResult(body)) return streamedText("Scheduled it.");
    // A second out, so the alarm lands inside a test's patience.
    return streamedToolCall("schedule_task", { when: "1", prompt: SCHEDULED_PROMPT });
  }

  if (message.startsWith("!!voice")) {
    if (carriesToolResult(body)) return streamedText("Sent it.");
    return streamedToolCall("send_voice_note", { text: SPOKEN_TEXT });
  }

  if (message.startsWith("!!draw")) {
    if (carriesToolResult(body)) return streamedText("Drew it.");
    return streamedToolCall("generate_image", { prompt: "a mock drawing" });
  }

  if (message.startsWith("!!toolcall")) {
    // Second leg: the SDK has sent the tool's result back, so answer for real.
    if (carriesToolResult(body)) return streamedText("I listed the workspace.");
    return streamedToolCall("list", { path: "/" });
  }

  // A reply that takes its time. Every other trigger answers in one go, which leaves
  // no moment in which a turn is still running — and a command that interrupts one
  // has nothing to interrupt.
  if (message.startsWith("!!slow")) {
    await scheduler.wait(SLOW_REPLY_MS);
    return streamedText(replyTo(message));
  }

  return streamedText(replyTo(message));
}
