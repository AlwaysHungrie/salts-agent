import type { ChatUIMessage, FilesData, ToolData } from "@/app/api/sessions/[id]/chat/route";
import type { UsageData } from "@/lib/agent";
import { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { MessageActions, Thinking, ToolLine, UsageLine } from "./MessageParts";
import { MessageDocs, MessageMedia } from "./attachments";
import { MARKDOWN_COMPONENTS } from "./markdown";

export type ToolPart = { type: "data-tool"; id?: string; data: ToolData };
export type Step =
  | { kind: "text"; text: string }
  | { kind: "tools"; tools: ToolPart[] };

/** Fold a message's parts into the ordered steps of the turn. */
export function buildSteps(parts: ChatUIMessage["parts"]): Step[] {
  const steps: Step[] = [];
  for (const part of parts) {
    if (part.type === "text") {
      if (!part.text) continue;
      const last = steps[steps.length - 1];
      if (last?.kind === "text") last.text += part.text;
      else steps.push({ kind: "text", text: part.text });
    } else if (part.type === "data-tool") {
      const tool = part as ToolPart;
      const last = steps[steps.length - 1];
      if (last?.kind === "tools") {
        // A tool reports twice — running, then done. The second write replaces the
        // first so the line changes in place rather than stacking.
        const at = last.tools.findIndex((t) => t.id && t.id === tool.id);
        if (at === -1) last.tools.push(tool);
        else last.tools[at] = tool;
      } else {
        steps.push({ kind: "tools", tools: [tool] });
      }
    }
  }
  return steps;
}

/**
 * A message that came in as a reply carries the quoted message ahead of it, as
 * blockquote lines. Split the two apart so the quote can be shown as a quote rather
 * than as a stray "> " in the middle of a sentence.
 */
export function splitQuote(text: string): { quote: string; body: string } {
  if (!text.startsWith(">")) return { quote: "", body: text };
  const lines = text.split("\n");
  let end = 0;
  while (end < lines.length && lines[end].startsWith(">")) end++;
  const quote = lines
    .slice(0, end)
    .map((line) => line.replace(/^>\s?/, ""))
    .join("\n")
    .trim();
  return { quote, body: lines.slice(end).join("\n").trim() };
}

/**
 * One message: its files above, the bubble itself, and its actions below. Voice notes
 * and documents sit outside the bubble — a clip with nothing said alongside it should
 * not be dressed up as a sentence — while images stay inside it, inset from the edge.
 */
export function Bubble({
  message,
  sessionId,
  at,
  pending = false,
  onFork,
  onRetry,
}: {
  message: ChatUIMessage;
  sessionId: string;
  at: number | null;
  /** The turn is in flight: the bubble stands even before the first token lands. */
  pending?: boolean;
  onFork?: () => void;
  onRetry?: () => void;
}) {
  const isUser = message.role === "user";
  const raw = message.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("");
  // Only a question can quote something; an assistant's own "> " is Markdown it wrote.
  const { quote, body: text } = isUser
    ? splitQuote(raw)
    : { quote: "", body: raw };
  const usage = message.parts.find((p) => p.type === "data-usage") as
    | { type: "data-usage"; data: UsageData }
    | undefined;
  const tools = message.parts.filter(
    (p): p is { type: "data-tool"; id?: string; data: ToolData } =>
      p.type === "data-tool",
  );
  // The turn as it happened: text the model wrote, the tools it then ran, the text it
  // wrote after them. Consecutive tool calls collapse into one block; everything else
  // stays in the order the stream produced it.
  const steps = useMemo(() => buildSteps(message.parts), [message.parts]);
  const files = message.parts.find((p) => p.type === "data-files") as
    | { type: "data-files"; data: FilesData }
    | undefined;

  const attachments = files?.data.attachments ?? [];
  const images = attachments.filter((a) => a.kind === "image");
  const docs = attachments.filter((a) => a.kind !== "image");
  // The bubble is for what was said. Files carry themselves.
  const hasBubble =
    text.length > 0 ||
    quote.length > 0 ||
    tools.length > 0 ||
    images.length > 0 ||
    (!isUser && (usage !== undefined || pending));

  return (
    <div
      className={`flex flex-col gap-1.5 ${isUser ? "items-end" : "items-start"}`}
    >
      {docs.length > 0 && (
        <div className="max-w-full md:max-w-2xl">
          <MessageDocs docs={docs} isUser={false} sessionId={sessionId} />
        </div>
      )}

      {hasBubble && (
        <div
          className={`max-w-full overflow-hidden rounded-3xl text-base leading-[1.38] md:max-w-2xl ${
            isUser
              ? "bg-ink text-on-primary"
              : "bg-canvas border-hairline-soft text-ink border"
          }`}
        >
          {images.length > 0 && (
            <div className={text.length > 0 ? "p-6 pb-0" : "p-2"}>
              <MessageMedia images={images} sessionId={sessionId} />
            </div>
          )}

          {(text.length > 0 ||
            quote.length > 0 ||
            tools.length > 0 ||
            (!isUser && (usage || pending))) && (
            <div className="px-6 py-5">
              {isUser ? (
                <>
                  {quote.length > 0 && (
                    <div
                      className={`mb-3 border-l-2 border-current/30 pl-3 text-sm leading-[1.35] whitespace-pre-wrap opacity-70 ${
                        text.length === 0 ? "mb-0" : ""
                      }`}
                    >
                      {quote}
                    </div>
                  )}
                  {text.length > 0 && (
                    <div className="whitespace-pre-wrap">{text}</div>
                  )}
                </>
              ) : steps.length > 0 ? (
                <div className="space-y-4">
                  {steps.map((step, i) =>
                    step.kind === "tools" ? (
                      <div
                        key={`tools-${i}`}
                        className="text-faint space-y-1 text-xs leading-[1.33]"
                      >
                        {step.tools.map((t, j) => (
                          <ToolLine key={t.id ?? j} tool={t.data} />
                        ))}
                      </div>
                    ) : (
                      <div key={`text-${i}`}>
                        <ReactMarkdown
                          remarkPlugins={[remarkGfm]}
                          components={MARKDOWN_COMPONENTS(sessionId)}
                        >
                          {step.text}
                        </ReactMarkdown>
                      </div>
                    ),
                  )}
                </div>
              ) : (
                <Thinking />
              )}

              {!isUser && usage && <UsageLine usage={usage.data} />}
            </div>
          )}
        </div>
      )}

      <MessageActions
        text={text}
        at={at}
        isUser={isUser}
        sessionId={sessionId}
        downloads={attachments}
        onFork={onFork}
        onRetry={onRetry}
      />
    </div>
  );
}
