#!/usr/bin/env node
// Interactive CLI dashboard for the salt-agent deployment.
//
// Six tabs, each a list of rows — a row either holds a value that `enter` edits, or
// is information only:
//
//   1 Overview   the deployment's counts
//   2 Users      every address, paged and searchable; `enter` opens one — its agent
//                limit (editable) and its agents with their session counts
//   3 Requests   the queue of accounts asking for a higher agent limit
//   4 Defaults   the values every agent starts out holding
//   5 Limits     every ceiling the deployment enforces
//   6 Payments   what key purchases need: the OpenRouter provisioning key bought keys
//                are made with (never shown back), the EVM and Solana addresses they
//                are paid to, and Reown's project id for the wallet modal — `enter`
//                sets one, `x` removes it
//
// The settings rows, the ranges the Worker refuses and the prose beside each row all
// come from `/api/admin/settings`, so a field added to the Worker's `settings.ts` shows
// up here with no edit at all. What this package does hold is `defaults.json`: the
// values a deployment starts from. The Worker ships none of its own and refuses to
// serve until every field is set, so these are the only defaults there are.
//
// Two non-interactive commands, for scripts and the deploy preflight:
//
//   node index.mjs init    write the shipped default for every field not yet set
//   node index.mjs check   exit 1, naming them, if any field is not set; exit 2 if the
//                          live Worker predates settings (the one-time bootstrap)
//
// Both take `--dev` / `--staging` like the dashboard.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));

/** The values a fresh deployment starts from. The Worker has no others. */
const DEFAULTS = JSON.parse(readFileSync(path.join(here, "defaults.json"), "utf8"));

/** Pull `KEY=VALUE` lines out of a dotenv-style file. Missing file is not an error. */
function readEnvFile(file) {
  try {
    const out = {};
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m) continue;
      out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
    }
    return out;
  } catch {
    return {};
  }
}

// The real process environment wins, then this package's own `.env`, then the
// Worker's `.dev.vars` — which is where the local secret already lives, so a
// checkout needs no extra setup to talk to a `wrangler dev` on this machine.
const fileEnv = {
  ...readEnvFile(path.join(here, "..", "agent", ".dev.vars")),
  ...readEnvFile(path.join(here, ".env")),
};
const conf = (key) => process.env[key] ?? fileEnv[key];

// `--dev` and `--staging` each swap every lookup to that deployment's twin: a
// different Worker, and usually a different secret with it. No flag means production.
const argv = process.argv.slice(2);
/** `init`, `check`, or undefined for the dashboard. */
const COMMAND = argv.find((a) => !a.startsWith("-"));
const TARGET = argv.some((a) => a === "--dev" || a === "-d")
  ? "DEV"
  : argv.some((a) => a === "--staging" || a === "-s")
    ? "STAGING"
    : "";
const pick = (key) =>
  TARGET ? conf(`${key}_${TARGET}`) ?? conf(`${TARGET}_${key}`) : conf(key);

const BASE_URL = (pick("AGENT_URL") ?? "").replace(/\/+$/, "");
const API_SECRET = pick("API_SECRET");

if (!BASE_URL) {
  console.error(
    `No ${TARGET ? `AGENT_URL_${TARGET}` : "AGENT_URL"} set. Put it in admin-cli/.env (see .env.example) or in the environment.`
  );
  process.exit(1);
}
if (!API_SECRET) {
  console.error(
    `No ${TARGET ? `API_SECRET_${TARGET}` : "API_SECRET"} found. Put it in admin-cli/.env, or run from a checkout with agent/.dev.vars present.`
  );
  process.exit(1);
}

/**
 * A call against the deployment, with the owner's secret attached. A refusal throws
 * with the Worker's own `error` line as its message, which is what the status bar shows.
 */
async function call(pathname, init = {}) {
  const res = await fetch(`${BASE_URL}${pathname}`, {
    ...init,
    headers: { "x-api-secret": API_SECRET, ...(init.headers ?? {}) },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    let reason = body;
    try {
      reason = JSON.parse(body).error ?? body;
    } catch {}
    const err = new Error(reason || `${res.status} ${res.statusText}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/**
 * What the stored document is missing, from the Worker's answer.
 *
 * A Worker from before every setting was required answers with `overrides` — what it
 * was told — and fills the rest from its own constants. Against one of those, the
 * missing fields are worked out here, so `init` can write them before the upgrade
 * lands and the new Worker comes up complete.
 */
function missingOf(doc) {
  if (Array.isArray(doc.missing)) return doc.missing;
  const stored = doc.overrides ?? {};
  const out = [];
  for (const { key } of doc.fields ?? []) {
    if (stored[key] === undefined) {
      out.push(key);
    } else if (key === "max_upload_bytes" || key === "config_defaults") {
      for (const sub of Object.keys(DEFAULTS[key] ?? {})) {
        if (stored[key][sub] === undefined) out.push(`${key}.${sub}`);
      }
    }
  }
  return out;
}

/** Merge a patch into the stored document. Returns the Worker's answer. */
async function patchSettings(patch) {
  return await call("/api/admin/settings", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
}

/**
 * The shipped default for every field the Worker says is missing, as one patch.
 *
 * Driven by the Worker's own `missing` list rather than by diffing against
 * `defaults.json`, so a field this Worker does not know yet is never sent — it would
 * be refused as unknown. Nested gaps (`max_upload_bytes.audio`) fill only that key.
 */
function defaultsFor(missing) {
  const patch = {};
  for (const entry of missing) {
    const [key, sub] = entry.split(".");
    if (!(key in DEFAULTS)) continue;
    if (sub === undefined) patch[key] = DEFAULTS[key];
    else if (DEFAULTS[key]?.[sub] !== undefined) {
      patch[key] = { ...(patch[key] ?? {}), [sub]: DEFAULTS[key][sub] };
    }
  }
  return patch;
}

/** How a value is shown on a row, and what `enter` starts editing. */
function showValue(value) {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return JSON.stringify(value);
}

/**
 * Read a typed value back for its field.
 *
 * An empty line on a string field is a real empty string — a blank `system_prompt`
 * is the owner choosing to say nothing — so it is not treated as a cancel.
 * Anything the Worker will not take comes back as its own error message, which is the
 * only validation this CLI needs to know about.
 */
function parseValue(name, kind, text) {
  const raw = text.trim();
  if (kind === "int" || kind === "number") {
    const n = Number(raw);
    if (!raw || !Number.isFinite(n)) throw new Error(`${name} wants a number`);
    return n;
  }
  // A model menu: `id = label` pairs, comma-separated. A bare id is its own label.
  if (kind === "menu") {
    return raw
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => {
        const at = item.indexOf("=");
        if (at < 0) return { id: item, label: item };
        return { id: item.slice(0, at).trim(), label: item.slice(at + 1).trim() };
      });
  }
  if (kind === "json") {
    try {
      return JSON.parse(raw);
    } catch {
      throw new Error(`${name} wants JSON`);
    }
  }
  return text;
}

/* ------------------------------------------------------------------ dashboard */

const PAGE = 20;
const TABS = ["Overview", "Users", "Requests", "Defaults", "Limits", "Payments"];
/**
 * The settings that are objects, each merged key by key on the Worker — so each key
 * gets a row of its own rather than one row of JSON.
 */
const NESTED = ["max_upload_bytes", "config_defaults", "field_options"];

/** A list the Worker serves a page at a time. */
const pager = (pathname, key) => ({
  pathname,
  key,
  rows: [],
  cursor: "",
  hasMore: true,
  loading: false,
  /** Bumped on every reset, so a page still in flight for the old list is dropped. */
  gen: 0,
  query: "",
  sel: 0,
  top: 0,
});

const state = {
  tab: 0,
  counts: null,
  /** The stored settings document, the fields it is still missing, and the field list. */
  settings: null,
  missing: [],
  fields: [],
  users: pager("/api/admin/users", "users"),
  requests: pager("/api/admin/business-requests", "requests"),
  /**
   * The payment settings: `{ evm, solana, reown_project_id, rpc: { [network]: host },
   * provisioning_key: { set, hint } }`; null until read, or when the Worker predates them.
   */
  payments: null,
  /** The user opened from the Users tab, or null while the list is showing. */
  user: null,
  /** Selection and scroll for the tabs that are not paged lists. */
  pos: {
    0: { sel: 0, top: 0 },
    3: { sel: 0, top: 0 },
    4: { sel: 0, top: 0 },
    5: { sel: 0, top: 0 },
  },
  /** Non-null while a value is being typed: `{ label, buffer, submit(text) }`. */
  edit: null,
  /** Non-null while a y/n is pending: `{ prompt, run() }`. */
  confirm: null,
  status: "",
};

async function loadCounts() {
  try {
    state.counts = await call("/api/admin/stats");
  } catch (err) {
    state.status = `could not load counts — ${err.message}`;
  }
  render();
}

async function loadSettings() {
  try {
    const doc = await call("/api/admin/settings");
    state.settings = doc.settings;
    state.missing = missingOf(doc);
    state.fields = doc.fields ?? [];
  } catch (err) {
    state.status = `could not load settings — ${err.message}`;
  }
  render();
}

async function loadPayments() {
  try {
    state.payments = await call("/api/admin/payments");
  } catch (err) {
    // A Worker from before key purchases has no such route: the tab says so.
    state.payments = null;
    if (err.status !== 401 && err.status !== 404) state.status = `could not read the payment settings — ${err.message}`;
  }
  render();
}

/** The payment settings the tab edits, besides the provisioning key. */
const PAYMENT_FIELDS = [
  { key: "evm", label: "EVM pay address", off: "EVM payments are closed" },
  { key: "solana", label: "Solana pay address", off: "Solana payments are closed" },
  { key: "reown_project_id", label: "Reown project id", off: "the wallet modal can't open" },
];

/** A network's RPC URL, edited like the other payment settings. */
const rpcField = (network) => ({
  key: `rpc:${network}`,
  label: `${network} RPC URL`,
  off: `${network} uses the configured RPC`,
  body: (value) => ({ rpc: { [network]: value } }),
});

/** Set one payment setting; the Worker checks it is the right shape. */
async function setPayment(field, text) {
  const value = text.trim();
  if (!value || value === state.payments?.[field.key]) {
    state.status = "nothing changed";
    return render();
  }
  state.payments = await call("/api/admin/payments", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(field.body ? field.body(value) : { [field.key]: value }),
  });
  state.status = `${field.label} set`;
  render();
}

function removePayment(field) {
  state.confirm = {
    prompt: `Remove the ${field.label}? Until one is set, ${field.off}.`,
    run: async () => {
      try {
        state.payments = await call("/api/admin/payments", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(field.body ? field.body("") : { [field.key]: "" }),
        });
        state.status = `${field.label} removed — ${field.off}`;
      } catch (err) {
        state.status = err.message;
      }
      render();
    },
  };
  render();
}

/** Set the provisioning key: the Worker checks it with OpenRouter before keeping it. */
async function setProvisioningKey(text) {
  const key = text.trim();
  if (!key) {
    state.status = "nothing changed";
    return render();
  }
  state.status = "checking with OpenRouter…";
  render();
  const shown = await call("/api/admin/provisioning-key", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key }),
  });
  state.payments = { ...state.payments, provisioning_key: shown };
  state.status = "provisioning key set";
  render();
}

function removeProvisioningKey() {
  state.confirm = {
    prompt: "Remove the provisioning key? Key purchases close until one is set.",
    run: async () => {
      try {
        const shown = await call("/api/admin/provisioning-key", { method: "DELETE" });
        state.payments = { ...state.payments, provisioning_key: shown };
        state.status = "provisioning key removed — key purchases are closed";
      } catch (err) {
        state.status = err.message;
      }
      render();
    },
  };
  render();
}

/** Fetch the next page, appending it. Called on startup and as the cursor nears the end. */
async function loadMore(p) {
  if (p.loading || !p.hasMore) return;
  const gen = p.gen;
  p.loading = true;
  render();
  const params = new URLSearchParams({ limit: String(PAGE) });
  if (p.cursor) params.set("cursor", p.cursor);
  if (p.query) params.set("q", p.query);
  try {
    const page = await call(`${p.pathname}?${params}`);
    if (gen !== p.gen) return;
    p.rows.push(...page[p.key]);
    p.cursor = page.cursor;
    p.hasMore = page.has_more;
  } catch (err) {
    if (gen !== p.gen) return;
    state.status = `could not load ${p.key} — ${err.message}`;
    p.hasMore = false;
  }
  p.loading = false;
  render();
}

function resetPager(p) {
  Object.assign(p, { rows: [], cursor: "", hasMore: true, loading: false, sel: 0, top: 0 });
  p.gen++;
}

/** Send a settings patch and show what came back. */
async function saveSettings(patch, done) {
  state.status = "saving…";
  render();
  try {
    const doc = await patchSettings(patch);
    state.settings = doc.settings;
    state.missing = missingOf(doc);
    state.status = done;
  } catch (err) {
    state.status = err.message;
  }
  render();
}

async function fillUnset() {
  const patch = defaultsFor(state.missing);
  if (!Object.keys(patch).length) {
    state.status = `no shipped value for: ${state.missing.join(", ")}`;
    return render();
  }
  await saveSettings(patch, "unset settings filled with the shipped values");
  await loadCounts();
}

/** Open a line editor on the status bar, starting from the value in force. */
function startEdit(label, value, submit, secret = false) {
  state.edit = { label, buffer: value, submit, secret };
  state.status = "";
  render();
}

async function openUser(email) {
  state.status = "loading…";
  render();
  try {
    const detail = await call(`/api/admin/users/${encodeURIComponent(email)}`);
    state.user = { ...detail, sel: 0, top: 0 };
    state.status = "";
  } catch (err) {
    state.status = err.message;
  }
  render();
}

async function setAgentLimit(email, text) {
  const agent_limit = parseValue("agent limit", "int", text);
  const res = await call("/api/admin/business-account", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, agent_limit }),
  });
  if (state.user?.email === res.email) state.user.agent_limit = res.agent_limit;
  state.status = `${res.email} may now administer ${res.agent_limit} agent${res.agent_limit === 1 ? "" : "s"}`;
  render();
}

/** Approve or reject one request, once confirmed; either way it leaves the queue. */
function resolveRequest(r, approve) {
  state.confirm = {
    prompt: `${approve ? "Approve" : "Reject"} ${r.email} +${r.requested_increase}?`,
    run: async () => {
      state.status = approve ? "approving…" : "rejecting…";
      render();
      try {
        if (approve) {
          const res = await call(`/api/admin/business-requests/${r.id}/approve`, { method: "POST" });
          state.status = `approved — ${res.email} now has a limit of ${res.agent_limit}`;
        } else {
          await call(`/api/admin/business-requests/${r.id}`, { method: "DELETE" });
          state.status = `rejected ${r.email}`;
        }
        const p = state.requests;
        p.rows = p.rows.filter((row) => row.id !== r.id);
        p.sel = Math.max(0, Math.min(p.sel, p.rows.length - 1));
      } catch (err) {
        state.status = err.message;
      }
      await loadCounts();
    },
  };
  state.status = "";
  render();
}

/* ------------------------------------------------------------------ views */

const fmtDate = (ms) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");

/** Which tab a settings field sits on. A Worker older than `group` gets it guessed. */
const groupOf = (field) =>
  field.group ?? (field.kind === "int" || field.key === "max_upload_bytes" ? "limit" : "default");

/**
 * An MCP template's icon is a long data URL, so the catalogue row shows `"@keep"` in
 * its place — and on save `"@keep"` puts the stored icon back, while `"@path.svg"`
 * reads that file from disk, which is how an icon is uploaded.
 */
const keepIcons = (entry) => (entry?.icon ? { ...entry, icon: "@keep" } : entry);

function loadIcons(catalog, stored) {
  if (!Array.isArray(catalog)) return catalog;
  return catalog.map((entry) => {
    const ref = entry?.icon;
    if (typeof ref !== "string" || !ref.startsWith("@")) return entry;
    if (ref === "@keep") {
      const kept = stored.find((s) => s.id === entry.id)?.icon;
      if (!kept) throw new Error(`${entry.id} has no stored icon to keep`);
      return { ...entry, icon: kept };
    }
    const file = path.resolve(ref.slice(1));
    try {
      return { ...entry, icon: readFileSync(file, "utf8") };
    } catch {
      throw new Error(`could not read ${file}`);
    }
  });
}

/** One row per setting — one per key for the nested ones. */
function settingRows(group) {
  const rows = [];
  for (const field of state.fields.filter((f) => groupOf(f) === group)) {
    if (NESTED.includes(field.key)) {
      const keys = new Set([
        ...Object.keys(DEFAULTS[field.key] ?? {}),
        ...Object.keys(state.settings?.[field.key] ?? {}),
      ]);
      for (const sub of keys) rows.push(settingRow(field, sub));
    } else {
      rows.push(settingRow(field));
    }
  }
  return rows;
}

function settingRow(field, sub) {
  const name = sub ? `${field.key}.${sub}` : field.key;
  const value = sub ? state.settings?.[field.key]?.[sub] : state.settings?.[field.key];
  const shipped = sub ? DEFAULTS[field.key]?.[sub] : DEFAULTS[field.key];
  // A nested key is typed like the value it replaces: a number stays a number, and a
  // model menu is edited as `id = label` pairs.
  const sample = value ?? shipped;
  const kind = !sub
    ? field.kind
    : Array.isArray(sample)
      ? "menu"
      : typeof sample === "number"
        ? "number"
        : "string";
  const pairs = (v) => v.map((o) => (o.label && o.label !== o.id ? `${o.id} = ${o.label}` : o.id)).join(", ");
  const show = (v) =>
    kind === "menu" && Array.isArray(v)
      ? pairs(v)
      : field.key === "mcp_catalog" && Array.isArray(v)
        ? showValue(v.map(keepIcons))
        : showValue(v);
  const wrap = (v) => (sub ? { [field.key]: { [sub]: v } } : { [field.key]: v });
  const range = field.min !== undefined ? ` (${field.min}–${field.max})` : "";
  return {
    cells: [name, kind === "menu" && Array.isArray(value) ? value.map((o) => o.label ?? o).join(", ") : show(value)],
    unset: state.missing.some((m) => m === name || m === field.key || m.startsWith(`${name}.`)),
    note: `${field.doc}${range}${shipped === undefined ? "" : `  ·  shipped: ${show(shipped)}`}`,
    enter: () =>
      startEdit(name, show(value), (text) =>
        saveSettings(
          wrap(
            field.key === "mcp_catalog"
              ? loadIcons(parseValue(name, kind, text), value ?? [])
              : parseValue(name, kind, text)
          ),
          `${name} saved`
        )
      ),
    reset:
      shipped === undefined ? undefined : () => saveSettings(wrap(shipped), `${name} set to the shipped value`),
  };
}

/**
 * What the current tab shows: its columns, its rows, where the selection is, and the
 * keys it answers to beyond moving and `enter`.
 */
function view() {
  switch (state.tab) {
    case 0: {
      const c = state.counts;
      const rows = c
        ? [
            ["users", c.users],
            ["agents", c.agents],
            ["sessions", c.sessions],
            ["business accounts", c.business_accounts],
            ["open limit requests", c.open_requests],
          ].map(([k, v]) => ({ cells: [k, String(v ?? "—")] }))
        : [];
      if (c && state.settings) {
        rows.push({
          cells: [
            "settings",
            state.missing.length
              ? `${state.missing.length} unset — the deployment is refusing requests`
              : "complete",
          ],
          unset: state.missing.length > 0,
        });
      }
      return {
        columns: [["", 22], ["", 0]],
        rows,
        pos: state.pos[0],
        empty: "loading…",
      };
    }

    case 1: {
      const u = state.user;
      if (u) {
        return {
          title: u.email,
          columns: [["", 30], ["", 8], ["", 0]],
          rows: [
            {
              cells: ["agent limit", String(u.agent_limit), ""],
              enter: () => startEdit("agent limit", String(u.agent_limit), (t) => setAgentLimit(u.email, t)),
            },
            ...u.agents.map((a) => ({
              cells: [a.name, a.role, `${a.sessions} session${a.sessions === 1 ? "" : "s"}`],
            })),
          ],
          pos: u,
          hint: "enter edit limit   esc back",
          keys: {
            "\x1b": () => {
              state.user = null;
              state.status = "";
              render();
            },
          },
        };
      }
      const p = state.users;
      return {
        title: p.query ? `search: ${p.query}` : "",
        columns: [["email", 44], ["agents", 0]],
        rows: p.rows.map((r) => ({ cells: [r.email, String(r.agents)], enter: () => openUser(r.email) })),
        pos: p,
        pager: p,
        empty: p.loading ? "loading…" : p.query ? "no match." : "no users.",
        hint: `enter open   / search${p.query ? "   esc clear search" : ""}`,
        keys: {
          "/": () =>
            startEdit("search", p.query, async (text) => {
              p.query = text.trim();
              resetPager(p);
              await loadMore(p);
            }),
          "\x1b": async () => {
            if (!p.query) return;
            p.query = "";
            resetPager(p);
            await loadMore(p);
          },
        },
      };
    }

    case 2: {
      const p = state.requests;
      return {
        columns: [["email", 34], ["agents", 8], ["limit", 12], ["filed", 0]],
        rows: p.rows.map((r) => ({
          cells: [
            r.email,
            String(r.current_agents),
            `${r.current_limit} → ${r.current_limit + r.requested_increase}`,
            fmtDate(r.created_at),
          ],
          request: r,
        })),
        pos: p,
        pager: p,
        empty: p.loading ? "loading…" : "none open.",
        hint: "a approve   x reject",
        keys: {
          a: (row) => row && resolveRequest(row.request, true),
          x: (row) => row && resolveRequest(row.request, false),
        },
      };
    }

    case 5: {
      const pay = state.payments;
      const rows = [];
      if (pay) {
        const key = pay.provisioning_key ?? { set: false, hint: "" };
        rows.push({
          cells: ["provisioning key", key.set ? `set (…${key.hint})` : "not set — key purchases are closed"],
          unset: !key.set,
          enter: () => startEdit("OpenRouter provisioning key", "", setProvisioningKey, true),
          remove: key.set ? removeProvisioningKey : undefined,
        });
        for (const field of PAYMENT_FIELDS) {
          rows.push({
            cells: [field.label, pay[field.key] || `not set — ${field.off}`],
            unset: !pay[field.key],
            enter: () => startEdit(field.label, pay[field.key] ?? "", (t) => setPayment(field, t)),
            remove: pay[field.key] ? () => removePayment(field) : undefined,
          });
        }
        // Write-only: the Worker shows only the host, as the URL may carry an API key.
        for (const [network, host] of Object.entries(pay.rpc ?? {})) {
          const field = rpcField(network);
          rows.push({
            cells: [field.label, host ? `set (${host})` : "configured — the free public endpoint"],
            enter: () => startEdit(field.label, "", (t) => setPayment(field, t), true),
            remove: host ? () => removePayment(field) : undefined,
          });
        }
      }
      return {
        columns: [["", 22], ["", 0]],
        rows,
        pos: state.pos[5],
        empty: "the deployment predates payment settings, or they could not be read.",
        hint: "enter set   x remove",
        keys: { x: (row) => row?.remove?.() },
      };
    }

    default: {
      const group = state.tab === 3 ? "default" : "limit";
      return {
        columns: [["setting", 36], ["value", 0]],
        rows: settingRows(group),
        pos: state.pos[state.tab],
        empty: state.fields.length ? "none." : "loading…",
        showNote: true,
        hint: "enter edit   d shipped value",
        keys: { d: (row) => row?.reset?.() },
      };
    }
  }
}

/* ------------------------------------------------------------------ drawing */

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const INV = "\x1b[7m";
const OFF = "\x1b[0m";

const pad = (s, n) => (s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s.padEnd(n));

/** One row's text, full width, columns padded; the last column takes what is left. */
function rowText(cells, columns, width) {
  let text = "";
  columns.forEach(([, w], i) => {
    text += w ? `${pad(cells[i] ?? "", w)} ` : (cells[i] ?? "");
  });
  return pad(text, width);
}

function render() {
  const width = Math.max(40, (process.stdout.columns ?? 80) - 1);
  const size = Math.max(3, (process.stdout.rows ?? 24) - 11);
  const v = view();
  const out = [];

  out.push(`${BOLD}salt-agent${OFF} ${DIM}${TARGET ? TARGET.toLowerCase() : "production"} · ${BASE_URL}${OFF}`);
  out.push("");
  const unsetIn = (group) =>
    state.fields.some(
      (f) => groupOf(f) === group && state.missing.some((m) => m === f.key || m.startsWith(`${f.key}.`))
    );
  out.push(
    TABS.map((name, i) => {
      let label = ` ${i + 1} ${name}`;
      if (i === 2 && state.counts?.open_requests) label += ` (${state.counts.open_requests})`;
      if ((i === 3 && unsetIn("default")) || (i === 4 && unsetIn("limit"))) label += " !";
      label += " ";
      return i === state.tab ? `${INV}${BOLD}${label}${OFF}` : label;
    }).join(" ")
  );
  out.push(`${DIM}${"─".repeat(width)}${OFF}`);

  if (v.title) out.push(`${BOLD}  ${v.title}${OFF}`);
  if (v.columns.some(([t]) => t)) {
    out.push(`${DIM}  ${rowText(v.columns.map(([t]) => t), v.columns, width - 2)}${OFF}`);
  }

  const pos = v.pos;
  pos.sel = Math.max(0, Math.min(pos.sel, v.rows.length - 1));
  if (!v.rows.length) {
    out.push(`${DIM}  ${v.empty ?? ""}${OFF}`);
  } else {
    // The window follows the selection only when it would otherwise fall off an
    // edge, so the list scrolls a row at a time instead of jumping a page.
    if (pos.sel < pos.top) pos.top = pos.sel;
    if (pos.sel > pos.top + size - 1) pos.top = pos.sel - size + 1;
    pos.top = Math.max(0, Math.min(pos.top, Math.max(0, v.rows.length - size)));
    v.rows.slice(pos.top, pos.top + size).forEach((row, i) => {
      const text = `${row.unset ? "!" : " "} ${rowText(row.cells, v.columns, width - 2)}`;
      out.push(pos.top + i === pos.sel ? `${INV}${text}${OFF}` : text);
    });
    if (v.pager?.loading) out.push(`${DIM}  loading more…${OFF}`);
    else if (v.pager?.hasMore || pos.top + size < v.rows.length) out.push(`${DIM}  ↓ more${OFF}`);
  }

  out.push(`${DIM}${"─".repeat(width)}${OFF}`);
  if (state.edit) {
    // The cursor is drawn rather than moved: the screen is repainted whole on every
    // keypress, so a real cursor position would be lost on the next paint.
    const typed = state.edit.secret ? "•".repeat(state.edit.buffer.length) : state.edit.buffer;
    out.push(`  ${BOLD}${state.edit.label}${OFF} ${typed}${INV} ${OFF}`);
    out.push(`${DIM}  enter save   esc cancel${OFF}`);
  } else if (state.confirm) {
    out.push(`  ${BOLD}${state.confirm.prompt}${OFF}`);
    out.push(`${DIM}  y confirm   any other key cancel${OFF}`);
  } else {
    const selected = v.rows[pos.sel];
    if (v.showNote && selected?.note) out.push(`${DIM}  ${pad(selected.note, width - 2)}${OFF}`);
    const hints = [
      "↑/↓ move",
      v.hint,
      state.missing.length ? "i fill unset" : "",
      "←/→ tab",
      "q quit",
    ].filter(Boolean);
    out.push(`${DIM}  ${hints.join("   ")}${OFF}`);
  }
  if (state.status) out.push(`  ${state.status}`);

  process.stdout.write(`\x1b[2J\x1b[H${out.join("\n")}\n`);
}

/* ------------------------------------------------------------------ keys */

/**
 * Split one read into individual keypresses. A terminal usually delivers one at a
 * time, but not always — an arrow key is three bytes, and a held key or a paste can
 * arrive as one chunk — so escape sequences are kept whole and everything else is
 * one character.
 */
function keys(chunk) {
  const out = [];
  for (let i = 0; i < chunk.length; ) {
    if (chunk[i] === "\x1b" && chunk[i + 1] === "[") {
      let j = i + 2;
      while (j < chunk.length && !/[A-Za-z~]/.test(chunk[j])) j++;
      out.push(chunk.slice(i, j + 1));
      i = j + 1;
    } else {
      out.push(chunk[i]);
      i++;
    }
  }
  return out;
}

/**
 * The line editor. Deliberately minimal — printable characters, backspace, enter,
 * esc — because every value here is short and the one that is not (a JSON list) is
 * pasted rather than typed, and a paste arrives as a run of printable characters.
 */
async function onEditKey(key) {
  const edit = state.edit;
  if (key === "\x1b") {
    state.edit = null;
    return render();
  }
  if (key === "\r" || key === "\n") {
    state.edit = null;
    try {
      await edit.submit(edit.buffer);
    } catch (err) {
      state.status = err.message;
      render();
    }
    return;
  }
  if (key === "\x7f" || key === "\b") edit.buffer = edit.buffer.slice(0, -1);
  // Escape sequences (arrows, function keys) are not text; everything else is.
  else if (key.length === 1 && key >= " ") edit.buffer += key;
  render();
}

async function switchTab(tab) {
  state.tab = (tab + TABS.length) % TABS.length;
  state.status = "";
  render();
  if (state.tab === 0) await loadCounts();
}

function quit() {
  process.stdout.write("\x1b[2J\x1b[H\x1b[?25h");
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.exit(0);
}

async function onKey(key) {
  if (key === "\u0003") quit();
  if (state.edit) return await onEditKey(key);
  if (state.confirm) {
    const { run } = state.confirm;
    state.confirm = null;
    if (key === "y" || key === "Y") return await run();
    state.status = "cancelled";
    return render();
  }
  if (key === "q") quit();

  if (key >= "1" && key <= String(TABS.length)) return await switchTab(Number(key) - 1);
  if (key === "\x1b[C" || key === "\t" || key === "l") return await switchTab(state.tab + 1);
  if (key === "\x1b[D" || key === "\x1b[Z" || key === "h") return await switchTab(state.tab - 1);
  if (key === "i" && state.missing.length) return await fillUnset();

  const v = view();
  const row = v.rows[v.pos.sel];
  if (key === "\x1b[A" || key === "k") v.pos.sel = Math.max(0, v.pos.sel - 1);
  else if (key === "\x1b[B" || key === "j") v.pos.sel = Math.max(0, Math.min(v.rows.length - 1, v.pos.sel + 1));
  else if ((key === "\r" || key === "\n") && row?.enter) {
    state.status = "";
    return await row.enter();
  } else if (v.keys?.[key]) return await v.keys[key](row);
  render();
  // Fetch ahead of the cursor rather than at the very last row, so the list keeps
  // moving while the next page is in flight.
  if (v.pager && v.pos.sel >= v.rows.length - 5) await loadMore(v.pager);
}

/* ------------------------------------------------------------------ commands */

if (COMMAND === "init" || COMMAND === "check") {
  const where = `${BASE_URL}${TARGET ? ` [${TARGET.toLowerCase()}]` : ""}`;
  try {
    let doc = await call("/api/admin/settings");
    if (COMMAND === "init") {
      const patch = defaultsFor(missingOf(doc));
      if (Object.keys(patch).length) {
        doc = await patchSettings(patch);
        console.log(`  filled with shipped defaults: ${Object.keys(patch).join(", ")}`);
      }
    }
    const missing = missingOf(doc);
    if (missing.length) {
      console.error(
        `\n  ${where}: settings incomplete — the deployment refuses requests until these are set:\n\n` +
          missing.map((m) => `    ${m}`).join("\n") +
          `\n\n  Run \`npm run init${TARGET ? ` -- --${TARGET.toLowerCase()}` : ""}\` in admin-cli to write the shipped defaults,\n  or set them from the dashboard's Defaults and Limits tabs.\n`
      );
      process.exit(1);
    }
    // Fields this CLI ships a default for that the live Worker has not heard of: a
    // release adding a setting. They cannot be set before that release is live — the
    // current Worker refuses unknown keys — so `npm run deploy` runs `init` after it.
    const known = new Set((doc.fields ?? []).map((f) => f.key));
    const upcoming = Object.keys(DEFAULTS).filter((k) => !known.has(k));
    console.log(`  settings complete (${where})`);
    if (upcoming.length) {
      console.log(
        `  not on the live Worker yet: ${upcoming.join(", ")} — the deploy's \`init\` step sets them.`
      );
    }
    process.exit(0);
  } catch (err) {
    // A Worker from before the settings route: the route is unknown to it, so the
    // request falls through to its identity gate (401) or nowhere (404). Told apart
    // from a wrong secret by `/stats`, which the same secret opens on both versions.
    // `check` says so with its own exit code — the deploy that installs the route is
    // the only way to get one, so the preflight lets it through and `init` follows it.
    if (COMMAND === "check" && (err.status === 401 || err.status === 404)) {
      const predates = await call("/api/admin/stats").then(
        () => true,
        () => false
      );
      if (predates) {
        console.log(
          `  ${where} predates deployment settings — nothing to check yet.\n` +
            "  The deploy installs the route; `init` right after it writes the shipped defaults."
        );
        process.exit(2);
      }
    }
    console.error(`  could not read settings from ${where}: ${err.message}`);
    process.exit(1);
  }
}

process.stdout.write("\x1b[?25l");
render();

try {
  state.counts = await call("/api/admin/stats");
} catch (err) {
  process.stdout.write("\x1b[?25h");
  console.error(`Could not reach ${BASE_URL}: ${err.message}`);
  process.exit(1);
}

if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.setEncoding("utf8");
process.stdin.on("data", async (chunk) => {
  for (const key of keys(chunk)) await onKey(key);
});
process.stdout.on("resize", render);
process.on("SIGINT", quit);

await Promise.all([
  loadSettings(),
  loadPayments(),
  loadMore(state.users),
  loadMore(state.requests),
]);
// A deployment with settings unset refuses every ordinary request, so say so first.
if (state.missing.length) {
  state.status = "settings incomplete — press i to fill every unset row with the shipped value";
  render();
}
