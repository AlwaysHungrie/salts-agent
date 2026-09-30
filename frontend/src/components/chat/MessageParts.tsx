import type { ToolData } from "@/app/api/sessions/[id]/chat/route";
import type { Attachment, UsageData } from "@/lib/agent";
import { formatMs, formatUsd } from "@/lib/format";
import { AlertCircle, Check, Copy, GitBranch, RotateCcw } from "lucide-react";
import { useState } from "react";
import { DownloadLink } from "./attachments";
import { timeOfDay } from "./format";

/** How a tool call reads while it runs, once it is done, and when it fails. */
export const TOOL_LABELS: Record<
  string,
  [running: string, done: string, failed: string]
> = {
  web_search: ["Searching web", "Searched", "Web search failed"],
  fetch_url: ["Reading page", "Read page", "Page fetch failed"],
  generate_image: ["Generating", "Generated", "Image generation failed"],
  schedule_task: ["Scheduling", "Scheduled", "Scheduling failed"],
  list_scheduled_tasks: [
    "Checking schedule",
    "Checked",
    "Schedule check failed",
  ],
  cancel_scheduled_task: ["Cancelling", "Cancelled", "Cancelling failed"],
  remember: ["Looking up", "Looked up", "Could not remember"],
  recall: ["Recalling", "Recalled", "Recall failed"],
};

export function toolLabel(tool: ToolData) {
  const trio = TOOL_LABELS[tool.name] ?? [
    `Running ${tool.name}…`,
    `Ran ${tool.name}`,
    `${tool.name} failed`,
  ];
  if (!tool.done) return trio[0];
  return tool.ok === false ? trio[2] : trio[1];
}

/**
 * A failed tool has to read as failed rather than pass for a step that quietly went
 * by. The label says so; darkening it from faint to muted is the whole emphasis.
 */
export function ToolLine({ tool }: { tool: ToolData }) {
  return <div>{toolLabel(tool)}</div>;
}

export function UsageLine({ usage }: { usage: UsageData }) {
  // A command's answer or a spend-limit notice runs no turn and reports all zeros;
  // a row of zeros there reads as "this was free", which it may not have been.
  if (!usage.prompt_tokens && !usage.completion_tokens && !usage.cost_usd && !usage.llm_ms) {
    return null;
  }
  return (
    <div className="border-hairline-soft text-faint tnum mt-3 flex flex-wrap gap-x-4 gap-y-1 border-t pt-3 text-xs leading-[1.33]">
      <span>
        {usage.prompt_tokens} + {usage.completion_tokens} tkns
      </span>
      <span className="text-ink font-semibold">
        {formatUsd(usage.cost_usd)}
      </span>
      <span>{formatMs(usage.llm_ms)}</span>
    </div>
  );
}

/**
 * Anything that is neither the user nor the agent talking: a dropped stream, a failed
 * turn. Centred and quiet, so it never reads as a message someone sent.
 */
export function SystemNotice({ text }: { text: string }) {
  return (
    <div className="flex justify-center">
      <div className="border-hairline-soft text-muted flex max-w-md items-center gap-2.5 rounded-full border px-4 py-2 text-[13px] leading-[1.35]">
        <AlertCircle size={14} strokeWidth={1.75} className="shrink-0" />
        <span className="min-w-0">{text}</span>
      </div>
    </div>
  );
}

/** Three dots, while the agent has been asked something but has not started writing. */
export function Thinking() {
  return (
    <span className="flex h-[1.38em] items-center gap-1">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="bg-muted h-1.5 w-1.5 animate-bounce rounded-full"
          style={{ animationDelay: `${i * 140}ms`, animationDuration: "900ms" }}
        />
      ))}
    </span>
  );
}

/**
 * What sits under a message: when it was sent, and what can be done with it. Kept
 * outside the bubble so the bubble stays the message and nothing else.
 */
export function MessageActions({
  text,
  at,
  isUser,
  sessionId,
  downloads,
  onFork,
  onRetry,
}: {
  text: string;
  at: number | null;
  isUser: boolean;
  sessionId: string;
  /** Everything sent with this message that has a file behind it. */
  downloads: Attachment[];
  onFork?: () => void;
  onRetry?: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // Clipboard access denied: nothing useful to say, and nothing to undo.
    }
  };

  const action =
    "text-faint hover:text-ink flex items-center gap-1 rounded-full px-1.5 py-0.5";

  return (
    <div
      className={`text-faint flex items-center gap-1 px-1 text-xs leading-[1.33] ${
        isUser ? "justify-end" : "justify-start"
      }`}
    >
      {onRetry && (
        <button onClick={onRetry} className={action} title="Ask again">
          <RotateCcw size={13} strokeWidth={1.75} />
        </button>
      )}
      {at !== null && <span className="tnum pr-1.5">{timeOfDay(at)}</span>}
      {text.trim() !== "" && (
        <button
          onClick={() => void copy()}
          className={action}
          title="Copy message"
        >
          {copied ? (
            <Check size={13} strokeWidth={2} />
          ) : (
            <Copy size={13} strokeWidth={1.75} />
          )}
        </button>
      )}
      {downloads.map((a) => (
        <DownloadLink
          key={a.id}
          sessionId={sessionId}
          attachment={a}
          className="text-faint hover:text-ink"
        />
      ))}
      {onFork && (
        <button
          onClick={onFork}
          className={action}
          title="Start a new session from the conversation up to this reply"
        >
          <GitBranch size={13} strokeWidth={1.75} />
          <span>Fork</span>
        </button>
      )}
    </div>
  );
}
