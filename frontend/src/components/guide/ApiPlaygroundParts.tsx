"use client";

import { useState } from "react";

import {
  type Field,
  type Operation,
  type Reply,
  type Snippet,
  snippet,
} from "@/lib/openapi";

/**
 * The API playground's display pieces: method badges, the parameter table, and the dark
 * code panels for copyable requests and documented and live replies.
 */

/** What Send got back: the reply, or why there was none. */
export type Result =
  { status: number; ms: number; body: string } | { error: string };

const SNIPPETS: { id: Snippet; label: string }[] = [
  { id: "curl", label: "cURL" },
  { id: "javascript", label: "JavaScript" },
  { id: "python", label: "Python" },
];

export function SnippetView({
  url,
  op,
  body,
}: {
  url: string;
  op: Operation;
  body: string;
}) {
  const [kind, setKind] = useState<Snippet>("curl");
  return (
    <CodeBlock
      code={snippet(kind, url, op, body)}
      header={
        <div className="flex gap-1">
          {SNIPPETS.map((s) => (
            <Tab
              key={s.id}
              active={kind === s.id}
              onClick={() => setKind(s.id)}
            >
              {s.label}
            </Tab>
          ))}
        </div>
      }
    />
  );
}

export function Responses({ replies }: { replies: Reply[] }) {
  const [status, setStatus] = useState(replies[0].status);
  const reply = replies.find((r) => r.status === status) ?? replies[0];
  return (
    <CodeBlock
      code={reply.example}
      header={
        <div className="flex flex-wrap gap-1">
          {replies.map((r) => (
            <Tab
              key={r.status}
              active={r.status === status}
              onClick={() => setStatus(r.status)}
            >
              <span
                className={
                  r.status.startsWith("2") ? "text-emerald-400" : "text-red-400"
                }
              >
                ●
              </span>{" "}
              {r.status}
            </Tab>
          ))}
        </div>
      }
      note={
        <>
          {reply.description}
          {reply.type && <span className="text-white/40"> · {reply.type}</span>}
        </>
      }
    />
  );
}

function Tab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-md px-2 py-1 text-xs font-semibold transition-colors ${
        active ? "bg-white/15 text-white" : "text-white/55 hover:text-white"
      }`}
    >
      {children}
    </button>
  );
}

/** A dark code panel with tabs on top and a copy button. */
export function CodeBlock({
  code,
  header,
  note,
}: {
  code: string;
  header: React.ReactNode;
  note?: React.ReactNode;
}) {
  return (
    <div className="bg-ink overflow-hidden rounded-xl">
      <div className="flex items-center justify-between gap-2 border-b border-white/10 px-2 py-1.5">
        {header}
        {code && <CopyButton text={code} dark />}
      </div>
      {note && (
        <p className="border-b border-white/10 px-3 py-2 text-xs text-white/70">
          {note}
        </p>
      )}
      {code ? (
        <pre className="max-h-80 overflow-auto px-3 py-3 font-mono text-[12.5px] leading-relaxed text-white/90">
          {code}
        </pre>
      ) : (
        <p className="px-3 py-3 text-xs text-white/50">No body.</p>
      )}
    </div>
  );
}

export function CopyButton({
  text,
  label = "Copy",
  dark,
}: {
  text: string;
  label?: string;
  dark?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
      className={`h-8 shrink-0 rounded-full px-3 text-xs font-semibold transition-colors ${
        dark
          ? "text-white/70 hover:bg-white/10 hover:text-white"
          : "border-hairline hover:bg-canvas-soft border"
      }`}
    >
      {copied ? "Copied" : label}
    </button>
  );
}

const METHOD_STYLE: Record<string, string> = {
  GET: "bg-emerald-50 text-emerald-700",
  POST: "bg-blue-50 text-blue-700",
  PATCH: "bg-amber-50 text-amber-700",
  PUT: "bg-amber-50 text-amber-700",
  DELETE: "bg-red-50 text-red-700",
};

export function MethodBadge({ method }: { method: string }) {
  return (
    <span
      className={`inline-flex w-[58px] shrink-0 justify-center rounded-md py-0.5 font-mono text-[11px] font-bold ${
        METHOD_STYLE[method] ?? "bg-field text-ink"
      }`}
    >
      {method}
    </span>
  );
}

/** The path with its `{parameters}` picked out. */
export function PathText({ path }: { path: string }) {
  return (
    <>
      {path.split(/(\{\w+\})/).map((part, i) =>
        /^\{\w+\}$/.test(part) ? (
          <span key={i} className="text-accent">
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </>
  );
}

export function FieldTable({ fields }: { fields: Field[] }) {
  return (
    <div className="border-hairline divide-hairline-soft divide-y rounded-xl border">
      {fields.map((f) => (
        <div key={`${f.in}:${f.name}`} className="px-3 py-2.5">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <code className="font-mono text-[13px] font-semibold">
              {f.name}
            </code>
            <code className="text-muted font-mono text-xs break-all">
              {f.type}
            </code>
            <span className="text-faint text-[11px]">{f.in}</span>
            {f.required && (
              <span className="text-[11px] font-semibold text-red-600">
                required
              </span>
            )}
          </div>
          {f.description && (
            <p className="text-muted mt-1 text-[13px]">{f.description}</p>
          )}
        </div>
      ))}
    </div>
  );
}

export function ResultView({ result }: { result: Result }) {
  if ("error" in result)
    return <p className="text-sm text-red-600">{result.error}</p>;
  const ok = result.status >= 200 && result.status < 300;
  return (
    <CodeBlock
      code={result.body}
      header={
        <p className="px-1 text-xs font-semibold text-white">
          <span className={ok ? "text-emerald-400" : "text-red-400"}>
            {result.status}
          </span>
          <span className="text-white/50">
            {" "}
            · {result.ms} ms · live response
          </span>
        </p>
      }
    />
  );
}
