import { env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_CONFIG,
  sessionIdForChat,
  sessionLimitMessage,
  thisMonth,
} from "../src/registry";
import { SHIPPED } from "./shipped";

const SEED = SHIPPED.config_defaults;
const MAX_AGENT_BYTES = SHIPPED.max_agent_bytes;
const MAX_SESSIONS = SHIPPED.max_sessions;

/**
 * `SessionRegistry` — one agent's own object: its settings, its access list, its
 * session index, what it has spent and what it is storing.
 *
 * Every test gets a fresh registry, so these are statements about behaviour from an
 * empty database rather than about whatever a previous test left behind.
 */

function registry() {
  return env.SessionRegistry.get(env.SessionRegistry.idFromName(crypto.randomUUID()));
}

/**
 * Block until `Date.now()` moves on.
 *
 * Sessions are ordered by `updated_at DESC, id ASC`, so two created inside the same
 * millisecond tie and fall back to the id — which makes any test that asserts "newest
 * first" pass or fail on how fast the machine is. Waiting for the clock to tick makes
 * the ordering a property of the data rather than of the hardware.
 */
function nextMs() {
  const start = Date.now();
  while (Date.now() === start) {
    /* spin; a millisecond at most */
  }
}

let reg: ReturnType<typeof registry>;
beforeEach(() => {
  reg = registry();
});

describe("config", () => {
  it("seeds from the Worker's default model on first read", async () => {
    const config = await reg.config("vendor/default", SEED);
    expect(config.model).toBe("vendor/default");
    expect(config.temperature).toBe(SEED.temperature);
  });

  it("keeps the seeded row rather than re-seeding on later reads", async () => {
    await reg.config("vendor/first", SEED);
    // The default changing in wrangler.jsonc must not silently re-point an agent
    // somebody has already configured.
    expect((await reg.config("vendor/second", SEED)).model).toBe("vendor/first");
  });

  it("applies a partial patch and leaves everything else alone", async () => {
    await reg.config("vendor/default", SEED);
    const patched = await reg.setConfig({ temperature: 0.1 }, "vendor/default", SEED);
    expect(patched.temperature).toBe(0.1);
    expect(patched.model).toBe("vendor/default");
    expect(patched.system_prompt).toBe(DEFAULT_CONFIG.system_prompt);
  });

  it("persists a patch across reads", async () => {
    await reg.setConfig({ agent_name: "Ada" }, "vendor/default", SEED);
    expect((await reg.config("vendor/default", SEED)).agent_name).toBe("Ada");
  });

  it("round-trips every capability flag", async () => {
    await reg.setConfig({ cap_web_search: 1, cap_memory: 1 }, "vendor/default", SEED);
    const config = await reg.config("vendor/default", SEED);
    expect(config.cap_web_search).toBe(1);
    expect(config.cap_memory).toBe(1);
    expect(config.cap_vision).toBe(0);
  });
});

describe("access", () => {
  it("reports an unwritten agent as unseeded rather than as empty", async () => {
    const access = await reg.access();
    // The distinction the Worker depends on: unseeded means "ask the directory",
    // and reading it as an empty list would lock every pre-existing agent out.
    expect(access.seeded).toBe(0);
    expect(access.allowed_emails).toBe("");
  });

  it("marks the agent seeded once access is written", async () => {
    await reg.setAccess({ allowed_emails: "a@x.com", admin_email: "a@x.com" });
    expect((await reg.access()).seeded).toBe(1);
  });

  it("sets the admin once and never moves it", async () => {
    await reg.setAccess({ allowed_emails: "a@x.com", admin_email: "a@x.com" });
    await reg.setAccess({ allowed_emails: "b@x.com", admin_email: "attacker@x.com" });
    const access = await reg.access();
    // An agent whose administrator can be handed over is one that can be taken.
    expect(access.admin_email).toBe("a@x.com");
    expect(access.allowed_emails).toBe("b@x.com");
  });

  it("lowercases the admin on the way in", async () => {
    await reg.setAccess({ allowed_emails: "", admin_email: "  Admin@X.COM " });
    expect((await reg.access()).admin_email).toBe("admin@x.com");
  });

  it("keeps the current list when a patch omits it", async () => {
    await reg.setAccess({ allowed_emails: "a@x.com", admin_email: "a@x.com" });
    await reg.setAccess({ admin_email: "a@x.com" });
    expect((await reg.access()).allowed_emails).toBe("a@x.com");
  });

  it("seeds an unseeded agent from the directory's copy", async () => {
    const seeded = await reg.seedAccess("old@x.com", "old@x.com");
    expect(seeded).toEqual({
      allowed_emails: "old@x.com",
      admin_email: "old@x.com",
      seeded: 1,
      guests: 0,
      guest_emails: "",
    });
  });

  it("refuses to overwrite access that has already been decided", async () => {
    await reg.setAccess({ allowed_emails: "current@x.com", admin_email: "current@x.com" });
    const result = await reg.seedAccess("stale@x.com", "stale@x.com");
    // The directory lags the registry by design. Seeding over a live decision would
    // resurrect an address somebody deliberately removed.
    expect(result.allowed_emails).toBe("current@x.com");
    expect((await reg.access()).allowed_emails).toBe("current@x.com");
  });

  it("is idempotent when two callers seed the same agent", async () => {
    const first = await reg.seedAccess("a@x.com", "a@x.com");
    const second = await reg.seedAccess("a@x.com", "a@x.com");
    expect(second).toEqual(first);
  });
});

describe("storage accounting", () => {
  it("starts empty and reports the ceiling", async () => {
    expect(await reg.storageState(MAX_AGENT_BYTES)).toEqual({ bytes: 0, limit: MAX_AGENT_BYTES });
  });

  it("adds and subtracts bytes", async () => {
    await reg.addStorageBytes(1000);
    await reg.addStorageBytes(500);
    await reg.addStorageBytes(-200);
    expect((await reg.storageState(MAX_AGENT_BYTES)).bytes).toBe(1300);
  });

  it("clamps at zero rather than going negative", async () => {
    await reg.addStorageBytes(100);
    await reg.addStorageBytes(-500);
    // The total is a running estimate that can drift; going negative would hand the
    // agent more headroom than the ceiling allows.
    expect((await reg.storageState(MAX_AGENT_BYTES)).bytes).toBe(0);
  });

  it("ignores values that are not usable numbers", async () => {
    await reg.addStorageBytes(1000);
    await reg.addStorageBytes(0);
    await reg.addStorageBytes(NaN);
    await reg.addStorageBytes(Infinity);
    expect((await reg.storageState(MAX_AGENT_BYTES)).bytes).toBe(1000);
  });

  it("reports the room left", async () => {
    await reg.addStorageBytes(1_000_000);
    expect(await reg.storageRoom(MAX_AGENT_BYTES)).toBe(MAX_AGENT_BYTES - 1_000_000);
  });

  it("never reports negative room once over the ceiling", async () => {
    await reg.addStorageBytes(MAX_AGENT_BYTES + 5_000_000);
    expect(await reg.storageRoom(MAX_AGENT_BYTES)).toBe(0);
  });
});

describe("spend accounting", () => {
  it("starts at zero", async () => {
    expect(await reg.spendThisMonth()).toBe(0);
  });

  it("accumulates within the month", async () => {
    await reg.addSpend(0.25);
    await reg.addSpend(0.75);
    expect(await reg.spendThisMonth()).toBeCloseTo(1);
  });

  it("ignores zero, negative and non-finite amounts", async () => {
    await reg.addSpend(1);
    await reg.addSpend(0);
    await reg.addSpend(-5);
    await reg.addSpend(NaN);
    // A refund path would need its own method; silently subtracting here would let a
    // bad cost calculation erase a month of spend.
    expect(await reg.spendThisMonth()).toBeCloseTo(1);
  });

  it("reports the month and the ceiling alongside the total", async () => {
    await reg.addSpend(2);
    const state = await reg.spendState();
    expect(state.month).toBe(thisMonth());
    expect(state.usd).toBeCloseTo(2);
    expect(typeof state.limit).toBe("number");
  });
});

describe("sessions", () => {
  it("creates and reads back a session", async () => {
    const created = await reg.create("s1", "First", "obj1", undefined, MAX_SESSIONS);
    expect(created.id).toBe("s1");
    expect((await reg.get("s1"))?.title).toBe("First");
  });

  it("counts sessions", async () => {
    await reg.create("s1", "one", "o1", undefined, MAX_SESSIONS);
    await reg.create("s2", "two", "o2", undefined, MAX_SESSIONS);
    expect(await reg.sessionCount()).toBe(2);
  });

  it("treats a repeated id as an update, not a second session", async () => {
    await reg.create("s1", "one", "o1", undefined, MAX_SESSIONS);
    await reg.create("s1", "renamed", "o1", undefined, MAX_SESSIONS);
    expect(await reg.sessionCount()).toBe(1);
    expect((await reg.get("s1"))?.title).toBe("renamed");
  });

  it("renames and deletes", async () => {
    await reg.create("s1", "one", "o1", undefined, MAX_SESSIONS);
    await reg.rename("s1", "two");
    expect((await reg.get("s1"))?.title).toBe("two");
    await reg.remove("s1");
    expect(await reg.get("s1")).toBeUndefined();
  });

  it("returns undefined for a session that does not exist", async () => {
    expect(await reg.get("nope")).toBeUndefined();
  });

  it("lists newest first", async () => {
    await reg.create("s1", "one", "o1", undefined, MAX_SESSIONS);
    nextMs();
    await reg.create("s2", "two", "o2", undefined, MAX_SESSIONS);
    const page = await reg.list(10);
    expect(page.sessions.map((s) => s.id)).toEqual(["s2", "s1"]);
  });

  it("breaks a tie on id so the order is total", async () => {
    // Two sessions written in the same millisecond must still come back in a fixed
    // order, or the keyset cursor cannot page them without skipping or repeating.
    await reg.create("b", "b", "ob", undefined, MAX_SESSIONS);
    await reg.create("a", "a", "oa", undefined, MAX_SESSIONS);
    // "a" is written second, so it wins on `updated_at DESC` when the clock moved and
    // on `id ASC` when it did not. Same answer either way, which is the point: the
    // order does not depend on timing.
    expect((await reg.list(10)).sessions.map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("pages with a cursor rather than an offset", async () => {
    for (let i = 0; i < 5; i++) await reg.create(`s${i}`, `t${i}`, `o${i}`, undefined, MAX_SESSIONS);
    const first = await reg.list(2);
    expect(first.sessions).toHaveLength(2);
    expect(first.cursor).toBeTruthy();

    const second = await reg.list(2, first.cursor);
    const seen = [...first.sessions, ...second.sessions].map((s) => s.id);
    // Keyset paging: no id may appear on two pages, which is exactly what an offset
    // cursor fails to guarantee when a turn touches a session mid-scroll.
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("ends paging with an empty cursor", async () => {
    await reg.create("s1", "one", "o1", undefined, MAX_SESSIONS);
    expect((await reg.list(10)).cursor).toBe("");
  });

  it("refuses a new session past the ceiling", async () => {
    for (let i = 0; i < MAX_SESSIONS; i++) await reg.create(`s${i}`, `t${i}`, `o${i}`, undefined, MAX_SESSIONS);
    // Caught rather than asserted through `.rejects`: a Durable Object RPC stub
    // surfaces the rejection to the runtime as well as to the caller, and `.rejects`
    // leaves the runtime's copy unhandled.
    const refusal = await reg.create("overflow", "t", "o", undefined, MAX_SESSIONS).then(
      () => null,
      (err: unknown) => (err instanceof Error ? err.message : String(err))
    );
    expect(refusal).toBe(sessionLimitMessage(MAX_SESSIONS));
  });

  it("still allows updating an existing session at the ceiling", async () => {
    for (let i = 0; i < MAX_SESSIONS; i++) await reg.create(`s${i}`, `t${i}`, `o${i}`, undefined, MAX_SESSIONS);
    // Otherwise renaming the oldest session starts failing the moment an agent fills
    // up, which is precisely when someone is trying to tidy it.
    await expect(reg.create("s0", "renamed", "o0", undefined, MAX_SESSIONS)).resolves.toMatchObject({ id: "s0" });
  });
});

describe("telegram chat sessions", () => {
  const origin = (chat_id: string, chat_thread_id = "") => ({
    source: "telegram",
    chat_id,
    chat_type: "group",
    chat_username: "",
    chat_thread_id,
  });

  it("finds the session for a chat", async () => {
    await reg.create("s1", "chat", "o1", origin("999"), MAX_SESSIONS);
    expect((await reg.forChat("999"))?.id).toBe("s1");
  });

  it("does not answer for a chat that has no session", async () => {
    expect(await reg.forChat("nope")).toBeUndefined();
  });

  it("keeps a forum topic separate from its group", async () => {
    await reg.create("group", "g", "o1", origin("999"), MAX_SESSIONS);
    await reg.create("topic", "t", "o2", origin("999", "7"), MAX_SESSIONS);
    // A group's own session must never answer for a topic inside it, or two
    // conversations share one transcript.
    expect((await reg.forChat("999"))?.id).toBe("group");
    expect((await reg.forChat("999", "7"))?.id).toBe("topic");
  });

  it("detaches a chat so the session stops answering for it", async () => {
    await reg.create("s1", "chat", "o1", origin("999"), MAX_SESSIONS);
    await reg.detachChat("s1");
    expect(await reg.forChat("999")).toBeUndefined();
  });
});

describe("the name a chat's session gets", () => {
  /**
   * A session id is addressed as a URL path segment, so one holding a character that
   * percent-encodes reaches its Durable Object in a different spelling than the one
   * the registry stored — and every lookup the object makes about itself misses in
   * silence. A WhatsApp chat id is `wa:<number>`; the colon is exactly that character.
   */
  const routable = (id: string) => encodeURIComponent(id) === id;

  it("survives a round trip through a URL path", () => {
    expect(routable(sessionIdForChat("a1", "wa:919718497676", "", "wa"))).toBe(true);
    expect(routable(sessionIdForChat("a1", "919718497676", "", "wa"))).toBe(true);
    expect(routable(sessionIdForChat("a1", "-1001234567890"))).toBe(true);
    expect(routable(sessionIdForChat("a1", "-1001234567890", "42"))).toBe(true);
  });

  it("still names a Telegram chat the way the stored ids are named", () => {
    // These ids are in live registries. A change here orphans every one of them.
    expect(sessionIdForChat("a1", "999")).toBe("a1~tg-999");
    expect(sessionIdForChat("a1", "-1001234567890")).toBe("a1~tg-n1001234567890");
    expect(sessionIdForChat("a1", "999", "7")).toBe("a1~tg-999-t7");
  });

  it("keeps two chats apart after the unsafe characters are dropped", () => {
    expect(sessionIdForChat("a1", "wa:111", "", "wa")).not.toBe(
      sessionIdForChat("a1", "wa:222", "", "wa")
    );
  });
});

describe("memories", () => {
  it("stores and recalls", async () => {
    await reg.remember("the deploy runbook lives in the wiki", "s1");
    const found = await reg.recall("runbook");
    expect(found).toHaveLength(1);
    expect(found[0].session_id).toBe("s1");
  });

  it("matches without regard to case", async () => {
    await reg.remember("Deploy On Friday", "s1");
    expect(await reg.recall("deploy on friday")).toHaveLength(1);
  });

  it("returns the most recent when the query is empty", async () => {
    await reg.remember("first", "s1");
    await reg.remember("second", "s1");
    expect((await reg.recall(""))[0].text).toBe("second");
  });

  it("honours the limit", async () => {
    for (let i = 0; i < 5; i++) await reg.remember(`note ${i}`, "s1");
    expect(await reg.recall("", 2)).toHaveLength(2);
  });

  it("returns nothing for a query that matches nothing", async () => {
    await reg.remember("something", "s1");
    expect(await reg.recall("absent")).toEqual([]);
  });

  it("forgets one memory without touching the rest", async () => {
    const kept = await reg.remember("keep me", "s1");
    const dropped = await reg.remember("drop me", "s1");
    await reg.forget(dropped.id);
    const left = await reg.recall("");
    expect(left.map((m) => m.id)).toEqual([kept.id]);
  });
});

describe("mcp servers", () => {
  const row = (id: string, name = "Server") => ({
    id,
    name,
    url: "https://mcp.example.com",
    auth: "none" as const,
    headers: "",
    enabled: 1,
    oauth_client_id: "",
    oauth_client_secret: "",
    oauth_access_token: "",
    oauth_refresh_token: "",
    oauth_expires_at: 0,
    oauth_scope: "",
    oauth_token_url: "",
    oauth_authorize_url: "",
    oauth_registration_url: "",
    oauth_resource: "",
    oauth_verifier: "",
    oauth_state: "",
    oauth_return_to: "",
    tools_json: "",
    disabled_tools: "",
    tools_synced_at: 0,
    last_error: "",
    created_at: Date.now(),
  });

  it("adds and lists a server", async () => {
    await reg.addMcpServer(row("m1"));
    const servers = await reg.mcpServers();
    expect(servers.map((s) => s.id)).toEqual(["m1"]);
  });

  it("reads one back by id", async () => {
    await reg.addMcpServer(row("m1", "Docs"));
    expect((await reg.mcpServer("m1"))?.name).toBe("Docs");
  });

  it("returns undefined for an unknown id", async () => {
    expect(await reg.mcpServer("nope")).toBeUndefined();
  });

  it("patches only the fields given", async () => {
    await reg.addMcpServer(row("m1", "Docs"));
    const patched = await reg.updateMcpServer("m1", { enabled: 0 });
    expect(patched?.enabled).toBe(0);
    expect(patched?.name).toBe("Docs");
  });

  it("records and clears the last error", async () => {
    await reg.addMcpServer(row("m1"));
    await reg.noteMcpError("m1", "connection refused");
    expect((await reg.mcpServer("m1"))?.last_error).toBe("connection refused");
    await reg.noteMcpError("m1", "");
    expect((await reg.mcpServer("m1"))?.last_error).toBe("");
  });

  it("finds a server by its OAuth state token", async () => {
    await reg.addMcpServer({ ...row("m1"), oauth_state: "state-token" });
    expect((await reg.mcpServerByState("state-token"))?.id).toBe("m1");
  });

  it("does not match an empty state token", async () => {
    // Every server with no handshake in flight stores "". Matching that would let a
    // callback with no state claim an arbitrary server.
    await reg.addMcpServer(row("m1"));
    expect(await reg.mcpServerByState("")).toBeUndefined();
  });

  it("removes a server", async () => {
    await reg.addMcpServer(row("m1"));
    await reg.removeMcpServer("m1");
    expect(await reg.mcpServers()).toEqual([]);
  });
});

describe("schema ladder", () => {
  /** The columns WhatsApp added, which an agent made before it does not have. */
  const whatsappColumns = [
    "cap_whatsapp",
    "whatsapp_phone_number_id",
    "whatsapp_access_token",
    "whatsapp_app_secret",
    "whatsapp_verify_token",
    "whatsapp_number",
  ];

  it("adds the WhatsApp config columns to an agent that predates them", async () => {
    // An agent created before WhatsApp shipped: its baseline ran without those
    // columns, and it will never run the baseline again. Reproduced by winding a
    // finished database back to where such an agent actually stands — the columns
    // gone, the recorded version one rung short of the end.
    await reg.config("vendor/default", SEED);
    await runInDurableObject(reg, (instance, ctx) => {
      for (const col of whatsappColumns) {
        ctx.storage.sql.exec(`ALTER TABLE config DROP COLUMN ${col}`);
      }
      ctx.storage.sql.exec(`UPDATE schema_migrations SET version = 2 WHERE id = 1`);
      // The object caches "schema is current" in memory; a real agent in this state
      // is one that has just been woken by the new code.
      (instance as unknown as { ready: boolean }).ready = false;
    });

    // Every read of the settings names every column, so this is the call that was
    // throwing `no such column: cap_whatsapp` — including from deleting the agent.
    const config = await reg.config("vendor/default", SEED);
    expect(config.cap_whatsapp).toBe(0);
    expect(config.whatsapp_number).toBe("");
  });

  it("leaves an agent that already has the columns alone", async () => {
    // The deploy that first shipped WhatsApp put these columns in the baseline, so
    // agents created under it have them and still have the new rung to run.
    await reg.config("vendor/default", SEED);
    await runInDurableObject(reg, (instance, ctx) => {
      ctx.storage.sql.exec(`UPDATE schema_migrations SET version = 2 WHERE id = 1`);
      (instance as unknown as { ready: boolean }).ready = false;
    });
    await reg.setConfig({ whatsapp_number: "+15550001111" }, "vendor/default", SEED);
    expect((await reg.config("vendor/default", SEED)).whatsapp_number).toBe("+15550001111");
  });
});
