import { COMPACTION_PREFIX, createCompactFunction } from "agents/experimental/memory/utils";
import { generateText, type UIMessage } from "ai";
import { priceOf } from "../openrouter";
import type { Config } from "../registry";
import type { SessionHost } from "./types";

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
 * Summarise the older part of the conversation into the overlay, keeping `head`
 * messages at the start and roughly `tailTokens` (at least `minTail` messages) at the
 * end word for word.
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
