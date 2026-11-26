import { McpTokenError, refreshToken } from "../mcp";
import { GOOGLE_TOKEN_URL } from "../google-calendar";

/**
 * The agent's Google Calendar connection: one row, kept apart from `config` because the
 * browser reads and patches `config`, and these tokens open someone's calendar.
 */
export type GoogleCalendarRow = {
  /** The connected account, read from its primary calendar's id. */
  email: string;
  access_token: string;
  refresh_token: string;
  /** Epoch ms the access token expires; 0 when unknown. */
  expires_at: number;
  scope: string;
  /* An authorization in flight: its CSRF state, PKCE verifier and where to land after. */
  state: string;
  verifier: string;
  return_to: string;
  /** Why the connection last failed, shown on the capabilities page. Empty when it works. */
  last_error: string;
  connected_at: number;
};

/** What the browser may see of the connection: never a token. */
export type GoogleCalendarView = {
  connected: boolean;
  email: string;
  last_error: string;
  connected_at: number;
};

export const EMPTY_GOOGLE_CALENDAR: GoogleCalendarRow = {
  email: "",
  access_token: "",
  refresh_token: "",
  expires_at: 0,
  scope: "",
  state: "",
  verifier: "",
  return_to: "",
  last_error: "",
  connected_at: 0,
};

const COLUMNS = Object.keys(EMPTY_GOOGLE_CALENDAR) as (keyof GoogleCalendarRow)[];

export function readGoogleCalendar(storage: DurableObjectStorage): GoogleCalendarRow {
  const row = storage.sql
    .exec(`SELECT ${COLUMNS.join(", ")} FROM google_calendar WHERE id = 1`)
    .toArray()[0] as GoogleCalendarRow | undefined;
  return row ?? { ...EMPTY_GOOGLE_CALENDAR };
}

/** A partial update: only the columns present are written. */
export function updateGoogleCalendar(
  storage: DurableObjectStorage,
  patch: Partial<GoogleCalendarRow>
): GoogleCalendarRow {
  const next = { ...readGoogleCalendar(storage), ...patch };
  storage.sql.exec(
    `INSERT INTO google_calendar (id, ${COLUMNS.join(", ")})
     VALUES (1, ${COLUMNS.map(() => "?").join(", ")})
     ON CONFLICT (id) DO UPDATE SET ${COLUMNS.map((c) => `${c} = excluded.${c}`).join(", ")}`,
    ...COLUMNS.map((c) => next[c])
  );
  return next;
}

export function googleCalendarView(row: GoogleCalendarRow): GoogleCalendarView {
  return {
    connected: row.refresh_token !== "" || row.access_token !== "",
    email: row.email,
    last_error: row.last_error,
    connected_at: row.connected_at,
  };
}

/** The tokens and the account dropped, keeping nothing but the reason, if any. */
export function clearedGoogleCalendar(last_error = ""): GoogleCalendarRow {
  return { ...EMPTY_GOOGLE_CALENDAR, last_error };
}

/**
 * Trade the refresh token for a new access token and store it. A refused grant (the user
 * revoked access in their Google account) ends the connection.
 */
export async function refreshGoogleCalendar(
  storage: DurableObjectStorage,
  row: GoogleCalendarRow,
  client: { id: string; secret: string }
): Promise<GoogleCalendarRow> {
  try {
    const tokens = await refreshToken(GOOGLE_TOKEN_URL, {
      refreshToken: row.refresh_token,
      clientId: client.id,
      clientSecret: client.secret,
    });
    return updateGoogleCalendar(storage, {
      access_token: tokens.access_token,
      // Google keeps the refresh token unless it rotates one; keep the old when it does not.
      refresh_token: tokens.refresh_token ?? row.refresh_token,
      expires_at: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : 0,
      last_error: "",
    });
  } catch (err) {
    if (err instanceof McpTokenError && err.permanent) {
      return updateGoogleCalendar(
        storage,
        clearedGoogleCalendar("Google Calendar was disconnected. Connect it again to keep using it.")
      );
    }
    return updateGoogleCalendar(storage, {
      last_error: err instanceof Error ? err.message : String(err),
    });
  }
}
