import { COMPACTION_PREFIX, createCompactFunction } from "agents/experimental/memory/utils";
import { generateText, type UIMessage } from "ai";
import { priceOf } from "../openrouter";
import type { Config } from "../registry";
import type { SessionHost } from "./types";

/**
 * The transcript as the model reads it, with the compacted run replaced by one summary.
 * An overlay: Think's history is untouched. Skipped if a rewind removed either end.
 */
export async function compactedMessages(host: SessionHost): Promise<UIMessage[]> {
  const all = (await host.getMessages()).filter((m) => m.role === "user" || m.role === "assistant");
  const row = host.exec<{ from_id: string; to_id: string; summary: string }>(
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
 * Summarise older messages into the overlay, keeping `head` messages and about
 * `tailTokens` (at least `minTail`) verbatim, via Think's reference algorithm and the
 * agent's own model and client. Returns messages covered and cost, or null.
 */
export async function compact(
  host: SessionHost,
  keep: {
    head: number;
    tailTokens: number;
    minTail: number;
  }
): Promise<{ covered: number; cost: number } | null> {
  host.ensureSchema();
  const history = await compactedMessages(host);
  const previous = host.exec<{ from_id: string }>(`SELECT from_id FROM compaction WHERE id = 1`)[0];
  const overlaid = history.some((m) => m.id.startsWith(COMPACTION_PREFIX));
  let cost = 0;
  const summarise = createCompactFunction({
    protectHead: keep.head,
    tailTokenBudget: keep.tailTokens,
    minTailMessages: keep.minTail,
    summarize: async (prompt) => {
      const result = await generateText({
        model: host.openrouter().chat(host.config().model),
        prompt,
      });
      const reported = result.usage.raw?.cost;
      cost = priceOf(
        host.model(),
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
  host.exec(
    `INSERT OR REPLACE INTO compaction (id, from_id, to_id, summary, ts) VALUES (1, ?, ?, ?, ?)`,
    from,
    result.toMessageId,
    result.summary,
    Date.now()
  );
  const all = (await host.getMessages()).filter((m) => m.role === "user" || m.role === "assistant");
  const covered =
    all.findIndex((m) => m.id === result.toMessageId) - all.findIndex((m) => m.id === from) + 1;
  return { covered, cost };
}

/**
 * Compact before a turn when the previous turn's largest reported prompt exceeded the
 * threshold (once per compaction). A failed summary is logged and never costs the turn.
 */
export async function maybeCompact(host: SessionHost, config: Config): Promise<void> {
  const threshold = host.settings().compact_after_tokens;
  if (threshold <= 0) return;
  host.ensureSchema();
  const last = host.exec<{ context_tokens: number; ts: number }>(
    // Questions have usage rows too, holding nothing; only a reply measured a prompt.
    `SELECT context_tokens, ts FROM usage WHERE context_tokens > 0 ORDER BY ts DESC LIMIT 1`
  )[0];
  if (!last || last.context_tokens <= threshold) return;
  const since = host.exec<{ ts: number }>(`SELECT ts FROM compaction WHERE id = 1`)[0];
  if (since && last.ts <= since.ts) return;
  try {
    // A fifth of the budget kept verbatim: recent enough to carry on from, small
    // enough that the next turn lands well under the line.
    const done = await compact(host, {
      head: 3,
      tailTokens: Math.floor(threshold / 5),
      minTail: 2,
    });
    if (!done) return;
    host.usage().cost += done.cost;
    host.usage().reported += done.cost;
    console.log(
      `session ${host.name()}: compacted ${done.covered} messages at ${last.context_tokens} prompt tokens (${config.model})`
    );
  } catch (err) {
    console.error(
      `compaction failed in session ${host.name()}: ${err instanceof Error ? err.message : err}`
    );
  }
}
