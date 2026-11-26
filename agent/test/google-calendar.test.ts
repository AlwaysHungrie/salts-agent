import { SELF, env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CAPABILITY_BY_ID,
  capabilityInstructions,
  runTool,
  toolsFor,
  type ToolContext,
} from "../src/capabilities";
import {
  CALENDAR_API,
  GOOGLE_CALENDAR_SCOPES,
  GOOGLE_REVOKE_URL,
  GOOGLE_TOKEN_URL,
  describeEvent,
  eventTime,
  googleRedirectUri,
} from "../src/google-calendar";
import { DEFAULT_CONFIG, type Config } from "../src/registry";
import { registry } from "../src/worker/stores";
import { signedIn } from "./clerk";
import { SHIPPED } from "./shipped";

/**
 * Google Calendar: an agent connects one Google account through the deployment's OAuth
 * client, and its tools call the Calendar API with that account's token. Google is
 * stubbed throughout; these pin the connect flow, that tokens never reach the browser,
 * refreshing, and what the tools send.
 */

const BASE = "https://worker.test";
const CALENDAR_TOOLS = [
  "list_calendars",
  "list_calendar_events",
  "create_calendar_event",
  "update_calendar_event",
  "delete_calendar_event",
];

const config = (patch: Partial<Config> = {}): Config => ({
  model: "vendor/model",
  ...SHIPPED.config_defaults,
  ...DEFAULT_CONFIG,
  ...patch,
});

const as = (email: string, init: RequestInit = {}) => ({
  ...init,
  headers: { "content-type": "application/json", ...signedIn(email) },
});

async function agent() {
  const email = `cal-${crypto.randomUUID().slice(0, 8)}@x.com`;
  const res = await SELF.fetch(
    `${BASE}/api/agents`,
    as(email, { method: "POST", body: JSON.stringify({ name: "C", allowed_emails: email }) })
  );
  return { email, id: ((await res.json()) as { id: string }).id };
}

type Call = { url: string; method: string; body: string };

/** Answer Google's endpoints; `calendar` answers the Calendar API by path. */
function stubGoogle(
  calendar: (path: string, method: string, body: string) => Response = () => Response.json({})
) {
  const calls: Call[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = init?.method ?? "GET";
    const body = init?.body ? String(init.body) : "";
    calls.push({ url, method, body });
    if (url === GOOGLE_TOKEN_URL) {
      const form = new URLSearchParams(body);
      return Response.json({
        access_token: form.get("grant_type") === "refresh_token" ? "fresh-token" : "first-token",
        refresh_token: form.get("grant_type") === "refresh_token" ? undefined : "refresh-1",
        expires_in: 3600,
        scope: GOOGLE_CALENDAR_SCOPES.join(" "),
      });
    }
    if (url === GOOGLE_REVOKE_URL) return new Response("");
    if (url.startsWith(CALENDAR_API)) {
      const u = new URL(url);
      return calendar(u.pathname.replace("/calendar/v3", "") + u.search, method, body);
    }
    return new Response("unexpected", { status: 500 });
  });
  return calls;
}

afterEach(() => vi.restoreAllMocks());

/** Assert the agent has no token to give, for the reason `message` matches. */
async function tokenRefused(id: string, message: RegExp) {
  expect(await registry(env, id).googleCalendarToken()).toEqual({
    error: expect.stringMatching(message),
  });
}

/** Run the whole connect flow for a new agent, landing a connection with `token`. */
async function connected() {
  const { email, id } = await agent();
  stubGoogle((path) =>
    path.startsWith("/users/me/calendarList/primary")
      ? Response.json({ id: "me@gmail.com", timeZone: "Asia/Kolkata" })
      : Response.json({})
  );
  const start = await SELF.fetch(
    `${BASE}/api/agents/${id}/google-calendar/connect`,
    as(email, { method: "POST", body: JSON.stringify({ return_to: "https://app.test/caps" }) })
  );
  const authorize = new URL(((await start.json()) as { authorize_url: string }).authorize_url);
  const state = authorize.searchParams.get("state")!;
  const back = await SELF.fetch(
    `${BASE}/api/google/oauth/callback?state=${encodeURIComponent(state)}&code=c1`,
    { redirect: "manual" }
  );
  vi.restoreAllMocks();
  return { email, id, authorize, back };
}

describe("the capability", () => {
  it("offers the calendar tools only while switched on", () => {
    const names = (c: Config) => toolsFor(c).map((t) => t.name);
    expect(names(config())).not.toContain("list_calendar_events");
    expect(names(config({ cap_google_calendar: 1 }))).toEqual(
      expect.arrayContaining(CALENDAR_TOOLS)
    );
    expect(CAPABILITY_BY_ID.get("google_calendar")!.tools).toEqual(CALENDAR_TOOLS);
    expect(capabilityInstructions(config({ cap_google_calendar: 1 })).join()).toContain(
      "time zone"
    );
  });

  it("ships off", () => {
    expect(SHIPPED.config_defaults.cap_google_calendar).toBe(0);
  });
});

describe("connecting", () => {
  it("sends the browser to Google with PKCE, offline access and the calendar scopes", async () => {
    const { authorize } = await connected();
    expect(authorize.origin + authorize.pathname).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth"
    );
    expect(authorize.searchParams.get("client_id")).toBe(env.GOOGLE_CLIENT_ID);
    expect(authorize.searchParams.get("redirect_uri")).toBe(googleRedirectUri(BASE));
    expect(authorize.searchParams.get("scope")).toBe(GOOGLE_CALENDAR_SCOPES.join(" "));
    expect(authorize.searchParams.get("access_type")).toBe("offline");
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("stores the connection and lands back with the account, never showing a token", async () => {
    const { email, id, back } = await connected();
    expect(back.status).toBe(302);
    const landed = new URL(back.headers.get("location")!);
    expect(landed.origin + landed.pathname).toBe("https://app.test/caps");
    expect(landed.searchParams.get("gcal_connected")).toBe("me@gmail.com");

    const res = await SELF.fetch(`${BASE}/api/agents/${id}/google-calendar`, as(email));
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({
      available: true,
      connection: { connected: true, email: "me@gmail.com", last_error: "" },
    });
    expect(text).not.toContain("first-token");
    expect(text).not.toContain("refresh-1");
    expect(await registry(env, id).googleCalendarToken()).toEqual({ token: "first-token" });
  });

  it("refuses a callback whose state it did not hand out", async () => {
    const { id } = await agent();
    const res = await SELF.fetch(`${BASE}/api/google/oauth/callback?state=${id}.forged&code=c`);
    expect(res.status).toBe(400);
  });

  it("reports a declined consent back to the page", async () => {
    const { email, id } = await agent();
    const start = await SELF.fetch(
      `${BASE}/api/agents/${id}/google-calendar/connect`,
      as(email, { method: "POST", body: JSON.stringify({ return_to: "https://app.test/caps" }) })
    );
    const state = new URL(((await start.json()) as { authorize_url: string }).authorize_url)
      .searchParams.get("state")!;
    const back = await SELF.fetch(
      `${BASE}/api/google/oauth/callback?state=${encodeURIComponent(state)}&error=access_denied`,
      { redirect: "manual" }
    );
    expect(new URL(back.headers.get("location")!).searchParams.get("gcal_error")).toMatch(
      /not granted/
    );
    expect((await registry(env, id).googleCalendar()).connected).toBe(false);
  });

  it("refuses a consent with the calendar scopes unticked", async () => {
    const { email, id } = await agent();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ access_token: "t", refresh_token: "r", scope: "openid" })
    );
    const start = await SELF.fetch(
      `${BASE}/api/agents/${id}/google-calendar/connect`,
      as(email, { method: "POST", body: JSON.stringify({ return_to: "https://app.test/caps" }) })
    );
    const state = new URL(((await start.json()) as { authorize_url: string }).authorize_url)
      .searchParams.get("state")!;
    const back = await SELF.fetch(
      `${BASE}/api/google/oauth/callback?state=${encodeURIComponent(state)}&code=c`,
      { redirect: "manual" }
    );
    expect(new URL(back.headers.get("location")!).searchParams.get("gcal_error")).toMatch(
      /not granted/
    );
    expect((await registry(env, id).googleCalendar()).connected).toBe(false);
  });

  it("keeps a stranger out", async () => {
    const { id } = await agent();
    const res = await SELF.fetch(`${BASE}/api/agents/${id}/google-calendar`, as("no@x.com"));
    expect(res.status).toBe(404);
  });

  it("disconnects and revokes the token at Google", async () => {
    const { email, id } = await connected();
    const calls = stubGoogle();
    const res = await SELF.fetch(
      `${BASE}/api/agents/${id}/google-calendar/disconnect`,
      as(email, { method: "POST" })
    );
    expect(((await res.json()) as { connection: { connected: boolean } }).connection.connected).toBe(
      false
    );
    expect(calls.find((c) => c.url === GOOGLE_REVOKE_URL)?.body).toContain("refresh-1");
    await tokenRefused(id, /not connected/);
  });
});

describe("deleting the agent", () => {
  it("revokes the Google grant before wiping the agent", async () => {
    const { email, id } = await connected();
    const calls = stubGoogle();
    const res = await SELF.fetch(`${BASE}/api/agents/${id}`, as(email, { method: "DELETE" }));
    expect(res.status).toBe(200);
    expect(calls.find((c) => c.url === GOOGLE_REVOKE_URL)?.body).toContain("refresh-1");
  });
});

describe("tokens", () => {
  it("refreshes a spent token, once for concurrent callers", async () => {
    const { id } = await connected();
    const reg = registry(env, id);
    // Spend the token by hand: an hour on, it would be.
    await reg.finishGoogleCalendar({
      email: "me@gmail.com",
      access_token: "old",
      refresh_token: "refresh-1",
      expires_at: Date.now() - 1000,
      scope: "",
    });
    const calls = stubGoogle();
    const [a, b] = await Promise.all([reg.googleCalendarToken(), reg.googleCalendarToken()]);
    expect([a, b]).toEqual([{ token: "fresh-token" }, { token: "fresh-token" }]);
    expect(calls.filter((c) => c.url === GOOGLE_TOKEN_URL)).toHaveLength(1);
  });

  it("ends the connection when Google refuses the refresh", async () => {
    const { id } = await connected();
    const reg = registry(env, id);
    await reg.finishGoogleCalendar({
      email: "me@gmail.com",
      access_token: "old",
      refresh_token: "revoked",
      expires_at: Date.now() - 1000,
      scope: "",
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ error: "invalid_grant" }, { status: 400 })
    );
    await tokenRefused(id, /Connect it again/);
    expect(await reg.googleCalendar()).toMatchObject({ connected: false });
  });
});

describe("the tools", () => {
  async function ctxFor() {
    const { id } = await connected();
    return {
      config: config({ cap_google_calendar: 1 }),
      registry: registry(env, id),
    } as unknown as ToolContext;
  }

  it("lists events with the calendar's time zone and ids", async () => {
    const ctx = await ctxFor();
    const calls = stubGoogle((path) =>
      path.startsWith("/calendars/primary/events")
        ? Response.json({
            timeZone: "Asia/Kolkata",
            items: [
              {
                id: "ev1",
                summary: "Standup",
                start: { dateTime: "2026-11-27T10:00:00+05:30" },
                end: { dateTime: "2026-11-27T10:15:00+05:30" },
                attendees: [{ email: "me@gmail.com", self: true }, { email: "a@x.com" }],
              },
              { id: "gone", status: "cancelled" },
            ],
          })
        : Response.json({})
    );
    const out = await runTool("list_calendar_events", { query: "standup" }, ctx);
    expect(out.ok).toBe(true);
    expect(out.content).toContain("Calendar time zone: Asia/Kolkata.");
    expect(out.content).toContain("Standup | 2026-11-27T10:00:00+05:30");
    expect(out.content).toContain("id: ev1");
    expect(out.content).toContain("with a@x.com");
    expect(out.content).not.toContain("gone");
    const asked = new URL(calls.find((c) => c.url.includes("/events"))!.url);
    expect(asked.searchParams.get("singleEvents")).toBe("true");
    expect(asked.searchParams.get("q")).toBe("standup");
    expect(asked.searchParams.get("timeMin")).toBeTruthy();
  });

  it("books a local time in the calendar's zone, quietly by default", async () => {
    const ctx = await ctxFor();
    const calls = stubGoogle((path, method, body) => {
      if (path.startsWith("/users/me/calendarList/primary")) {
        return Response.json({ id: "me@gmail.com", timeZone: "Asia/Kolkata" });
      }
      if (method === "POST") return Response.json({ id: "new1", ...JSON.parse(body) });
      return Response.json({});
    });
    const out = await runTool(
      "create_calendar_event",
      {
        summary: "Dentist",
        start: "2026-11-27T15:00:00",
        end: "2026-11-27T16:00:00",
        attendees: ["b@x.com"],
      },
      ctx
    );
    expect(out.ok).toBe(true);
    expect(out.content).toContain("id: new1");
    const post = calls.find((c) => c.method === "POST" && c.url.includes("/events"))!;
    expect(new URL(post.url).searchParams.get("sendUpdates")).toBe("none");
    expect(JSON.parse(post.body)).toEqual({
      summary: "Dentist",
      start: { dateTime: "2026-11-27T15:00:00", timeZone: "Asia/Kolkata" },
      end: { dateTime: "2026-11-27T16:00:00", timeZone: "Asia/Kolkata" },
      attendees: [{ email: "b@x.com" }],
    });
  });

  it("patches only the fields given, and deletes", async () => {
    const ctx = await ctxFor();
    const calls = stubGoogle((_path, method, body) =>
      method === "DELETE"
        ? new Response(null, { status: 204 })
        : Response.json({ id: "ev1", summary: "x", ...JSON.parse(body || "{}") })
    );
    const updated = await runTool(
      "update_calendar_event",
      { event_id: "ev1", location: "Room 4", notify_attendees: true },
      ctx
    );
    expect(updated.content).toContain("at Room 4");
    const patch = calls.find((c) => c.method === "PATCH")!;
    expect(JSON.parse(patch.body)).toEqual({ location: "Room 4" });
    expect(new URL(patch.url).searchParams.get("sendUpdates")).toBe("all");

    const deleted = await runTool("delete_calendar_event", { event_id: "ev1" }, ctx);
    expect(deleted).toEqual({ ok: true, content: "Deleted event ev1." });
    expect(calls.some((c) => c.method === "DELETE" && c.url.endsWith("/events/ev1?sendUpdates=none"))).toBe(true);
  });

  it("refreshes and retries once when Google refuses the token", async () => {
    const ctx = await ctxFor();
    stubGoogle(() => Response.json({ items: [{ id: "c1", summary: "Work", primary: true }] }));
    const fetchSpy = vi.mocked(globalThis.fetch);
    const original = fetchSpy.getMockImplementation()!;
    let refused = false;
    fetchSpy.mockImplementation(async (input, init) => {
      const url = String(input);
      const auth = new Headers(init?.headers).get("authorization");
      if (url.startsWith(CALENDAR_API) && auth === "Bearer first-token" && !refused) {
        refused = true;
        return new Response("", { status: 401 });
      }
      return original(input, init);
    });
    const out = await runTool("list_calendars", {}, ctx);
    expect(out).toEqual({ ok: true, content: expect.stringContaining("Work (main) | id: c1") });
    expect(refused).toBe(true);
  });

  it("tells the model to have the calendar connected when it is not", async () => {
    const { id } = await agent();
    const ctx = { registry: registry(env, id) } as unknown as ToolContext;
    const out = await runTool("list_calendars", {}, ctx);
    expect(out.ok).toBe(false);
    expect(out.content).toContain("Capabilities page");
  });
});

describe("helpers", () => {
  it("makes a bare date an all-day time", () => {
    expect(eventTime("2026-12-25", "Asia/Kolkata")).toEqual({ date: "2026-12-25" });
    expect(eventTime("2026-12-25T09:00:00Z", "")).toEqual({ dateTime: "2026-12-25T09:00:00Z" });
  });

  it("names a repeating occurrence's series", () => {
    expect(
      describeEvent({
        id: "s_2026",
        summary: "Gym",
        recurringEventId: "s",
        start: { date: "2026-12-01" },
        end: { date: "2026-12-02" },
      })
    ).toBe("- Gym | 2026-12-01 (all day) → 2026-12-02 (all day) | id: s_2026 | repeats (series id: s)");
  });
});
