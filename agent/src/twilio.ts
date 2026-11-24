/**
 * Twilio, for WhatsApp for Business: US numbers are bought, kept for their paid term and
 * released; each number's business gets a subaccount of its own (Twilio maps one WABA to
 * one account), and its number is registered there as a WhatsApp sender.
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

const SENDERS = "https://messaging.twilio.com/v2/Channels/Senders";

async function call(keys: TwilioKeys, path: string, init: RequestInit = {}): Promise<Response> {
  return callUrl(keys, `${API}/Accounts/${encodeURIComponent(keys.account_sid)}${path}`, init);
}

async function callUrl(keys: TwilioKeys, url: string, init: RequestInit = {}): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, {
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

const form = (fields: Record<string, string>): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(fields).toString(),
});

/**
 * The credentials that act on a number: its business's subaccount once a bought number
 * has moved there, the deployment's account otherwise.
 */
export const numberKeys = (
  keys: TwilioKeys,
  n: { kind: string; wa_stage: string; wa_account_sid: string; wa_account_token: string }
): TwilioKeys =>
  n.kind === "bought" && (n.wa_stage === "ready" || n.wa_stage === "sender")
    ? subaccountKeys(n.wa_account_sid, n.wa_account_token)
    : keys;

/** Credentials that act as one subaccount: its SID, with its auth token as the secret. */
export const subaccountKeys = (sid: string, token: string): TwilioKeys => ({
  account_sid: sid,
  api_key_sid: sid,
  api_key_secret: token,
});

/**
 * A new subaccount under the deployment's account. Twilio only lets the account itself
 * do this: its SID and auth token, not an API key.
 */
export async function createSubaccount(
  keys: TwilioKeys,
  name: string
): Promise<{ sid: string; auth_token: string }> {
  const res = await callUrl(keys, `${API}/Accounts.json`, form({ FriendlyName: name.slice(0, 64) }));
  if (!res.ok) throw await failure(res, "Couldn't open a Twilio account for this business.");
  const row = (await res.json()) as { sid?: string; auth_token?: string };
  if (!row.sid || !row.auth_token) throw new TwilioError("Twilio didn't return the new account.");
  return { sid: row.sid, auth_token: row.auth_token };
}

/** Move a number the deployment's account holds into one of its subaccounts. */
export async function moveNumber(keys: TwilioKeys, numberSid: string, toAccount: string) {
  const res = await call(
    keys,
    `/IncomingPhoneNumbers/${encodeURIComponent(numberSid)}.json`,
    form({ AccountSid: toAccount })
  );
  if (!res.ok) throw await failure(res, "Couldn't move the number to this business's account.");
}

/** Have Twilio post the texts a number receives to `url`. */
export async function setSmsUrl(keys: TwilioKeys, numberSid: string, url: string) {
  const res = await call(
    keys,
    `/IncomingPhoneNumbers/${encodeURIComponent(numberSid)}.json`,
    form({ SmsUrl: url, SmsMethod: "POST" })
  );
  if (!res.ok) throw await failure(res, "Couldn't set where the number's texts go.");
}

/** A WhatsApp sender at Twilio, and where it is in being registered. */
export type Sender = { sid: string; status: string };

const sender = async (res: Response, fallback: string): Promise<Sender> => {
  if (!res.ok) throw await failure(res, fallback);
  const row = (await res.json()) as { sid?: string; status?: string };
  if (!row.sid) throw new TwilioError("Twilio didn't return the sender.");
  return { sid: row.sid, status: row.status ?? "" };
};

/**
 * Register `number` (digits) on WhatsApp in the business's WABA, shown as `name`.
 * Twilio does this in the background: the sender starts CREATING.
 */
export async function createSender(
  keys: TwilioKeys,
  number: string,
  wabaId: string,
  name: string
): Promise<Sender> {
  const res = await callUrl(keys, SENDERS, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sender_id: `whatsapp:+${number}`,
      configuration: { waba_id: wabaId },
      profile: { name },
    }),
  });
  return sender(res, "Couldn't register the number on WhatsApp.");
}

/** Where a sender is now. */
export async function fetchSender(keys: TwilioKeys, sid: string): Promise<Sender> {
  return sender(
    await callUrl(keys, `${SENDERS}/${encodeURIComponent(sid)}`),
    "Couldn't read the number's WhatsApp status."
  );
}

/**
 * Whether `signature` (the X-Twilio-Signature header) is Twilio's for a form post of
 * `params` to `url`: HMAC-SHA1 under the account's auth token, over the URL followed by
 * each parameter's name and value, sorted by name.
 */
export async function twilioSignatureValid(
  authToken: string,
  url: string,
  params: URLSearchParams,
  signature: string
): Promise<boolean> {
  if (!authToken || !signature) return false;
  const data =
    url +
    [...params.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => k + v)
      .join("");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(authToken),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)));
  const expected = btoa(String.fromCharCode(...mac));
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}
