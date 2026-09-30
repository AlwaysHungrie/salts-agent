import { Globe, Link2, Plug } from "lucide-react";
import { Markdown } from "./Markdown";
import { toolLabel, type ChatUIMessage } from "@/lib/chat";
import type { StoredMessage } from "@/lib/challenges";

type Step = { kind: "text"; text: string } | { kind: "tools"; tools: { name: string; ok: boolean }[] };

export function toUIMessages(rows: StoredMessage[]): ChatUIMessage[] {
  return rows.map((row) => {
    if (row.role === "user") {
      return { id: row.id, role: "user", parts: [{ type: "text", text: row.content }] };
    }
    let steps: Step[] = [];
    try {
      steps = JSON.parse(row.steps || "[]") as Step[];
    } catch {}
    const parts: ChatUIMessage["parts"] = steps.length
      ? steps.flatMap((s, i): ChatUIMessage["parts"] =>
          s.kind === "text"
            ? [{ type: "text" as const, text: s.text }]
            : s.tools.map((t) => ({
                type: "data-tool" as const,
                id: `tool-${i}-${t.name}`,
                data: { name: t.name, done: true, ok: t.ok },
              })),
        )
      : [{ type: "text", text: row.content }];
    return { id: row.id, role: "assistant", parts };
  });
}

function ToolIcon({ name }: { name: string }) {
  const Icon = name === "web_search" ? Globe : name === "fetch_url" ? Link2 : Plug;
  return <Icon className="size-3.5 shrink-0" strokeWidth={1.75} />;
}

/** Frontend's bubbles: ink for what you said, a hairline card for the reply. */
export function Bubble({ message, pending }: { message: ChatUIMessage; pending: boolean }) {
  if (message.role === "user") {
    const text = message.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
    return (
      <div className="flex justify-end">
        <div className="bg-ink text-on-primary max-w-full rounded-3xl px-6 py-5 text-base leading-[1.38] whitespace-pre-wrap md:max-w-2xl">
          {text}
        </div>
      </div>
    );
  }
  const hasText = message.parts.some((p) => p.type === "text" && p.text);
  return (
    <div className="flex justify-start">
      <div className="border-hairline-soft max-w-full space-y-3 rounded-3xl border px-6 py-5 text-base leading-[1.38] md:max-w-2xl">
        {message.parts.map((part, i) => {
          if (part.type === "text") return part.text ? <Markdown key={i}>{part.text}</Markdown> : null;
          if (part.type === "data-tool") {
            const { name, done, ok } = part.data;
            return (
              <div
                key={part.id ?? i}
                className={`text-faint flex items-center gap-1.5 text-xs leading-[1.33] ${done ? "" : "animate-pulse"}`}
              >
                <ToolIcon name={name} />
                {toolLabel(name, done)}
                {done && ok === false && " — failed"}
              </div>
            );
          }
          return null;
        })}
        {pending && !hasText && <Thinking />}
      </div>
    </div>
  );
}

/** Three dots, as in frontend/, while the reply has been asked for. */
export function Thinking() {
  return (
    <span className="flex h-[1.38em] items-center gap-1" aria-label="Thinking">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="bg-muted size-1.5 animate-bounce rounded-full"
          style={{ animationDelay: `${i * 140}ms`, animationDuration: "900ms" }}
        />
      ))}
    </span>
  );
}
