import type { StepContext } from "@cloudflare/think";

/** Fallback per-token pricing, used when OpenRouter does not return a cost. */
export const MODEL_FALLBACK_PRICE: Record<string, { prompt: number; completion: number }> = {
  "deepseek/deepseek-v4-flash": { prompt: 0.000000088606, completion: 0.000000177212 },
};

/** One parsed document as OpenRouter hands it back on the assistant delta. */
export type FileAnnotation = {
  type: string;
  file?: { name?: string; hash?: string; content?: unknown };
};

/** The text of a parse; the per-page rendered images are dropped. */
export function annotationText(annotation: FileAnnotation): string {
  const content = annotation.file?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (
    content
      .filter(
        (part): part is { type: "text"; text: string } =>
          typeof (part as { text?: unknown })?.text === "string" &&
          (part as { type?: string }).type === "text"
      )
      .map((part) => part.text)
      // A parse arrives one page per entry; the blank line keeps them from running on.
      .join("\n\n")
      .trim()
  );
}

export type ContentPart = { type?: string; text?: string; cache_control?: { type: string } };

export type ChatRequestBody = {
  model?: string;
  usage?: { include?: boolean };
  provider?: { data_collection?: "allow" | "deny" };
  messages?: { role?: string; content?: string | ContentPart[] }[];
};

/** Anthropic's five-minute cache, the only kind a breakpoint here asks for. */
export const CACHE_CONTROL = { type: "ephemeral" } as const;

/**
 * Add what the AI SDK does not send: `usage.include` for the real cost, the Anthropic
 * cache breakpoint, and (for WhatsApp) the no-training provider rule.
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
 * Put an Anthropic cache breakpoint on the last system message (others cache on their
 * own). Tools render before system, so this caches the MCP schemas too, and new messages
 * do not move it — unlike OpenRouter's top-level `cache_control`.
 */
export function markCacheablePrefix(body: ChatRequestBody): boolean {
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

/**
 * Drop annotation kinds the AI SDK cannot parse (it only knows `url_citation`), which
 * would otherwise fail validation and kill a paid-for stream. File parses and the
 * reported cost are handed to the callbacks on the way past.
 */

export function stripUnsupportedAnnotations(
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

/** Cached prompt tokens as OpenRouter reports them; 0 when unreported (same as a miss). */
export function cachedPromptTokens(step: StepContext): number {
  const raw = (step.usage as { raw?: Record<string, unknown> } | undefined)?.raw;
  const details = raw?.prompt_tokens_details as { cached_tokens?: unknown } | undefined;
  return typeof details?.cached_tokens === "number" ? details.cached_tokens : 0;
}

export function openrouterCost(step: StepContext): number | undefined {
  const raw = (step.usage as { raw?: Record<string, unknown> } | undefined)?.raw;
  const cost = raw?.cost;
  return typeof cost === "number" ? cost : undefined;
}

/** What a call cost: OpenRouter's reported figure, else the fallback price table's estimate. */
export function priceOf(
  model: string,
  promptTokens: number,
  completionTokens: number,
  reported?: number
): number {
  if (typeof reported === "number") return reported;
  const p = MODEL_FALLBACK_PRICE[model];
  return p ? promptTokens * p.prompt + completionTokens * p.completion : 0;
}

/**
 * What the turn cost. OpenRouter's own figure includes what the token estimate cannot
 * see (a plugin's file-parsing fee), so the estimate is only a fallback.
 */
export function turnCost(usage: { reported: number; cost: number }): number {
  return usage.reported > 0 ? usage.reported : usage.cost;
}
