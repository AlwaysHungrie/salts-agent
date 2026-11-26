import type { ToolContext, ToolSpec } from "./capabilities";

/**
 * The Google Calendar capability: an OAuth connection to the user's Google account and
 * tools over the Calendar REST API. Google takes neither client metadata documents nor
 * dynamic registration, so the deployment holds one registered OAuth client
 * (`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`) and every agent connects through it.
 */

export const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
export const CALENDAR_API = "https://www.googleapis.com/calendar/v3";

/**
 * Read and write events on every calendar, and list the calendars. Not the full
 * `calendar` scope: the agent never needs to create, share or delete a calendar itself.
 */
export const GOOGLE_CALENDAR_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
];

/** Where Google sends the browser back to. Always this Worker, for every agent. */
export const googleRedirectUri = (origin: string) => `${origin}/api/google/oauth/callback`;

/** Google's consent screen for one connection attempt. */
export function googleAuthorizeUrl(p: {
  clientId: string;
  redirectUri: string;
  state: string;
  challenge: string;
}): string {
  const url = new URL(GOOGLE_AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", p.clientId);
  url.searchParams.set("redirect_uri", p.redirectUri);
  url.searchParams.set("scope", GOOGLE_CALENDAR_SCOPES.join(" "));
  // Offline + consent: Google hands out a refresh token only on a consent it showed.
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", p.state);
  url.searchParams.set("code_challenge", p.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

/** Whether a granted scope string covers everything the tools call. */
export function grantsCalendar(scope: string): boolean {
  const granted = new Set(scope.split(/\s+/));
  return GOOGLE_CALENDAR_SCOPES.every((s) => granted.has(s));
}

/* ------------------------------------------------------------- the API -- */

/** Google refused the token: refresh it and try once more. */
export class CalendarUnauthorized extends Error {}

/** One Calendar API call. Errors carry Google's own message, which the model can act on. */
export async function calendarFetch<T>(
  token: string,
  path: string,
  init: { method?: string; query?: Record<string, string | undefined>; body?: unknown } = {}
): Promise<T> {
  const url = new URL(`${CALENDAR_API}${path}`);
  for (const [key, value] of Object.entries(init.query ?? {})) {
    if (value !== undefined && value !== "") url.searchParams.set(key, value);
  }
  const res = await fetch(url, {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json",
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  if (res.status === 401) throw new CalendarUnauthorized("Google refused the access token");
  if (!res.ok) {
    const text = await res.text();
    let message = text.slice(0, 300);
    try {
      message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? message;
    } catch {
      // Not JSON: the raw text is the best explanation there is.
    }
    throw new Error(`Google Calendar answered ${res.status}: ${message}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** The agent's access token, or a throw saying why there is none. */
async function calendarToken(ctx: ToolContext, force = false): Promise<string> {
  const result = await ctx.registry.googleCalendarToken(force);
  if ("error" in result) throw new Error(result.error);
  return result.token;
}

/** Run with the agent's token, retrying once with a forced refresh on a 401. */
async function withCalendar<T>(ctx: ToolContext, run: (token: string) => Promise<T>): Promise<T> {
  try {
    return await run(await calendarToken(ctx));
  } catch (err) {
    if (!(err instanceof CalendarUnauthorized)) throw err;
    return await run(await calendarToken(ctx, true));
  }
}

type CalendarListEntry = {
  id: string;
  summary?: string;
  summaryOverride?: string;
  timeZone?: string;
  accessRole?: string;
  primary?: boolean;
};

type EventTime = { date?: string; dateTime?: string; timeZone?: string };

export type CalendarEvent = {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: EventTime;
  end?: EventTime;
  htmlLink?: string;
  recurringEventId?: string;
  recurrence?: string[];
  attendees?: { email: string; responseStatus?: string; self?: boolean }[];
  organizer?: { email?: string; self?: boolean };
};

/** The connected account's address: its primary calendar's id. */
export async function primaryCalendarEmail(token: string): Promise<string> {
  const entry = await calendarFetch<CalendarListEntry>(token, "/users/me/calendarList/primary");
  return entry.id;
}

const enc = encodeURIComponent;
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const calendarOf = (args: Record<string, unknown>) => str(args.calendar_id) || "primary";

const when = (t: EventTime | undefined) => t?.dateTime ?? (t?.date ? `${t.date} (all day)` : "?");

/** One event as the model reads it: everything needed to talk about it or change it. */
export function describeEvent(e: CalendarEvent): string {
  const facts = [`${e.summary || "(no title)"}`, `${when(e.start)} → ${when(e.end)}`, `id: ${e.id}`];
  if (e.recurringEventId) facts.push(`repeats (series id: ${e.recurringEventId})`);
  else if (e.recurrence?.length) facts.push(`repeats: ${e.recurrence.join("; ")}`);
  if (e.location) facts.push(`at ${e.location}`);
  const others = (e.attendees ?? []).filter((a) => !a.self);
  if (others.length) {
    facts.push(
      `with ${others.map((a) => `${a.email}${a.responseStatus ? ` (${a.responseStatus})` : ""}`).join(", ")}`
    );
  }
  if (e.organizer && !e.organizer.self && e.organizer.email) {
    facts.push(`organized by ${e.organizer.email}`);
  }
  const description = e.description?.trim();
  return `- ${facts.join(" | ")}${description ? `\n  ${description.slice(0, 300)}` : ""}`;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** The calendar's own time zone, for times given without one. Blank when unknown. */
async function calendarZone(token: string, calendarId: string): Promise<string> {
  try {
    const entry = await calendarFetch<CalendarListEntry>(
      token,
      `/users/me/calendarList/${enc(calendarId)}`
    );
    return entry.timeZone ?? "";
  } catch {
    return "";
  }
}

/**
 * An event's start or end: a bare date is all day, anything else a date-time in
 * `zone` (an offset in the value wins for the instant; the zone still names where it
 * repeats, which Google requires of a recurring event).
 */
export function eventTime(value: string, zone: string): EventTime {
  if (DATE_ONLY.test(value)) return { date: value };
  return zone ? { dateTime: value, timeZone: zone } : { dateTime: value };
}

const EVENT_FIELDS = {
  summary: { type: "string", description: "The event's title." },
  start: {
    type: "string",
    description:
      "When it starts: a date-time such as 2026-11-27T15:00:00, or a date such as 2026-11-27 for an all-day event.",
  },
  end: {
    type: "string",
    description:
      "When it ends, in the same form as start. For an all-day event, the day after the last day.",
  },
  time_zone: {
    type: "string",
    description:
      "IANA time zone of start and end, e.g. Asia/Kolkata. Leave out to use the calendar's own.",
  },
  description: { type: "string", description: "Notes shown in the event." },
  location: { type: "string", description: "Where it takes place." },
  attendees: {
    type: "array",
    items: { type: "string" },
    description: "Guests' email addresses. On an update, replaces the whole guest list.",
  },
  recurrence: {
    type: "array",
    items: { type: "string" },
    description: "RFC 5545 rules for a repeating event, e.g. [\"RRULE:FREQ=WEEKLY;BYDAY=MO\"].",
  },
  notify_attendees: {
    type: "boolean",
    description: "Email the guests about this change. Default false.",
  },
} as const;

const CALENDAR_ID = {
  type: "string",
  description: "The calendar's id from list_calendars. Leave out for the user's main calendar.",
} as const;

/** The event body for the fields the model gave; `zone` resolves times with no zone. */
async function eventBody(
  args: Record<string, unknown>,
  token: string,
  calendarId: string
): Promise<Partial<CalendarEvent> & Record<string, unknown>> {
  const body: Record<string, unknown> = {};
  for (const key of ["summary", "description", "location"] as const) {
    if (typeof args[key] === "string") body[key] = args[key];
  }
  const start = str(args.start);
  const end = str(args.end);
  if (start || end) {
    const timed = [start, end].some((v) => v && !DATE_ONLY.test(v));
    const zone = str(args.time_zone) || (timed ? await calendarZone(token, calendarId) : "");
    if (start) body.start = eventTime(start, zone);
    if (end) body.end = eventTime(end, zone);
  }
  if (Array.isArray(args.attendees)) {
    body.attendees = args.attendees
      .map((a) => str(a))
      .filter(Boolean)
      .map((email) => ({ email }));
  }
  if (Array.isArray(args.recurrence)) {
    body.recurrence = args.recurrence.map((r) => str(r)).filter(Boolean);
  }
  return body;
}

const sendUpdates = (args: Record<string, unknown>) =>
  args.notify_attendees === true ? "all" : "none";

export const GOOGLE_CALENDAR_INSTRUCTIONS =
  "You can read and change the user's Google Calendar. Use it whenever the user asks about their schedule, free time, meetings or plans, or wants something booked, moved or cancelled, even when they do not say \"calendar\". Messages are stamped in UTC, but the user's day runs in their calendar's time zone, which list_calendar_events reports: read and give times in that zone, and when booking, give start and end as local times without an offset. Before booking, check that time for clashes. To change or cancel an event, find it with list_calendar_events first and use its id. Ask the user before deleting an event, or before inviting or emailing other people, unless they already asked for exactly that.";

export const GOOGLE_CALENDAR_TOOLS: ToolSpec[] = [
  {
    name: "list_calendars",
    description:
      "List the user's Google calendars: their ids, names, time zones and whether you can edit them. Only needed to use a calendar other than the main one.",
    parameters: { type: "object", properties: {} },
    async run(_args, ctx) {
      const list = await withCalendar(ctx, (token) =>
        calendarFetch<{ items?: CalendarListEntry[] }>(token, "/users/me/calendarList", {
          query: { maxResults: "250" },
        })
      );
      const items = list.items ?? [];
      if (!items.length) return "No calendars.";
      return items
        .map(
          (c) =>
            `- ${c.summaryOverride || c.summary || c.id}${c.primary ? " (main)" : ""} | id: ${c.id} | ${c.timeZone ?? "?"} | ${c.accessRole === "owner" || c.accessRole === "writer" ? "can edit" : "read only"}`
        )
        .join("\n");
    },
  },
  {
    name: "list_calendar_events",
    description:
      "Read events from the user's Google Calendar between two times, soonest first, optionally matching words. Repeating events come back as single occurrences. Returns each event's id, title, times, place, guests and notes, and the calendar's time zone.",
    parameters: {
      type: "object",
      properties: {
        calendar_id: CALENDAR_ID,
        time_min: {
          type: "string",
          description:
            "Earliest end time, RFC 3339 with an offset, e.g. 2026-11-27T00:00:00+05:30. Defaults to now.",
        },
        time_max: {
          type: "string",
          description: "Latest start time, in the same form. Leave out for no limit.",
        },
        query: {
          type: "string",
          description: "Words to match in titles, notes, places and guests.",
        },
        max_results: { type: "number", description: "At most this many events, up to 100. Default 25." },
      },
    },
    async run(args, ctx) {
      const calendarId = calendarOf(args);
      const max = Math.min(Math.max(Math.floor(Number(args.max_results) || 25), 1), 100);
      const page = await withCalendar(ctx, (token) =>
        calendarFetch<{ items?: CalendarEvent[]; timeZone?: string; nextPageToken?: string }>(
          token,
          `/calendars/${enc(calendarId)}/events`,
          {
            query: {
              singleEvents: "true",
              orderBy: "startTime",
              timeMin: str(args.time_min) || new Date().toISOString(),
              timeMax: str(args.time_max) || undefined,
              q: str(args.query) || undefined,
              maxResults: String(max),
            },
          }
        )
      );
      const events = (page.items ?? []).filter((e) => e.status !== "cancelled");
      const zone = `Calendar time zone: ${page.timeZone ?? "unknown"}.`;
      if (!events.length) return `${zone}\nNo events in that range.`;
      const more = page.nextPageToken
        ? `\nThere are more; narrow the range or raise max_results to see them.`
        : "";
      return `${zone}\n${events.map(describeEvent).join("\n")}${more}`;
    },
  },
  {
    name: "create_calendar_event",
    description:
      "Add an event to the user's Google Calendar. Returns the new event with its id and link.",
    parameters: {
      type: "object",
      properties: { calendar_id: CALENDAR_ID, ...EVENT_FIELDS },
      required: ["summary", "start", "end"],
    },
    async run(args, ctx) {
      if (!str(args.summary) || !str(args.start) || !str(args.end)) {
        throw new Error("summary, start and end are all required");
      }
      const calendarId = calendarOf(args);
      const event = await withCalendar(ctx, async (token) =>
        calendarFetch<CalendarEvent>(token, `/calendars/${enc(calendarId)}/events`, {
          method: "POST",
          query: { sendUpdates: sendUpdates(args) },
          body: await eventBody(args, token, calendarId),
        })
      );
      return `Created:\n${describeEvent(event)}${event.htmlLink ? `\n${event.htmlLink}` : ""}`;
    },
  },
  {
    name: "update_calendar_event",
    description:
      "Change an event on the user's Google Calendar: only the fields you give are changed. Use the id from list_calendar_events; to change every occurrence of a repeating event, use its series id instead.",
    parameters: {
      type: "object",
      properties: {
        event_id: { type: "string", description: "The event's id." },
        calendar_id: CALENDAR_ID,
        ...EVENT_FIELDS,
      },
      required: ["event_id"],
    },
    async run(args, ctx) {
      const id = str(args.event_id);
      if (!id) throw new Error("event_id is required");
      const calendarId = calendarOf(args);
      const event = await withCalendar(ctx, async (token) => {
        const body = await eventBody(args, token, calendarId);
        if (!Object.keys(body).length) throw new Error("nothing to change was given");
        return calendarFetch<CalendarEvent>(
          token,
          `/calendars/${enc(calendarId)}/events/${enc(id)}`,
          { method: "PATCH", query: { sendUpdates: sendUpdates(args) }, body }
        );
      });
      return `Updated:\n${describeEvent(event)}`;
    },
  },
  {
    name: "delete_calendar_event",
    description:
      "Delete an event from the user's Google Calendar. Use the id from list_calendar_events; a repeating event's series id deletes every occurrence.",
    parameters: {
      type: "object",
      properties: {
        event_id: { type: "string", description: "The event's id." },
        calendar_id: CALENDAR_ID,
        notify_attendees: EVENT_FIELDS.notify_attendees,
      },
      required: ["event_id"],
    },
    async run(args, ctx) {
      const id = str(args.event_id);
      if (!id) throw new Error("event_id is required");
      const calendarId = calendarOf(args);
      await withCalendar(ctx, (token) =>
        calendarFetch<void>(token, `/calendars/${enc(calendarId)}/events/${enc(id)}`, {
          method: "DELETE",
          query: { sendUpdates: sendUpdates(args) },
        })
      );
      return `Deleted event ${id}.`;
    },
  },
];
