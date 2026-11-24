import type { PhoneNumberKind, PhoneNumberRow, WhatsappSetup } from "./types";
import { paidRow } from "./wallet-purchases";

const NO_SETUP: WhatsappSetup = {
  wa_stage: "",
  wa_account_sid: "",
  wa_account_token: "",
  waba_id: "",
  wa_sender_sid: "",
  wa_sender_status: "",
  wa_code: "",
  wa_code_at: 0,
};

/** A number's id: short, and safe to put in a URL. */
const NUMBER_ID = () => crypto.randomUUID().replace(/-/g, "").slice(0, 12);

/**
 * A phone number as stored: digits only, country code first. Spaces, dashes, brackets,
 * dots and a leading "+" are dropped; anything else, or a length no international number
 * has (E.164 allows at most 15 digits), is refused as undefined.
 */
export function normalizeNumber(input: string): string | undefined {
  const digits = input.trim().replace(/^\+/, "").replace(/[\s\-().]/g, "");
  return /^[1-9]\d{7,14}$/.test(digits) ? digits : undefined;
}

export function phoneNumbers(storage: DurableObjectStorage, email: string): PhoneNumberRow[] {
  return storage.sql
    .exec(
      `SELECT * FROM phone_numbers WHERE email = ? ORDER BY created_at ASC, id ASC`,
      email.trim().toLowerCase()
    )
    .toArray() as unknown as PhoneNumberRow[];
}

/**
 * Add a number to `email`'s wallet. Refused as `{ error }` (not thrown, so the route can
 * answer 400) when the wallet is full, or the number is already in any account's wallet:
 * one number can only be registered with WhatsApp once.
 */
export function addPhoneNumber(
  storage: DurableObjectStorage,
  email: string,
  entry: { number: string; kind: PhoneNumberKind; twilio_sid?: string; expires_at?: number },
  max: number
): PhoneNumberRow | { error: string } {
  const owner = email.trim().toLowerCase();
  const taken = storage.sql
    .exec(`SELECT email FROM phone_numbers WHERE number = ? LIMIT 1`, entry.number)
    .toArray()[0] as { email: string } | undefined;
  if (taken) {
    return {
      error:
        taken.email === owner
          ? "That number is already in your wallet."
          : "That number is already in use on Salts.",
    };
  }
  if (phoneNumbers(storage, owner).length >= max) {
    return { error: `A wallet holds at most ${max} numbers.` };
  }
  const row: PhoneNumberRow = {
    id: NUMBER_ID(),
    email: owner,
    number: entry.number,
    kind: entry.kind,
    created_at: Date.now(),
    twilio_sid: entry.twilio_sid ?? "",
    expires_at: entry.expires_at ?? 0,
    reminded_at: 0,
    agent_id: "",
    ...NO_SETUP,
  };
  storage.sql.exec(
    `INSERT INTO phone_numbers (id, email, number, kind, created_at, twilio_sid, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    row.id,
    row.email,
    row.number,
    row.kind,
    row.created_at,
    row.twilio_sid,
    row.expires_at
  );
  return row;
}

/** Remove one of `email`'s numbers, returning it; undefined when it is not theirs. */
export function removePhoneNumber(
  storage: DurableObjectStorage,
  email: string,
  id: string
): PhoneNumberRow | undefined {
  const owner = email.trim().toLowerCase();
  const row = phoneNumbers(storage, owner).find((n) => n.id === id);
  if (row) storage.sql.exec(`DELETE FROM phone_numbers WHERE id = ?`, id);
  return row;
}

/** The number `agentId` answers on, whoever holds it; undefined when it has none. */
export function agentPhoneNumber(
  storage: DurableObjectStorage,
  agentId: string
): PhoneNumberRow | undefined {
  if (!agentId) return undefined;
  return storage.sql
    .exec(`SELECT * FROM phone_numbers WHERE agent_id = ? LIMIT 1`, agentId)
    .toArray()[0] as unknown as PhoneNumberRow | undefined;
}

/**
 * Give `agentId` one of `email`'s numbers, in place of any number it had; a blank
 * `numberId` leaves it with none. A number answers for one agent only, so one already
 * given to another agent is refused as `{ error }` until it is taken off that one.
 */
export function assignPhoneNumber(
  storage: DurableObjectStorage,
  email: string,
  agentId: string,
  numberId: string
): PhoneNumberRow | undefined | { error: string } {
  return storage.transactionSync(() => {
    let row: PhoneNumberRow | undefined;
    if (numberId) {
      row = phoneNumbers(storage, email).find((n) => n.id === numberId);
      if (!row) return { error: "That number is not in your Business Phone Numbers." };
      if (row.agent_id && row.agent_id !== agentId) {
        return { error: "That number is already used by another agent." };
      }
    }
    storage.sql.exec(`UPDATE phone_numbers SET agent_id = '' WHERE agent_id = ?`, agentId);
    if (!row) return undefined;
    storage.sql.exec(`UPDATE phone_numbers SET agent_id = ? WHERE id = ?`, agentId, row.id);
    return { ...row, agent_id: agentId };
  });
}

/** Take whatever number `agentId` had off it: the agent is gone. */
export function clearAgentNumber(storage: DurableObjectStorage, agentId: string) {
  storage.sql.exec(`UPDATE phone_numbers SET agent_id = '' WHERE agent_id = ?`, agentId);
}

/** `ts` moved by whole calendar months (negative goes back), in UTC. */
export function addMonths(ts: number, months: number): number {
  const d = new Date(ts);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.getTime();
}

/**
 * Deliver a paid purchase as a number bought from Twilio, kept `term` months from `now`.
 * The wallet's ceiling is not applied: the number is paid for (the order refused a full
 * wallet). Undefined when the purchase is not paid and undelivered.
 */
export function fulfilNumber(
  storage: DurableObjectStorage,
  purchaseId: string,
  bought: { sid: string; number: string },
  term: number,
  now: number
): PhoneNumberRow | undefined {
  return storage.transactionSync(() => {
    const p = paidRow(storage, purchaseId);
    if (!p) return undefined;
    const row = addPhoneNumber(
      storage,
      p.email,
      { number: bought.number, kind: "bought", twilio_sid: bought.sid, expires_at: addMonths(now, term) },
      Infinity
    );
    if ("error" in row) return undefined;
    storage.sql.exec(
      `UPDATE wallet_purchases SET status = 'fulfilled', key_id = ? WHERE id = ?`,
      row.id,
      purchaseId
    );
    return row;
  });
}

/**
 * Deliver a paid renewal: `term` more months on the number it names, counted from when
 * the current term ends (or from `now`, once it has). "gone" when the number was
 * released before the payment landed; undefined when the purchase is not paid and
 * undelivered.
 */
export function renewNumber(
  storage: DurableObjectStorage,
  purchaseId: string,
  term: number,
  now: number
): PhoneNumberRow | "gone" | undefined {
  return storage.transactionSync(() => {
    const p = paidRow(storage, purchaseId);
    if (!p) return undefined;
    const row = phoneNumbers(storage, p.email).find((n) => n.id === p.key_id && n.kind === "bought");
    if (!row) return "gone";
    const expires = addMonths(Math.max(row.expires_at, now), term);
    storage.sql.exec(
      `UPDATE phone_numbers SET expires_at = ?, reminded_at = 0 WHERE id = ?`,
      expires,
      row.id
    );
    storage.sql.exec(`UPDATE wallet_purchases SET status = 'fulfilled' WHERE id = ?`, purchaseId);
    return { ...row, expires_at: expires, reminded_at: 0 };
  });
}

/** Bought numbers whose paid time has run out by `now`, whoever holds them. */
export function expiredNumbers(storage: DurableObjectStorage, now: number): PhoneNumberRow[] {
  return storage.sql
    .exec(
      `SELECT * FROM phone_numbers WHERE kind = 'bought' AND expires_at > 0 AND expires_at <= ?`,
      now
    )
    .toArray() as unknown as PhoneNumberRow[];
}

/** When the next bought number runs out; undefined when none is held. */
export function nextExpiry(storage: DurableObjectStorage): number | undefined {
  const row = storage.sql
    .exec(`SELECT MIN(expires_at) AS at FROM phone_numbers WHERE kind = 'bought' AND expires_at > 0`)
    .toArray()[0] as { at: number | null } | undefined;
  return row?.at ?? undefined;
}

/** Drop a number, whoever holds it: once it has been released at Twilio. */
export function dropNumber(storage: DurableObjectStorage, id: string) {
  storage.sql.exec(`DELETE FROM phone_numbers WHERE id = ?`, id);
}

/** One number by its id, whoever holds it. */
export function phoneNumber(storage: DurableObjectStorage, id: string): PhoneNumberRow | undefined {
  return storage.sql.exec(`SELECT * FROM phone_numbers WHERE id = ?`, id).toArray()[0] as unknown as
    | PhoneNumberRow
    | undefined;
}

const SETUP_COLUMNS = Object.keys(NO_SETUP) as (keyof WhatsappSetup)[];

/** Save part of a number's WhatsApp for Business setup. */
export function saveWhatsappSetup(
  storage: DurableObjectStorage,
  id: string,
  patch: Partial<WhatsappSetup>
) {
  const names = SETUP_COLUMNS.filter((c) => patch[c] !== undefined);
  if (!names.length) return;
  storage.sql.exec(
    `UPDATE phone_numbers SET ${names.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`,
    ...names.map((c) => patch[c] as string | number),
    id
  );
}

/**
 * The code in a text Meta sends to verify a number ("123-456 is your WhatsApp code"),
 * as six digits; the text itself, trimmed, when no code is found in it.
 */
export function codeIn(text: string): string {
  const m = text.match(/(?<!\d)(\d{3})[\s-]?(\d{3})(?!\d)/);
  return m ? m[1] + m[2] : text.trim().slice(0, 160);
}
