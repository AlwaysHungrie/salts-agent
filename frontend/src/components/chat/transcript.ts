import type { ChatUIMessage } from "@/app/api/sessions/[id]/chat/route";
import type { StoredMessage, TurnStep } from "@/lib/agent";

/**
 * An assistant turn's stored steps as message parts. Turns saved before steps existed
 * — and any turn that ran no tools — fall back to the plain text of the row.
 */
export function storedParts(row: StoredMessage): ChatUIMessage["parts"] {
  let steps: TurnStep[] = [];
  try {
    steps = JSON.parse(row.steps || "[]") as TurnStep[];
  } catch {
    steps = [];
  }
  if (steps.length === 0) return [{ type: "text", text: row.content }];
  const parts: ChatUIMessage["parts"] = [];
  steps.forEach((step, i) => {
    if (step.kind === "text") {
      parts.push({ type: "text", text: step.text });
      return;
    }
    for (const tool of step.tools) {
      parts.push({
        type: "data-tool",
        id: `stored-${row.id}-${i}-${tool.name}`,
        data: { name: tool.name, done: true, ok: tool.ok },
      });
    }
  });
  return parts;
}

/** Turn the rows persisted in the Durable Object back into AI SDK messages. */
export function toUIMessages(rows: StoredMessage[]): ChatUIMessage[] {
  return rows.map((row) => ({
    id: String(row.id),
    role: row.role,
    parts:
      row.role === "assistant"
        ? [
            { type: "data-meta" as const, data: { ts: row.ts } },
            ...storedParts(row),
            {
              type: "data-usage" as const,
              data: {
                prompt_tokens: row.prompt_tokens,
                completion_tokens: row.completion_tokens,
                cost_usd: row.cost_usd,
                llm_ms: row.ms,
              },
            },
          ]
        : [
            { type: "data-meta" as const, data: { ts: row.ts } },
            ...(row.attachments?.length
              ? [
                  {
                    type: "data-files" as const,
                    data: { attachments: row.attachments },
                  },
                ]
              : []),
            { type: "text" as const, text: row.content },
          ],
  }));
}

/**
 * Where a fork at drawn message `i` cuts, and the draft it returns: the preceding
 * question is dropped from the copy and handed back for rewording.
 */
export function forkAt(
  messages: ChatUIMessage[],
  i: number,
  offset: number,
): [count: number, draft: string] {
  const prev = messages[i - 1];
  // The agent counts from the start of the whole transcript, so add the unloaded `offset`.
  if (!prev || prev.role !== "user") return [offset + i, ""];
  const draft = prev.parts
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("");
  return [offset + i - 1, draft];
}
