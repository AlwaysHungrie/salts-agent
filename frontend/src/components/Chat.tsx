"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  Check,
  Copy,
  Download,
  FileText,
  FileType2,
  GitBranch,
  Mic,
  Paperclip,
  Pause,
  Play,
  RotateCcw,
  Send,
  Square,
  X,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type {
  ChatUIMessage,
  FilesData,
  MetaData,
  ToolData,
} from "@/app/api/sessions/[id]/chat/route";
import {
  agentIdOf,
  capabilityReady,
  describeSessionFailure,
  type Attachment,
  type Capability,
  type Config,
  type StoredMessage,
  type TranscriptPage,
  type TurnStep,
  type UsageData,
  imageTarget,
  recordingSeconds,
  type ClientLimits,
} from "@/lib/agent";
import { formatMs, formatUsd } from "@/lib/format";
import { fitImage } from "@/lib/image";
import { pdfThumbnail } from "@/lib/pdf";
import { startRecording, type Recorder } from "@/lib/recorder";
import { apiFetch, identityHeaders, useAuthedUrl } from "@/lib/identity";

// The three ceilings the composer enforces — files per message, the size an image is
// re-encoded to, and how long a take may run — come from the deployment's settings over
// `/config`. Nothing stands in until it answers: uploads and recording wait for it. See
// `ClientLimits` in `lib/agent.ts` for how the derived two are worked out.

/** How a tool call reads while it runs, once it is done, and when it fails. */
const TOOL_LABELS: Record<
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

function toolLabel(tool: ToolData) {
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
function ToolLine({ tool }: { tool: ToolData }) {
  return <div>{toolLabel(tool)}</div>;
}

function UsageLine({ usage }: { usage: UsageData }) {
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
 * Why an upload did not land, in the strip under the composer. The Worker's own
 * refusals — too large, wrong kind, capability off — are written to be read and are
 * passed through. A failure from underneath it is not: it arrives as a runtime's
 * internal wording, and naming the file the user picked is more use than quoting it.
 */
function uploadFailure(name: string, error?: string): string {
  const raw = error?.trim();
  if (!raw) return `Could not upload ${name}.`;
  const platform = describeSessionFailure(raw);
  if (platform) return platform;
  // Anything long, or shaped like an internal error, is not a sentence for a user.
  if (
    raw.length > 160 ||
    /^[A-Za-z]*Error\b|SQL |stack|at \w+\.|<[a-z!]/i.test(raw)
  ) {
    return `Could not upload ${name}.`;
  }
  return raw;
}

/** Where the browser reads an attachment's bytes from. */
function fileUrl(sessionId: string, id: string) {
  return `/api/sessions/${encodeURIComponent(sessionId)}/files/${encodeURIComponent(id)}`;
}

/** The render of a PDF's first page, drawn at the head of its card. */
function thumbUrl(sessionId: string, id: string) {
  return `${fileUrl(sessionId, id)}/thumb`;
}

/**
 * A thumbnail from a route that wants to know who is asking.
 *
 * A browser attaches none of our identity headers to an image it fetches itself, so
 * under the localStorage back door a plain `<img src>` would come back 401. `useAuthedUrl`
 * reads the bytes with the headers attached and hands back a blob URL instead; with an
 * ordinary Clerk session it passes the URL straight through and this is just an `img`.
 */
function Thumb({ src }: { src: string }) {
  const href = useAuthedUrl(src);
  if (!href) return null;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={href} alt="" className="w-full object-cover object-top" />;
}

/**
 * Markdown, rendered with an explicit component map rather than a prose plugin, so
 * every element lands on the same monochrome scale as the rest of the app.
 */
const MARKDOWN_COMPONENTS = (sessionId: string) => ({
  p: (props: React.ComponentProps<"p">) => (
    <p className="my-2 first:mt-0 last:mb-0" {...props} />
  ),
  ul: (props: React.ComponentProps<"ul">) => (
    <ul className="my-2 list-disc space-y-1 pl-5" {...props} />
  ),
  ol: (props: React.ComponentProps<"ol">) => (
    <ol className="my-2 list-decimal space-y-1 pl-5" {...props} />
  ),
  li: (props: React.ComponentProps<"li">) => (
    <li className="leading-normal" {...props} />
  ),
  h1: (props: React.ComponentProps<"h1">) => (
    <h1 className="mt-4 mb-2 text-xl" {...props} />
  ),
  h2: (props: React.ComponentProps<"h2">) => (
    <h2 className="mt-4 mb-2 text-lg" {...props} />
  ),
  h3: (props: React.ComponentProps<"h3">) => (
    <h3 className="mt-3 mb-1 text-base" {...props} />
  ),
  a: (props: React.ComponentProps<"a">) => (
    <a
      className="underline underline-offset-2"
      target="_blank"
      rel="noreferrer"
      {...props}
    />
  ),
  strong: (props: React.ComponentProps<"strong">) => (
    <strong className="font-semibold" {...props} />
  ),
  hr: () => <hr className="border-hairline-soft my-4" />,
  blockquote: (props: React.ComponentProps<"blockquote">) => (
    <blockquote
      className="border-hairline my-2 border-l-2 pl-4 italic"
      {...props}
    />
  ),
  code: ({ className, ...props }: React.ComponentProps<"code">) =>
    // Fenced code arrives wrapped in <pre>, which carries the block styling; only
    // inline code needs its own chip.
    className?.includes("language-") ? (
      <code className={className} {...props} />
    ) : (
      <code
        className="bg-canvas-soft rounded px-1.5 py-0.5 text-sm"
        {...props}
      />
    ),
  pre: (props: React.ComponentProps<"pre">) => (
    <pre
      className="bg-canvas-soft my-2 overflow-x-auto rounded-2xl px-4 py-3 text-[13px] leading-normal"
      {...props}
    />
  ),
  table: (props: React.ComponentProps<"table">) => (
    <div className="my-2 overflow-x-auto">
      <table className="w-full border-collapse text-sm" {...props} />
    </div>
  ),
  th: (props: React.ComponentProps<"th">) => (
    <th
      className="border-hairline-soft border-b px-3 py-2 text-left font-semibold"
      {...props}
    />
  ),
  td: (props: React.ComponentProps<"td">) => (
    <td
      className="border-hairline-soft border-b px-3 py-2 align-top"
      {...props}
    />
  ),
  img: ({ src, alt }: React.ComponentProps<"img">) => (
    // The Worker names its own path for a generated image; the browser reaches it
    // through the API route.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={String(src ?? "").replace(
        /^\/agents\/session-agent\/[^/]+\/files\//,
        `/api/sessions/${encodeURIComponent(sessionId)}/files/`,
      )}
      alt={alt ?? ""}
      className="border-hairline-soft my-2 block max-w-full rounded-2xl border"
    />
  ),
});

/** Softens the last line of a file preview, so the cut reads as a sample. */
const FADE = "linear-gradient(to bottom, #000 55%, transparent 100%)";

/** A voice note is stored as a text attachment; only its mime type gives it away. */
function isAudio(a: Attachment) {
  return a.mime.startsWith("audio/") || a.mime.startsWith("video/");
}

/** m:ss, for player positions and durations. */
function clock(seconds: number) {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/** The wall-clock time a message was sent, without the date the sidebar already shows. */
function timeOfDay(ts: number) {
  return new Date(ts).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * A fixed bar pattern per clip. Real amplitudes would mean decoding the whole file in
 * the browser; a stable pseudo-random figure reads the same way and costs nothing.
 */
function bars(id: string, count = 34) {
  let seed = 0;
  for (let i = 0; i < id.length; i++)
    seed = (seed * 31 + id.charCodeAt(i)) >>> 0;
  return Array.from({ length: count }, () => {
    seed = (seed * 1103515245 + 12345) >>> 0;
    return 0.25 + ((seed >>> 16) % 1000) / 1000 / 1.35;
  });
}

/** Play/scrub a voice note in place, with its transcript underneath. */
function VoiceNote({
  attachment,
  sessionId,
  isUser,
}: {
  attachment: Attachment;
  sessionId: string;
  isUser: boolean;
}) {
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [at, setAt] = useState(0);
  const [total, setTotal] = useState(0);
  const shape = useMemo(() => bars(attachment.id), [attachment.id]);
  const progress = total > 0 ? at / total : 0;

  const toggle = () => {
    const el = audio.current;
    if (!el) return;
    if (el.paused) void el.play();
    else el.pause();
  };

  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = audio.current;
    if (!el || !total) return;
    const box = e.currentTarget.getBoundingClientRect();
    el.currentTime = ((e.clientX - box.left) / box.width) * total;
  };

  return (
    <div
      className={`w-fit max-w-full rounded-[14px] px-3 py-2.5 ${isUser ? "bg-white/10" : "bg-field"}`}
    >
      <div className="flex items-center gap-3">
        <button
          onClick={toggle}
          aria-label={
            playing ? `Pause ${attachment.name}` : `Play ${attachment.name}`
          }
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${
            isUser ? "bg-white/20" : "bg-ink text-on-primary"
          }`}
        >
          {playing ? (
            <Pause size={14} strokeWidth={2} fill="currentColor" />
          ) : (
            <Play
              size={14}
              strokeWidth={2}
              fill="currentColor"
              className="ml-0.5"
            />
          )}
        </button>

        <div
          onClick={seek}
          // Fixed width, not flex-1: the card is w-fit, so a basis-0 track would
          // contribute nothing to the intrinsic width and collapse to no bars.
          className="flex h-9 w-48 max-w-full shrink-0 cursor-pointer items-center gap-px"
        >
          {shape.map((h, i) => (
            <span
              key={i}
              className="flex-1 rounded-full"
              style={{
                height: `${Math.round(h * 26)}px`,
                backgroundColor: "currentColor",
                opacity: i / shape.length <= progress ? 0.9 : 0.28,
              }}
            />
          ))}
        </div>

        <span
          className={`tnum shrink-0 text-xs leading-[1.33] ${isUser ? "opacity-70" : "text-faint"}`}
        >
          {clock(playing || at > 0 ? total - at : total)}
        </span>
      </div>

      {attachment.preview && (
        <p
          className={`mt-2 text-[13px] leading-[1.4] ${isUser ? "opacity-70" : "text-muted"}`}
        >
          {attachment.preview}
        </p>
      )}

      <audio
        ref={audio}
        src={fileUrl(sessionId, attachment.id)}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          setAt(0);
        }}
        onLoadedMetadata={(e) => {
          const d = e.currentTarget.duration;
          setTotal(Number.isFinite(d) ? d : 0);
        }}
        onTimeUpdate={(e) => setAt(e.currentTarget.currentTime)}
      />
    </div>
  );
}

/** Attachments queued in the composer: images as thumbnails, files as chips. */
function AttachmentStrip({
  attachments,
  sessionId,
  onRemove,
}: {
  attachments: Attachment[];
  sessionId: string;
  onRemove?: (id: string) => void;
}) {
  if (attachments.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {attachments.map((a) =>
        a.kind === "image" ? (
          <span key={a.id} className="relative">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={fileUrl(sessionId, a.id)}
              alt={a.name}
              className="border-hairline-soft h-16 w-16 rounded-xl border object-cover"
            />
            {onRemove && (
              <button
                onClick={() => onRemove(a.id)}
                aria-label={`Remove ${a.name}`}
                className="bg-ink text-on-primary absolute -top-1.5 -right-1.5 flex h-5 w-5 items-center justify-center rounded-full"
              >
                <X size={11} strokeWidth={2.5} />
              </button>
            )}
          </span>
        ) : (
          <span
            key={a.id}
            className="bg-field text-ink flex items-center gap-2 rounded-full py-1.5 pr-2 pl-3 text-xs leading-[1.33]"
          >
            {isAudio(a) ? (
              <Mic size={13} strokeWidth={1.75} className="shrink-0" />
            ) : a.kind === "pdf" ? (
              <FileType2 size={13} strokeWidth={1.75} className="shrink-0" />
            ) : (
              <FileText size={13} strokeWidth={1.75} className="shrink-0" />
            )}
            <span className="max-w-[200px] truncate">
              {isAudio(a) ? "Voice note" : a.name}
            </span>
            {onRemove && (
              <button
                onClick={() => onRemove(a.id)}
                aria-label={`Remove ${a.name}`}
                className="text-muted hover:text-ink flex h-5 w-5 items-center justify-center rounded-full"
              >
                <X size={12} strokeWidth={2} />
              </button>
            )}
          </span>
        ),
      )}
    </div>
  );
}

/**
 * Non-image attachments on a sent message: one fixed-width card per file. The card
 * leads with the file's own first words, faded out at the foot of the sample so the
 * cut reads as a page continuing rather than as text that ended — with the name
 * sitting in the fade, the way a thumbnail of a first page is captioned.
 */
function MessageDocs({
  docs,
  isUser,
  sessionId,
}: {
  docs: Attachment[];
  isUser: boolean;
  sessionId: string;
}) {
  if (docs.length === 0) return null;
  return (
    <div className="space-y-1.5">
      {docs.map((a) =>
        isAudio(a) ? (
          <VoiceNote
            key={a.id}
            attachment={a}
            sessionId={sessionId}
            isUser={isUser}
          />
        ) : (
          <div
            key={a.id}
            className={`w-[268px] max-w-full overflow-hidden rounded-[14px] ${
              isUser ? "bg-white/10" : "bg-field"
            }`}
          >
            {a.thumb ? (
              // A PDF shows its own first page. The image is wider than it is tall
              // here on purpose: the card is a glimpse of the page, not a reader.
              <span
                className="block h-[124px] overflow-hidden"
                style={{ maskImage: FADE, WebkitMaskImage: FADE }}
              >
                <Thumb src={thumbUrl(sessionId, a.id)} />
              </span>
            ) : (
              a.preview && (
                <span
                  className={`block max-h-[7.8em] overflow-hidden px-3 pt-3 font-mono text-[11.5px] leading-[1.3] whitespace-pre-wrap ${
                    isUser ? "opacity-55" : "text-muted"
                  }`}
                  style={{
                    // The preview is a sample, not the file: fading it out says so
                    // without a truncation mark that could be read as content.
                    maskImage: FADE,
                    WebkitMaskImage: FADE,
                  }}
                >
                  {a.preview}
                </span>
              )
            )}
            <span
              className={`block truncate px-3 pb-2.5 text-[13px] leading-[1.35] ${
                a.thumb || a.preview ? "pt-1.5" : "pt-2.5"
              }`}
            >
              {a.name}
            </span>
          </div>
        ),
      )}
    </div>
  );
}

/**
 * Images on a sent message, laid out the way a messaging app does it: flush to the
 * bubble edge, one large frame for a single image and a square grid beyond that.
 */
function MessageMedia({
  images,
  sessionId,
}: {
  images: Attachment[];
  sessionId: string;
}) {
  if (images.length === 0) return null;
  const single = images.length === 1;
  return (
    <div className={single ? "" : "grid grid-cols-2 gap-1"}>
      {images.map((a) => (
        <span key={a.id} className="group relative block">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={fileUrl(sessionId, a.id)}
            alt={a.name}
            className={`block w-full rounded-2xl bg-black/6 ${
              single
                ? "max-h-[360px] object-contain"
                : "aspect-square object-cover"
            }`}
          />
        </span>
      ))}
    </div>
  );
}

/**
 * Anything that is neither the user nor the agent talking: a dropped stream, a failed
 * turn. Centred and quiet, so it never reads as a message someone sent.
 */
function SystemNotice({ text }: { text: string }) {
  return (
    <div className="flex justify-center">
      <div className="border-hairline-soft text-muted flex max-w-md items-center gap-2.5 rounded-full border px-4 py-2 text-[13px] leading-[1.35]">
        <AlertCircle size={14} strokeWidth={1.75} className="shrink-0" />
        <span className="min-w-0">{text}</span>
      </div>
    </div>
  );
}

/** Pull an attachment down. Same-origin, so the browser saves it under its own name. */
function DownloadLink({
  sessionId,
  attachment,
  className = "",
}: {
  sessionId: string;
  attachment: Attachment;
  className?: string;
}) {
  return (
    <a
      href={fileUrl(sessionId, attachment.id)}
      download={attachment.name}
      title={`Download ${attachment.name}`}
      aria-label={`Download ${attachment.name}`}
      className={`flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 ${className}`}
    >
      <Download size={13} strokeWidth={1.75} />
    </a>
  );
}

/** Three dots, while the agent has been asked something but has not started writing. */
function Thinking() {
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
function MessageActions({
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

type ToolPart = { type: "data-tool"; id?: string; data: ToolData };
type Step =
  | { kind: "text"; text: string }
  | { kind: "tools"; tools: ToolPart[] };

/** Fold a message's parts into the ordered steps of the turn. */
function buildSteps(parts: ChatUIMessage["parts"]): Step[] {
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
function splitQuote(text: string): { quote: string; body: string } {
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
function Bubble({
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

/**
 * An assistant turn's stored steps as message parts. Turns saved before steps existed
 * — and any turn that ran no tools — fall back to the plain text of the row.
 */
function storedParts(row: StoredMessage): ChatUIMessage["parts"] {
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
function toUIMessages(rows: StoredMessage[]): ChatUIMessage[] {
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

/** A PDF by mime, or by name when the browser sends no type at all. */
function isPdfFile(file: File): boolean {
  return file.type === "application/pdf" || /\.pdf$/i.test(file.name);
}

/** The file types the attach button offers, given which input capabilities are on. */
function acceptFor(ready: Set<string>): string {
  const accept: string[] = [];
  if (ready.has("file_ingest"))
    accept.push(
      "text/*",
      "application/pdf",
      ".pdf",
      ".md",
      ".csv",
      ".json",
      ".yaml",
      ".ts",
      ".tsx",
      ".py",
    );
  if (ready.has("vision")) accept.push("image/*");
  // OpenRouter takes WAV and MP3 audio; other containers are rejected on upload.
  if (ready.has("audio_input"))
    accept.push("audio/wav", "audio/mpeg", ".wav", ".mp3");
  return accept.join(",");
}

/**
 * Where a fork taken at message `i` of the drawn page should cut, and what goes back
 * into the composer: the user's question is dropped from the copy and returned as a draft
 * so it can be reworded. An assistant reply with no question before it just cuts.
 */
function forkAt(
  messages: ChatUIMessage[],
  i: number,
  offset: number,
): [count: number, draft: string] {
  const prev = messages[i - 1];
  // `offset` is the messages the transcript starts with that were never loaded: the
  // agent copies the first `count` of the whole conversation, so an index into the
  // drawn page alone would cut the fork short by everything above it.
  if (!prev || prev.role !== "user") return [offset + i, ""];
  const draft = prev.parts
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("");
  return [offset + i - 1, draft];
}

/**
 * How a session that lives on another platform is marked: the wash behind the
 * footer, the link's underline and the logo, in that platform's own colour.
 * Tailwind reads classes as written, so each one is spelled out rather than built.
 */
const CHANNEL_MARK = {
  telegram: {
    fade: "from-[#229ED9]/18",
    underline: "decoration-[#229ED9]",
    fill: "fill-[#229ED9]",
    path: "M12 0a12 12 0 1 0 0 24 12 12 0 0 0 0-24Zm5.56 8.22-1.86 8.78c-.14.62-.51.77-1.03.48l-2.85-2.1-1.37 1.32c-.15.15-.28.28-.58.28l.2-2.9 5.29-4.78c.23-.2-.05-.32-.36-.12l-6.54 4.12-2.82-.88c-.61-.19-.62-.61.13-.9l11.03-4.25c.51-.19.96.12.79.95Z",
  },
  whatsapp: {
    fade: "from-[#25D366]/18",
    underline: "decoration-[#25D366]",
    fill: "fill-[#25D366]",
    path: "M12.04 0A11.9 11.9 0 0 0 1.76 17.9L.06 24l6.25-1.64A11.9 11.9 0 1 0 12.04 0Zm0 21.8a9.9 9.9 0 0 1-5.04-1.38l-.36-.21-3.71.97.99-3.62-.24-.37a9.9 9.9 0 1 1 8.36 4.61Zm5.43-7.41c-.3-.15-1.76-.87-2.03-.97-.27-.1-.47-.15-.67.15-.2.3-.77.96-.94 1.16-.18.2-.35.22-.65.07a8.1 8.1 0 0 1-2.39-1.47 9 9 0 0 1-1.65-2.06c-.17-.3-.02-.46.13-.61.14-.14.3-.35.45-.53.15-.18.2-.3.3-.5.1-.2.05-.38-.02-.53-.08-.15-.67-1.61-.92-2.2-.24-.58-.49-.5-.67-.51h-.57c-.2 0-.52.07-.8.37-.27.3-1.04 1.02-1.04 2.48s1.07 2.88 1.22 3.08c.15.2 2.1 3.2 5.08 4.49.71.3 1.26.49 1.7.63.71.22 1.36.19 1.87.12.57-.09 1.76-.72 2-1.42.25-.7.25-1.29.18-1.42-.08-.13-.28-.2-.58-.35Z",
  },
} as const;

export function Chat({
  sessionId,
  initialMessages,
  initialHasOlder = false,
  initialOffset = 0,
  onLoadOlder,
  onTurnEnd,
  onFork,
  initialInput = "",
  continueAt = null,
}: {
  sessionId: string;
  /** The newest page of the transcript. Older ones are fetched as it is scrolled. */
  initialMessages: StoredMessage[];
  /** Whether anything precedes `initialMessages`. */
  initialHasOlder?: boolean;
  /** How many messages precede `initialMessages` in the full transcript. */
  initialOffset?: number;
  /** The page before the oldest message held, or null when it cannot be read. */
  onLoadOlder?: (beforeId: string) => Promise<TranscriptPage | null>;
  onTurnEnd: () => void;
  /**
   * Branch the conversation: the first `count` messages become a new session,
   * and `draft` is the question that was dropped, handed back for editing.
   *
   * `count` is absolute — counted from the start of the whole transcript, not from
   * the start of the page drawn — because the agent forks from the beginning.
   */
  onFork: (count: number, draft: string) => void;
  /** Text the composer opens with — a forked question waiting to be re-asked. */
  initialInput?: string;
  /**
   * A conversation that lives somewhere else. The transcript still reads here, but
   * there is nothing to type into: the reply has to come from the place it started.
   */
  continueAt?: {
    label: string;
    href: string;
    channel: "telegram" | "whatsapp";
  } | null;
}) {
  const [input, setInput] = useState(initialInput);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  /** Seconds into the current take, or null when the mic is idle. */
  const [recordedFor, setRecordedFor] = useState<number | null>(null);
  // Local previews shown while a file is still on its way to the Worker.
  const [ghosts, setGhosts] = useState<
    { key: string; name: string; preview: string | null }[]
  >([]);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [ready, setReady] = useState<Set<string>>(new Set());
  /** The deployment's composer ceilings, replaced by the real ones on the first `/config`. */
  const [limits, setLimits] = useState<ClientLimits | null>(null);
  // A message streamed in this session has no stored timestamp yet, so the arrival
  // time is recorded once, when the message first appears. It lives in a plain map
  // rather than in state: writing it must not itself cause a render.
  const [seen] = useState(() => new Map<string, number>());
  const bottom = useRef<HTMLDivElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  /** The scrolling element, so a prepend can be pinned against what it pushed down. */
  const scroller = useRef<HTMLDivElement>(null);
  const olderSentinel = useRef<HTMLDivElement>(null);
  /** Whether more transcript sits behind the oldest message drawn. */
  const [hasOlder, setHasOlder] = useState(initialHasOlder);
  /** How many messages precede the oldest one held — what a fork's count is offset by. */
  const [offset, setOffset] = useState(initialOffset);
  const [loadingOlder, setLoadingOlder] = useState(false);
  /**
   * Set while older messages are being spliced in, so the effect that follows a new
   * reply to the bottom does not fire on a prepend and throw the reader back down.
   */
  const prepending = useRef(false);

  // Which input capabilities are usable decides what may be attached at all. They
  // belong to the agent, and the session id says which agent that is — so there is
  // nothing extra to thread down here.
  useEffect(() => {
    void (async () => {
      const agentId = agentIdOf(sessionId);
      if (!agentId) return;
      const res = await apiFetch(
        `/api/agents/${encodeURIComponent(agentId)}/config`,
      );
      const payload = (await res.json().catch(() => null)) as {
        config: Config;
        capabilities: Capability[];
        limits: ClientLimits;
      } | null;
      if (!payload?.config) return;
      setLimits(payload.limits);
      setReady(
        new Set(
          payload.capabilities
            .filter((c) => capabilityReady(c, payload.config))
            .map((c) => c.id),
        ),
      );
    })();
  }, [sessionId]);

  // An upload that was never sent stays pending in the Durable Object, so the chips
  // are restored when the session is reopened.
  useEffect(() => {
    void (async () => {
      const res = await apiFetch(
        `/api/sessions/${encodeURIComponent(sessionId)}/files`,
      );
      const payload = (await res.json().catch(() => null)) as {
        attachments?: Attachment[];
      } | null;
      setAttachments(payload?.attachments ?? []);
    })();
  }, [sessionId]);

  // The reply the transcript ends with, if it ends with one. It is what the reconnect
  // names, so the agent knows whether a turn finished while the page was loading.
  const lastReply =
    initialMessages[initialMessages.length - 1]?.role === "assistant"
      ? String(initialMessages[initialMessages.length - 1].id)
      : "";

  const { messages, setMessages, sendMessage, regenerate, stop, status, error } =
    useChat<ChatUIMessage>({
      id: sessionId,
      messages: toUIMessages(initialMessages),
      transport: new DefaultChatTransport({
        api: `/api/sessions/${encodeURIComponent(sessionId)}/chat`,
        // The transport does its own fetching, so it cannot go through `apiFetch`.
        // A function rather than an object: it is read at send time, so becoming a
        // different address mid-session takes effect on the next turn.
        headers: identityHeaders,
        // Reconnecting is a GET to the same route, not to `<api>/<id>/stream`.
        prepareReconnectToStreamRequest: ({ api }) => ({
          api: `${api}?has=${encodeURIComponent(lastReply)}`,
          headers: identityHeaders(),
        }),
      }),
      // A reload does not stop the turn: the agent keeps answering, so the reply is
      // picked up where it got to instead of only appearing on the next reload.
      resume: true,
      onFinish: onTurnEnd,
    });

  const streaming = status === "streaming" || status === "submitted";
  const recording = recordedFor !== null;
  const canAttach =
    ready.has("file_ingest") || ready.has("vision") || ready.has("audio_input");

  useEffect(() => {
    // A prepend changes `messages` too, and following it to the bottom would undo
    // the scroll the reader just made to reach the top.
    if (prepending.current) {
      prepending.current = false;
      return;
    }
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  /**
   * Read the page before the oldest message held and splice it in front.
   *
   * The scroll position is measured against the bottom of the content rather than
   * the top: prepending grows the element upward, and holding `scrollHeight -
   * scrollTop` fixed leaves the message the reader was looking at where it was.
   */
  const loadOlder = useCallback(async () => {
    const box = scroller.current;
    const oldest = messages[0];
    if (!onLoadOlder || !oldest || loadingOlder || !hasOlder) return;
    setLoadingOlder(true);
    try {
      const page = await onLoadOlder(String(oldest.id));
      if (!page) return;
      const fromBottom = box ? box.scrollHeight - box.scrollTop : 0;
      prepending.current = true;
      // Ids already drawn are skipped: a turn that landed between the two reads can
      // shift the window, and a duplicate key would break the list.
      setMessages((current) => {
        const held = new Set(current.map((m) => m.id));
        const older = toUIMessages(page.messages).filter((m) => !held.has(m.id));
        return [...older, ...current];
      });
      setHasOlder(page.has_more);
      setOffset(page.offset);
      if (box) {
        // After paint, so the new height is the one being corrected against.
        requestAnimationFrame(() => {
          box.scrollTop = box.scrollHeight - fromBottom;
        });
      }
    } finally {
      setLoadingOlder(false);
    }
  }, [onLoadOlder, messages, loadingOlder, hasOlder, setMessages]);

  // Older messages arrive when the top of the transcript is scrolled into view.
  useEffect(() => {
    const node = olderSentinel.current;
    if (!node || !hasOlder) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) void loadOlder();
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasOlder, loadOlder]);

  // Stamp anything the transcript did not arrive with a time for.
  useEffect(() => {
    const now = Date.now();
    for (const m of messages) if (!seen.has(m.id)) seen.set(m.id, now);
  }, [messages, seen]);

  const remove = async (id: string) => {
    // The strip is what the notice was about, so changing it retires the notice.
    setUploadError(null);
    setAttachments((a) => a.filter((x) => x.id !== id));
    await apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/files/${id}`, {
      method: "DELETE",
    });
  };

  const upload = async (picked: File[]) => {
    if (!limits) {
      setUploadError("Still loading this deployment's limits. Try again in a moment.");
      return;
    }
    setUploading(true);
    setUploadError(null);

    // The Worker enforces this too; catching it here means the files that do fit are
    // still picked up, rather than the whole drop failing on the one that does not.
    const perMessage = limits.max_files_per_message;
    const room = perMessage - (attachments.length + ghosts.length);
    if (picked.length > room) {
      setUploadError(
        `A message can carry ${perMessage} files. Send the rest with the next message.`,
      );
      picked = picked.slice(0, Math.max(room, 0));
      if (picked.length === 0) {
        setUploading(false);
        return;
      }
    }
    // Every pick gets its card before any of them is sent. The uploads themselves stay
    // one at a time — several large files at once is how the Worker gets overwhelmed —
    // but a queue the user cannot see reads as though only one file was picked up.
    //
    // An image previews from the browser's own copy, so the thumbnail is there on pick
    // rather than after the round trip, and before the re-encode below.
    const queued = picked.map((original) => ({
      original,
      key: `${original.name}-${nextKey.current++}`,
      preview: original.type.startsWith("image/")
        ? URL.createObjectURL(original)
        : null,
    }));
    setGhosts((g) => [
      ...g,
      ...queued.map(({ key, original, preview }) => ({
        key,
        name: original.name,
        preview,
      })),
    ]);

    let aborted = false;
    // Ids accepted during this pick. The ref behind `kept` only catches up on the
    // next render, and the reconcile below must not mistake a file it just stored
    // for one the user cancelled.
    const accepted: string[] = [];

    /** Nothing more is owed to a file once it is settled, kept or taken back. */
    const drop = (key: string, preview: string | null) => {
      cancelled.current.delete(key);
      controllers.current.delete(key);
      setGhosts((g) => g.filter((x) => x.key !== key));
      if (preview) URL.revokeObjectURL(preview);
    };

    for (const { original, key, preview } of queued) {
      // Taken back before its turn came up: it is never sent at all. The queue is
      // one at a time, so most of a multi-file pick is still waiting here.
      if (cancelled.current.has(key)) {
        aborted = true;
        drop(key, preview);
        continue;
      }
      const isImage = original.type.startsWith("image/");

      // A photo off a phone is routinely past the ceiling; shrink it rather than
      // sending the user away to resize it. Anything that cannot be shrunk is sent
      // as it is, so the Worker's own message is what they see.
      const file = isImage
        ? ((await fitImage(original, imageTarget(limits))) ?? original)
        : original;

      const form = new FormData();
      form.set("file", file);
      // The card shows the PDF's first page, and only the browser can draw it.
      if (isPdfFile(file)) {
        const thumb = await pdfThumbnail(file);
        if (thumb) form.set("thumbnail", thumb);
      }
      // Encoding a large image or drawing a PDF's first page takes long enough that
      // the file can be taken back in the middle of it.
      if (cancelled.current.has(key)) {
        aborted = true;
        drop(key, preview);
        continue;
      }

      // Cancelling aborts the request rather than letting the bytes finish arriving
      // and deleting what they became: on a 7 MB file that is the difference between
      // stopping and appearing to stop.
      const controller = new AbortController();
      controllers.current.set(key, controller);

      type UploadPayload = { attachment?: Attachment; error?: string } | null;
      let res: Response;
      let payload: UploadPayload = null;
      try {
        res = await apiFetch(
          `/api/sessions/${encodeURIComponent(sessionId)}/files`,
          {
            method: "POST",
            body: form,
            signal: controller.signal,
          },
        );
        payload = (await res.json().catch(() => null)) as UploadPayload;
      } catch (err) {
        drop(key, preview);
        // An abort is the user's own doing and needs no telling.
        if (err instanceof DOMException && err.name === "AbortError") {
          aborted = true;
        } else {
          setUploadError(uploadFailure(file.name));
        }
        continue;
      }

      // Cancelled as it landed: the Worker stored it before the abort could reach it,
      // so the tidying happens here rather than being left behind.
      if (cancelled.current.has(key)) {
        aborted = true;
        drop(key, preview);
        if (payload?.attachment) void remove(payload.attachment.id);
        continue;
      }
      drop(key, preview);

      if (!res.ok || !payload?.attachment) {
        setUploadError(uploadFailure(file.name, payload?.error));
        continue;
      }
      accepted.push(payload.attachment.id);
      setAttachments((a) => [...a, payload.attachment!]);
    }
    setUploading(false);
    // Cancels are the only way the Worker ends up holding something the strip does
    // not, so the reconcile is paid for only when one happened.
    if (aborted) {
      strayPossible.current = true;
      await reconcilePending(accepted);
    }
  };

  /** Held for as long as a send is in flight, so a second Return finds the door shut. */
  const sending = useRef(false);

  /** Counter behind the ghost keys: unique per pick, without reading the clock. */
  const nextKey = useRef(0);

  /** Uploads dropped by the user before the Worker answered. */
  const cancelled = useRef(new Set<string>());

  /**
   * Set only when a cancel raced a landed upload, so the Worker might be holding a
   * file the strip does not know about. Reconciling is a network round trip, and
   * paying it on every send — including plain text with no uploads ever attempted —
   * is what made the composer feel laggy.
   */
  const strayPossible = useRef(false);

  /** The request behind each upload in flight, so cancelling can stop it. */
  const controllers = useRef(new Map<string, AbortController>());

  /** What the strip is holding, readable from async code that outlives a render. */
  const kept = useRef<Set<string>>(new Set());
  useEffect(() => {
    kept.current = new Set(attachments.map((a) => a.id));
  }, [attachments]);

  /**
   * Drop anything the Worker is holding for the next turn that the strip is not.
   *
   * Aborting a request does not unsend the bytes already on their way: the Worker can
   * finish storing a file after the browser has stopped listening, and the response
   * naming it never arrives. That row would then be invisible here and still be sent
   * with the next message, so the session is asked what it has and told what to drop.
   */
  const reconcilePending = async (accepted: string[] = []) => {
    try {
      const res = await apiFetch(
        `/api/sessions/${encodeURIComponent(sessionId)}/files`,
      );
      const payload = (await res.json()) as { attachments?: Attachment[] };
      const keep = new Set([...kept.current, ...accepted]);
      const stray = (payload.attachments ?? []).filter((a) => !keep.has(a.id));
      strayPossible.current = false;
      await Promise.all(
        stray.map((a) =>
          apiFetch(
            `/api/sessions/${encodeURIComponent(sessionId)}/files/${a.id}`,
            {
              method: "DELETE",
            },
          ),
        ),
      );
    } catch {
      // Best effort: a stray file is a wasted upload, not a broken session.
    }
  };

  /** Take a pending upload off the strip; its row is deleted when it lands. */
  const cancelUpload = (key: string) => {
    setUploadError(null);
    cancelled.current.add(key);
    controllers.current.get(key)?.abort();
    setGhosts((g) => {
      const ghost = g.find((x) => x.key === key);
      if (ghost?.preview) URL.revokeObjectURL(ghost.preview);
      return g.filter((x) => x.key !== key);
    });
  };

  /** Hold the live recorder outside React state: it is a handle, not rendered data. */
  const recorder = useRef<Recorder | null>(null);

  const record = async () => {
    // The take's length is capped by the deployment's audio ceiling; no ceiling yet,
    // no take.
    if (!limits) {
      setUploadError("Still loading this deployment's limits. Try again in a moment.");
      return;
    }
    setUploadError(null);
    try {
      recorder.current = await startRecording();
      setRecordedFor(0);
    } catch {
      setUploadError(
        "No microphone. Check the browser's permission for this site.",
      );
    }
  };

  const finishRecording = async (keep: boolean) => {
    const active = recorder.current;
    recorder.current = null;
    setRecordedFor(null);
    if (!active) return;
    if (!keep) {
      active.cancel();
      return;
    }
    try {
      const clip = await active.stop();
      if (clip) await upload([clip]);
    } catch {
      setUploadError("Could not encode the recording.");
    }
  };

  // Advance the counter once a second while a take is running, and never otherwise.
  // At the ceiling the take is stopped and kept, rather than left running into a clip
  // the Worker would reject.
  useEffect(() => {
    if (!recording) return;
    const id = setInterval(() => {
      setRecordedFor((s) => (s ?? 0) + 1);
      if (limits && (recordedFor ?? 0) + 1 >= recordingSeconds(limits)) {
        void finishRecording(true);
      }
    }, 1000);
    return () => clearInterval(id);
    // finishRecording is stable enough for this: it only reads refs and setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording, recordedFor]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (streaming) return;
    // A file still on its way belongs to this message, so the message waits for it.
    // Sending now would either leave the file behind or attach it to the turn after.
    if (uploading || ghosts.length > 0) return;
    // An attachment on its own is a valid turn: "here is the file" needs no words.
    if (!input.trim() && attachments.length === 0) return;
    // Return fires as fast as it is held down, and this function awaits before it
    // sends — `streaming` has not flipped yet, so the second press would send the
    // same message again. A ref closes that window because it changes now, not on
    // the next render.
    if (sending.current) return;
    sending.current = true;

    // Taken before the awaits below, so the message is fixed at the moment it was
    // sent rather than at whatever the composer holds when it finally goes.
    const text = input;
    const files = attachments;
    setInput("");
    setAttachments([]);
    setUploadError(null);

    try {
      // The turn carries every file the session is holding for it, not the ones drawn
      // here, so anything the strip has let go of has to be gone before the message
      // leaves — otherwise a cancelled upload arrives with it. Skipped when no cancel
      // has ever raced a landed upload in this composer: there is nothing to reconcile,
      // and the round trip was the visible delay before every send.
      if (strayPossible.current) {
        await reconcilePending(files.map((a) => a.id));
      }
      // The attachments ride along as a data part purely so the sent bubble can draw
      // them at once; the Worker already has them, and takes them from its own table.
      sendMessage({
        role: "user",
        parts: [
          ...(files.length
            ? [{ type: "data-files" as const, data: { attachments: files } }]
            : []),
          { type: "text" as const, text },
        ],
      });
    } finally {
      sending.current = false;
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={scroller}
        className="flex-1 space-y-6 overflow-y-auto px-4 py-6 md:px-8 md:py-10"
      >
        {hasOlder && (
          <div
            ref={olderSentinel}
            className="text-faint py-2 text-center text-xs leading-[1.33]"
          >
            {loadingOlder ? "Loading earlier messages…" : ""}
          </div>
        )}
        {messages.length === 0 && (
          <p className="text-muted mx-auto max-w-md text-center text-xl font-light leading-[1.38]">
            Session Connected. Send a message.
          </p>
        )}
        {messages.map((m, i) => {
          const stored = m.parts.find((p) => p.type === "data-meta") as
            | { type: "data-meta"; data: MetaData }
            | undefined;
          const at = stored?.data.ts ?? seen.get(m.id) ?? null;
          const last = i === messages.length - 1;
          return (
            <Bubble
              key={m.id}
              message={m}
              sessionId={sessionId}
              at={streaming && last ? null : at}
              pending={streaming && last && m.role === "assistant"}
              // A fork replays everything before the question that led here; the
              // question itself returns to the composer, ready to be edited.
              onFork={
                m.role === "assistant" && !streaming
                  ? () => onFork(...forkAt(messages, i, offset))
                  : undefined
              }
              onRetry={
                m.role === "assistant" && last && !streaming
                  ? () => void regenerate()
                  : undefined
              }
            />
          );
        })}
        {/* The reply has been asked for but the assistant message has not arrived yet. */}
        {streaming && messages[messages.length - 1]?.role === "user" && (
          <div className="flex justify-start">
            <div className="bg-canvas border-hairline-soft rounded-3xl border px-6 py-5">
              <Thinking />
            </div>
          </div>
        )}
        {error && <SystemNotice text={error.message} />}
        <div ref={bottom} />
      </div>

      {continueAt ? (
        <div
          className={`bg-linear-to-t to-transparent px-5 py-6 text-center md:px-8 md:py-7 ${CHANNEL_MARK[continueAt.channel].fade}`}
        >
          <p className="text-muted text-sm leading-[1.43]">
            Continue this conversation in{" "}
            <a
              href={continueAt.href}
              target="_blank"
              rel="noreferrer"
              className={`text-ink inline-flex items-center gap-1 underline underline-offset-4 hover:decoration-2 ${CHANNEL_MARK[continueAt.channel].underline}`}
            >
              <svg
                viewBox="0 0 24 24"
                aria-hidden="true"
                className={`h-[15px] w-[15px] ${CHANNEL_MARK[continueAt.channel].fill}`}
              >
                <path d={CHANNEL_MARK[continueAt.channel].path} />
              </svg>
              {continueAt.label}
            </a>
            .
          </p>
        </div>
      ) : (
        <div className="border-hairline-soft border-t px-4 py-4 md:px-8 md:py-6">
          {(attachments.length > 0 || ghosts.length > 0 || uploadError) && (
            <div className="mb-3 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <AttachmentStrip
                  attachments={attachments}
                  sessionId={sessionId}
                  onRemove={(id) => void remove(id)}
                />
                {ghosts.map((g) =>
                  g.preview ? (
                    <span key={g.key} className="relative">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={g.preview}
                        alt={g.name}
                        className="border-hairline-soft h-16 w-16 animate-pulse rounded-xl border object-cover"
                      />
                      <button
                        type="button"
                        onClick={() => cancelUpload(g.key)}
                        aria-label={`Cancel ${g.name}`}
                        className="bg-ink text-on-primary absolute -top-1.5 -right-1.5 flex h-5 w-5 items-center justify-center rounded-full"
                      >
                        <X size={11} strokeWidth={2.5} />
                      </button>
                    </span>
                  ) : (
                    <span
                      key={g.key}
                      className="bg-field text-muted flex items-center gap-2 rounded-full py-1.5 pr-2 pl-3 text-xs leading-[1.33]"
                    >
                      {/* The label pulses, not the chip: the cancel button must stay solid. */}
                      <FileText
                        size={13}
                        strokeWidth={1.75}
                        className="animate-pulse"
                      />
                      <span className="max-w-[200px] animate-pulse truncate">
                        {g.name}
                      </span>
                      <button
                        type="button"
                        onClick={() => cancelUpload(g.key)}
                        aria-label={`Cancel ${g.name}`}
                        className="text-muted hover:text-ink flex h-5 w-5 items-center justify-center rounded-full"
                      >
                        <X size={12} strokeWidth={2} />
                      </button>
                    </span>
                  ),
                )}
              </div>
              {uploadError && (
                <p className="text-muted text-xs">{uploadError}</p>
              )}
            </div>
          )}

          <form
            onSubmit={(e) => void submit(e)}
            className="flex gap-2 md:gap-3"
          >
            {canAttach && (
              <>
                <input
                  ref={picker}
                  type="file"
                  multiple
                  accept={acceptFor(ready)}
                  hidden
                  onChange={(e) => {
                    if (e.target.files?.length)
                      void upload(Array.from(e.target.files));
                    e.target.value = "";
                  }}
                />
                <button
                  type="button"
                  onClick={() => picker.current?.click()}
                  disabled={uploading}
                  title="Attach a file"
                  aria-label="Attach a file"
                  className="border-hairline text-ink hover:bg-canvas-soft flex h-12 w-12 shrink-0 items-center justify-center rounded-full border transition disabled:opacity-40"
                >
                  <Paperclip size={18} strokeWidth={1.75} />
                </button>
              </>
            )}
            {ready.has("audio_input") && !recording && (
              <button
                type="button"
                onClick={() => void record()}
                disabled={uploading}
                title="Record a voice note"
                aria-label="Record a voice note"
                className="border-hairline text-ink hover:bg-canvas-soft flex h-12 w-12 shrink-0 items-center justify-center rounded-full border transition disabled:opacity-40"
              >
                <Mic size={18} strokeWidth={1.75} />
              </button>
            )}

            {recording ? (
              <div className="bg-field flex h-12 min-w-0 flex-1 items-center gap-3 rounded-2xl px-4">
                <span className="bg-ink h-2.5 w-2.5 shrink-0 animate-pulse rounded-full" />
                <span className="text-ink tnum text-base">
                  {clock(recordedFor ?? 0)}
                </span>
                <span className="text-faint flex-1 text-[13px]">
                  {limits && recordingSeconds(limits) - (recordedFor ?? 0) <= 30
                    ? `Stopping in ${recordingSeconds(limits) - (recordedFor ?? 0)}s`
                    : "Recording…"}
                </span>
                <button
                  type="button"
                  onClick={() => void finishRecording(false)}
                  className="text-muted hover:text-ink text-[13px] transition"
                >
                  Discard
                </button>
              </div>
            ) : (
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={uploading ? "Uploading…" : "Message the agent…"}
                className="bg-field placeholder:text-faint text-ink focus:ring-ink h-12 min-w-0 flex-1 rounded-2xl px-4 text-base outline-none focus:ring-2"
              />
            )}
            {recording ? (
              <button
                type="button"
                onClick={() => void finishRecording(true)}
                title="Stop recording"
                aria-label="Stop recording"
                className="bg-ink text-on-primary flex h-12 w-12 shrink-0 items-center justify-center rounded-full transition hover:opacity-85"
              >
                <Square size={15} strokeWidth={2} fill="currentColor" />
              </button>
            ) : streaming ? (
              <button
                type="button"
                onClick={() => {
                  stop();
                  onTurnEnd();
                }}
                className="border-hairline text-ink hover:bg-canvas-soft h-12 shrink-0 rounded-full border px-6 text-base font-semibold transition"
              >
                Stop
              </button>
            ) : (
              <button
                type="submit"
                disabled={
                  uploading ||
                  ghosts.length > 0 ||
                  (!input.trim() && attachments.length === 0)
                }
                className="bg-ink text-on-primary h-12 min-w-12 shrink-0 rounded-full text-base font-semibold transition hover:opacity-85 disabled:opacity-30"
              >
                <span className="hidden md:block px-6">Send</span>
                <span className="md:hidden w-12 -ml-0.5 flex items-center justify-center">
                  <Send size={18} />
                </span>
              </button>
            )}
          </form>
        </div>
      )}
    </div>
  );
}
