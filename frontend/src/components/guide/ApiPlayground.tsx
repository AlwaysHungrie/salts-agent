"use client";

import { useEffect, useMemo, useState } from "react";

import {
  type Group,
  type OpenApiDoc,
  type Operation,
  agentOfKey,
  groupOperations,
  requestUrl,
} from "@/lib/openapi";

import {
  CopyButton,
  FieldTable,
  MethodBadge,
  PathText,
  type Result,
  Responses,
  ResultView,
  SnippetView,
} from "./ApiPlaygroundParts";

/**
 * The agent API, read from the Worker's own `/openapi.json`: one row per route, and on
 * each its inputs, the responses it can give, a request to copy (curl, JavaScript,
 * Python) and a Send button that calls the Worker straight from the browser with the
 * key pasted at the top. Nothing here lists a route by hand.
 *
 * Values a route needs in its path (`agentId`, `sessionId`, …) are entered once and
 * shared by every route; the agent comes from the key, and a session, upload or server
 * just created is remembered for the routes that follow. Nothing outlives the page.
 */

type Vars = Record<string, string>;

const SPEC_FILE = "salt-agent-openapi.json";

const input =
  "bg-field placeholder:text-faint w-full rounded-lg px-3 py-2 font-mono text-[13px] outline-none focus:ring-2 focus:ring-accent/30";

export function ApiPlayground({ base }: { base: string }) {
  const [doc, setDoc] = useState<OpenApiDoc | null>(null);
  const [failed, setFailed] = useState("");
  const [key, setKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [vars, setVars] = useState<Vars>({});
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${base}/openapi.json`)
      .then((res) => res.json() as Promise<OpenApiDoc>)
      .then(setDoc)
      .catch(() => setFailed("Could not load the API description."));
  }, [base]);

  const groups = useMemo(() => (doc ? groupOperations(doc) : []), [doc]);
  const shown = useMemo(() => filtered(groups, filter), [groups, filter]);

  const setVar = (name: string, value: string) =>
    setVars((v) => ({ ...v, [name]: value }));

  if (failed) return <p className="text-muted text-sm">{failed}</p>;
  if (!doc) return <p className="text-muted text-sm">Loading the API…</p>;

  const count = groups.reduce((n, g) => n + g.operations.length, 0);

  function download() {
    const blob = new Blob([JSON.stringify(doc, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = SPEC_FILE;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="mt-6 space-y-8">
      <div className="border-hairline overflow-hidden rounded-2xl border">
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="min-w-0">
            <p className="text-[15px] font-semibold">
              {doc.info?.title ?? "API"}
              {doc.info?.version && (
                <span className="text-faint ml-2 font-mono text-xs font-normal">
                  v{doc.info.version}
                </span>
              )}
            </p>
            <p className="text-muted text-xs">
              {count} routes · OpenAPI 3 · Bearer auth
            </p>
          </div>
          <div className="flex gap-2">
            <CopyButton text={`${base}/openapi.json`} label="Copy spec URL" />
            <button
              onClick={download}
              className="bg-ink text-on-primary h-8 rounded-full px-4 text-xs font-semibold transition hover:opacity-85"
            >
              Download spec
            </button>
          </div>
        </div>

        <div className="border-hairline-soft bg-canvas-soft space-y-3 border-t px-4 py-4">
          <div>
            <Label>Base URL</Label>
            <div className="bg-canvas border-hairline flex items-center gap-2 rounded-lg border py-1 pr-1 pl-3">
              <code className="min-w-0 flex-1 truncate font-mono text-[13px]">
                {base}
              </code>
              <CopyButton text={base} />
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-[1fr_180px]">
            <label className="block">
              <Label>API key</Label>
              <div className="relative">
                <input
                  type={showKey ? "text" : "password"}
                  value={key}
                  onChange={(e) => {
                    const next = e.target.value
                      .replace(/^Bearer\s+/i, "")
                      .trim();
                    setKey(next);
                    if (agentOfKey(next)) setVar("agentId", agentOfKey(next));
                  }}
                  placeholder="salt_…"
                  autoComplete="off"
                  className={`${input} bg-white pr-14`}
                />
                <button
                  type="button"
                  onClick={() => setShowKey((s) => !s)}
                  className="text-muted hover:text-ink absolute top-1/2 right-2 -translate-y-1/2 text-xs font-semibold"
                >
                  {showKey ? "Hide" : "Show"}
                </button>
              </div>
            </label>
            <label className="block">
              <Label>Agent id</Label>
              <input
                value={vars.agentId ?? ""}
                onChange={(e) => setVar("agentId", e.target.value)}
                placeholder="from the key"
                className={input}
              />
            </label>
          </div>
          <p className="text-faint text-xs">
            Sent as{" "}
            <code className="font-mono">Authorization: Bearer &lt;key&gt;</code>
            . The key stays in this tab; copied snippets read it from{" "}
            <code className="font-mono">$SALT_API_KEY</code>.
          </p>
        </div>
      </div>

      <input
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Filter routes by path, method or name"
        className={input}
      />

      {shown.length === 0 && (
        <p className="text-muted text-sm">No route matches.</p>
      )}

      {shown.map((group) => (
        <section key={group.tag}>
          <h3 className="mb-2 flex items-baseline gap-2 text-[15px] font-semibold">
            {group.tag}
            <span className="text-faint text-xs font-normal">
              {group.operations.length}
            </span>
          </h3>
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

function filtered(groups: Group[], filter: string): Group[] {
  const q = filter.trim().toLowerCase();
  if (!q) return groups;
  return groups
    .map((g) => ({
      tag: g.tag,
      operations: g.operations.filter((op) =>
        `${g.tag} ${op.method} ${op.path} ${op.summary}`
          .toLowerCase()
          .includes(q),
      ),
    }))
    .filter((g) => g.operations.length > 0);
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
        className={`hover:bg-canvas-soft flex w-full items-center gap-3 px-4 py-3 text-left transition-colors ${
          open ? "bg-canvas-soft" : ""
        }`}
      >
        <MethodBadge method={op.method} />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-mono text-[13px]">
            <PathText path={op.path} />
          </span>
          <span className="text-muted block truncate text-xs">
            {op.summary}
          </span>
        </span>
        <span
          aria-hidden
          className={`text-faint text-[10px] transition-transform ${open ? "rotate-90" : ""}`}
        >
          ▶
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

  const ids = op.pathParams.filter((name) => name !== "agentId");

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
    <div className="border-hairline-soft space-y-6 border-t px-4 pt-4 pb-5">
      {op.description && (
        <p className="text-muted text-sm leading-relaxed">{op.description}</p>
      )}

      {op.fields.length > 0 && (
        <PanelSection title="Parameters">
          <FieldTable fields={op.fields} />
        </PanelSection>
      )}

      <PanelSection title="Try it">
        <div className="space-y-3">
          {ids.length + op.query.length > 0 && (
            <div className="grid gap-3 sm:grid-cols-2">
              {ids.map((name) => (
                <Input key={name} label={name} hint="Shared by every route.">
                  <input
                    value={vars[name] ?? ""}
                    onChange={(e) => setVar(name, e.target.value)}
                    className={input}
                  />
                </Input>
              ))}
              {op.query.map((q) => (
                <Input key={q.name} label={`?${q.name}`} hint={q.description}>
                  <input
                    value={query[q.name] ?? ""}
                    onChange={(e) =>
                      setQuery((v) => ({ ...v, [q.name]: e.target.value }))
                    }
                    className={input}
                  />
                </Input>
              ))}
            </div>
          )}
          {op.body === "json" && (
            <Input label="Body (JSON)">
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={Math.min(12, Math.max(3, body.split("\n").length))}
                spellCheck={false}
                className={`${input} resize-y leading-relaxed`}
              />
            </Input>
          )}
          {op.body === "file" && (
            <Input label="file">
              <input
                type="file"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                className="text-sm"
              />
            </Input>
          )}
          <div className="flex items-center gap-3">
            <button
              onClick={() => void send()}
              disabled={busy || !apiKey}
              className="bg-ink text-on-primary h-9 rounded-full px-5 text-sm font-semibold transition hover:opacity-85 disabled:opacity-40"
            >
              {busy ? "Sending…" : "Send request"}
            </button>
            {!apiKey && (
              <span className="text-faint text-xs">
                Paste an API key above first.
              </span>
            )}
          </div>
          {result && <ResultView result={result} />}
        </div>
      </PanelSection>

      <PanelSection title="Request">
        <SnippetView
          url={requestUrl(base, op, vars, query, true)}
          op={op}
          body={body}
        />
      </PanelSection>

      {op.responses.length > 0 && (
        <PanelSection title="Responses">
          <Responses replies={op.responses} />
        </PanelSection>
      )}
    </div>
  );
}

function PanelSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <p className="text-faint mb-2 text-[11px] font-semibold tracking-[0.08em] uppercase">
        {title}
      </p>
      {children}
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-muted mb-1 block text-xs font-semibold">
      {children}
    </span>
  );
}

function Input({
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
