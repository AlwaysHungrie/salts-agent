/**
 * Twilio, as a place to buy US phone numbers for WhatsApp for Business. Nothing is sent
 * through Twilio: a number is bought, kept for its paid term, and released.
 *
 * Authenticated with an API key (SK…) and its secret, which the owner can revoke without
 * touching the account; or with the account SID (AC…) and the account's auth token in
 * their place, which Twilio accepts the same way. The account SID names the account.
 */

const API = "https://api.twilio.com/2010-04-01";

export type TwilioKeys = { account_sid: string; api_key_sid: string; api_key_secret: string };

/** Twilio refused, or could not be reached; the message is fit to show. */
export class TwilioError extends Error {}

/** Whether all three credentials are set. */
export const twilioOpen = (keys: TwilioKeys) =>
  Boolean(keys.account_sid && keys.api_key_sid && keys.api_key_secret);

async function call(keys: TwilioKeys, path: string, init: RequestInit = {}): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`${API}/Accounts/${encodeURIComponent(keys.account_sid)}${path}`, {
      ...init,
      headers: {
        authorization: `Basic ${btoa(`${keys.api_key_sid}:${keys.api_key_secret}`)}`,
        ...(init.headers as Record<string, string> | undefined),
      },
    });
  } catch {
    throw new TwilioError("Couldn't reach Twilio.");
  }
  return res;
}

async function failure(res: Response, fallback: string): Promise<TwilioError> {
  const body = (await res.json().catch(() => null)) as { message?: string } | null;
  return new TwilioError(body?.message ? `Twilio: ${body.message}` : fallback);
}

/** Whether Twilio accepts these credentials together. */
export async function twilioKeysWork(keys: TwilioKeys): Promise<boolean> {
  try {
    return (await call(keys, ".json")).ok;
  } catch {
    return false;
  }
}

/**
 * Buy the first available US local number that takes texts and calls (Meta sends its
 * verification code by either). Returns Twilio's handle for it and the number as digits.
 */
export async function buyUsNumber(keys: TwilioKeys): Promise<{ sid: string; number: string }> {
  const search = await call(
    keys,
    "/AvailablePhoneNumbers/US/Local.json?SmsEnabled=true&VoiceEnabled=true&PageSize=1"
  );
  if (!search.ok) throw await failure(search, "Couldn't look up available numbers.");
  const found = ((await search.json()) as { available_phone_numbers?: { phone_number?: string }[] })
    .available_phone_numbers?.[0]?.phone_number;
  if (!found) throw new TwilioError("No US numbers are available right now.");

  const bought = await call(keys, "/IncomingPhoneNumbers.json", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ PhoneNumber: found }).toString(),
  });
  if (!bought.ok) throw await failure(bought, "Couldn't buy the number.");
  const row = (await bought.json()) as { sid?: string; phone_number?: string };
  if (!row.sid || !row.phone_number) throw new TwilioError("Twilio didn't say which number it bought.");
  return { sid: row.sid, number: row.phone_number.replace(/^\+/, "") };
}

/** Give a number back to Twilio. A number Twilio no longer has counts as released. */
export async function releaseNumber(keys: TwilioKeys, sid: string): Promise<void> {
  const res = await call(keys, `/IncomingPhoneNumbers/${encodeURIComponent(sid)}.json`, {
    method: "DELETE",
  });
  if (!res.ok && res.status !== 404) throw await failure(res, "Couldn't release the number.");
}
