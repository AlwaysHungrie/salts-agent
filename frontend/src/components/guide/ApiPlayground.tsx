"use client";

import { useEffect, useState } from "react";

import {
  type Group,
  type OpenApiDoc,
  type Operation,
  agentOfKey,
  groupOperations,
  requestUrl,
} from "@/lib/openapi";

/**
 * The agent API, read from the Worker's own `/openapi.json`: one row per route, and a
 * Send button on each that calls the Worker straight from the browser with the key
 * pasted at the top. Nothing here lists a route by hand.
 *
 * Values a route needs in its path (`agentId`, `sessionId`, …) are entered once and
 * shared by every route; the agent comes from the key, and a session, upload or server
 * just created is remembered for the routes that follow. Nothing outlives the page.
 */

type Vars = Record<string, string>;
type Result = { status: number; ms: number; body: string } | { error: string };

const input =
  "bg-field placeholder:text-faint w-full rounded-xl px-3 py-2 font-mono text-[13px] outline-none";

export function ApiPlayground({ base }: { base: string }) {
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [failed, setFailed] = useState("");
  const [key, setKey] = useState("");
  const [vars, setVars] = useState<Vars>({});
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${base}/openapi.json`)
      .then((res) => res.json() as Promise<OpenApiDoc>)
      .then((doc) => setGroups(groupOperations(doc)))
      .catch(() => setFailed("Could not load the API description."));
  }, [base]);

  const setVar = (name: string, value: string) =>
    setVars((v) => ({ ...v, [name]: value }));

  if (failed) return <p className="text-muted text-sm">{failed}</p>;
  if (!groups) return <p className="text-muted text-sm">Loading the API…</p>;

  return (
    <div className="mt-6">
      <div className="bg-canvas-soft grid gap-3 rounded-2xl p-4 sm:grid-cols-[1fr_180px]">
        <label className="block">
          <span className="text-muted mb-1 block text-xs font-semibold">
            API key
          </span>
          <input
            type="password"
            value={key}
            onChange={(e) => {
              const next = e.target.value.replace(/^Bearer\s+/i, "").trim();
              setKey(next);
              if (agentOfKey(next)) setVar("agentId", agentOfKey(next));
            }}
            placeholder="salt_user_…"
            autoComplete="off"
            className={input}
          />
        </label>
        <label className="block">
          <span className="text-muted mb-1 block text-xs font-semibold">
            Agent id
          </span>
          <input
            value={vars.agentId ?? ""}
            onChange={(e) => setVar("agentId", e.target.value)}
            placeholder="from the key"
            className={input}
          />
        </label>
      </div>

      {groups.map((group) => (
        <section key={group.tag} className="mt-8">
          <h2 className="mb-2 text-base font-semibold">{group.tag}</h2>
          <div className="border-hairline overflow-hidden rounded-2xl border">
            {group.operations.map((op) => (
              <OperationRow
                key={op.id}
                op={op}
                open={open === op.id}
                onToggle={() => setOpen(open === op.id ? null : op.id)}
                base={base}
                apiKey={key}
                vars={vars}
                setVar={setVar}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function OperationRow({
  op,
  open,
  onToggle,
  ...panel
}: {
  op: Operation;
  open: boolean;
  onToggle: () => void;
  base: string;
  apiKey: string;
  vars: Vars;
  setVar: (name: string, value: string) => void;
}) {
  return (
    <div className="border-hairline-soft border-t first:border-t-0">
      <button
        onClick={onToggle}
        aria-expanded={open}
        className="hover:bg-canvas-soft flex w-full items-baseline gap-3 px-4 py-2.5 text-left transition-colors"
      >
        <span className="w-14 shrink-0 font-mono text-[11px] font-semibold">
          {op.method}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-mono text-[13px]">
            {op.path}
          </span>
          <span className="text-muted block text-xs">{op.summary}</span>
        </span>
      </button>
      {open && <OperationPanel op={op} {...panel} />}
    </div>
  );
}

/** What a reply names that a later route will want: the session, upload or server made. */
function remember(
  op: Operation,
  body: unknown,
  setVar: (name: string, value: string) => void,
) {
  if (op.method !== "POST" || typeof body !== "object" || body === null) return;
  const reply = body as {
    id?: string;
    attachment?: { id?: string };
    server?: { id?: string };
  };
  if (op.path.endsWith("/sessions") && reply.id) setVar("sessionId", reply.id);
  if (reply.attachment?.id) setVar("fileId", reply.attachment.id);
  if (reply.server?.id) setVar("serverId", reply.server.id);
}

function OperationPanel({
  op,
  base,
  apiKey,
  vars,
  setVar,
}: {
  op: Operation;
  base: string;
  apiKey: string;
  vars: Vars;
  setVar: (name: string, value: string) => void;
}) {
  const [query, setQuery] = useState<Vars>({});
  const [body, setBody] = useState(op.example);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

  async function send() {
    let payload: BodyInit | undefined;
    const headers: Record<string, string> = {
      authorization: `Bearer ${apiKey}`,
    };
    if (op.body === "json") {
      try {
        payload = JSON.stringify(JSON.parse(body || "{}"));
      } catch {
        return setResult({ error: "The body is not valid JSON." });
      }
      headers["content-type"] = "application/json";
    } else if (op.body === "file") {
      if (!file) return setResult({ error: "Choose a file first." });
      const form = new FormData();
      form.append("file", file);
      payload = form;
    }
    setBusy(true);
    const started = performance.now();
    try {
      const res = await fetch(requestUrl(base, op, vars, query), {
        method: op.method,
        headers,
        body: payload,
      });
      const type = res.headers.get("content-type") ?? "";
      const raw =
        type.includes("json") || type.startsWith("text/")
          ? await res.text()
          : "";
      let shown =
        raw ||
        `${(await res.arrayBuffer()).byteLength} bytes (${type || "binary"})`;
      if (type.includes("json") && raw) {
        const parsed: unknown = JSON.parse(raw);
        shown = JSON.stringify(parsed, null, 2);
        if (res.ok) remember(op, parsed, setVar);
      }
      setResult({
        status: res.status,
        ms: Math.round(performance.now() - started),
        body: shown,
      });
    } catch (err) {
      setResult({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bg-canvas-soft space-y-3 px-4 pt-1 pb-4">
      {op.description && <p className="text-muted text-sm">{op.description}</p>}

      {[
        ...op.pathParams.filter((p) => p !== "agentId"),
        ...op.query.map((q) => q.name),
      ].length > 0 && (
        <div className="grid gap-2 sm:grid-cols-2">
          {op.pathParams
            .filter((name) => name !== "agentId")
            .map((name) => (
              <Field key={name} label={name} hint="Shared by every route.">
                <input
                  value={vars[name] ?? ""}
                  onChange={(e) => setVar(name, e.target.value)}
                  className={input}
                />
              </Field>
            ))}
          {op.query.map((q) => (
            <Field key={q.name} label={`?${q.name}`} hint={q.description}>
              <input
                value={query[q.name] ?? ""}
                onChange={(e) =>
                  setQuery((v) => ({ ...v, [q.name]: e.target.value }))
                }
                className={input}
              />
            </Field>
          ))}
        </div>
      )}

      {op.body === "json" && (
        <Field label="Body (JSON)">
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={Math.min(12, Math.max(3, body.split("\n").length))}
            spellCheck={false}
            className={`${input} resize-y`}
          />
        </Field>
      )}
      {op.body === "file" && (
        <Field label="File">
          <input
            type="file"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="text-sm"
          />
        </Field>
      )}

      <div className="flex items-center gap-3">
        <button
          onClick={() => void send()}
          disabled={busy || !apiKey}
          className="bg-ink text-on-primary h-9 rounded-full px-5 text-sm font-semibold transition hover:opacity-85 disabled:opacity-40"
        >
          {busy ? "Sending…" : "Send"}
        </button>
        {!apiKey && (
          <span className="text-faint text-xs">
            Paste an API key above first.
          </span>
        )}
      </div>

      {result && <ResultView result={result} />}
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block font-mono text-xs font-semibold">
        {label}
      </span>
      {children}
      {hint && <span className="text-faint mt-1 block text-xs">{hint}</span>}
    </label>
  );
}

function ResultView({ result }: { result: Result }) {
  if ("error" in result) return <p className="text-sm">{result.error}</p>;
  const ok = result.status >= 200 && result.status < 300;
  return (
    <div>
      <p className="text-xs font-semibold">
        <span className={ok ? "text-ink" : "text-red-600"}>
          {result.status}
        </span>
        <span className="text-faint"> · {result.ms} ms</span>
      </p>
      <pre className="bg-canvas border-hairline mt-1 max-h-96 overflow-auto rounded-xl border p-3 font-mono text-[12px] leading-relaxed">
        {result.body}
      </pre>
    </div>
  );
}
