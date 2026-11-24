import { createRoute, z } from "@hono/zod-openapi";
import { type ApiApp, jsonOf, refusals } from "../api/app";
import type { Env } from "../env";
import type { PhoneNumberRow } from "../registry";
import { codeIn } from "../registry/phone-numbers";
import {
  createSender,
  createSubaccount,
  fetchSender,
  moveNumber,
  setSmsUrl,
  subaccountKeys,
  TwilioError,
  twilioOpen,
  twilioSignatureValid,
} from "../twilio";
import { ApiError } from "../worker/http";
import { directory } from "../worker/stores";
import { type AgentCall, AgentParams, agentRoute, may } from "./agent";

/**
 * Connecting an agent's number to WhatsApp for Business, one business at a time:
 *
 * 1. `prepare`: the business gets a Twilio subaccount of its own (Twilio maps one WABA
 *    to one account). A bought number moves into it, and its texts are posted to the
 *    Worker, so the code Meta texts it can be shown on the card.
 * 2. The card runs Meta's Embedded Signup. The user makes (or picks) their business's
 *    WABA there and verifies the number with that code; Meta hands back the WABA's id.
 * 3. `connect`: the number is registered as a WhatsApp sender in that WABA, at Twilio.
 */

/** How long a texted code is shown for: Meta's codes don't outlive this. */
const CODE_TTL_MS = 10 * 60 * 1000;

/** Sender statuses past which Twilio's answer won't change by itself. */
const SETTLED = new Set(["ONLINE", "OFFLINE"]);

const WhatsappBusinessSchema = z
  .object({
    /** The agent's number; null while it has none. */
    number: z
      .object({ id: z.string(), number: z.string(), kind: z.enum(["own", "bought"]) })
      .nullable(),
    /** "" not started; "account"/"ready" signup can run; "sender" registered at Twilio. */
    stage: z.enum(["", "account", "ready", "sender"]),
    /** Twilio's status for the sender (CREATING, ONLINE, …); "" before there is one. */
    status: z.string(),
    /** The code last texted to a bought number, while still fresh; "" otherwise. */
    code: z.string(),
    /** Whether the caller holds the number, so may connect it. */
    owner: z.boolean(),
    /** Meta's Embedded Signup ids; blank while the deployment hasn't set them. */
    signup: z.object({ app_id: z.string(), config_id: z.string(), solution_id: z.string() }),
  })
  .openapi("WhatsappBusiness");

const ConnectSchema = z.object({
  /** The WABA's id, from Embedded Signup's FINISH message. */
  waba_id: z.string().regex(/^\d{1,32}$/, "That isn't a WhatsApp Business account id."),
  /** The business's display name on WhatsApp, as given in signup. */
  display_name: z.string().trim().min(1, "Give the business's display name.").max(255),
});

async function view({ env, agentId, email }: AgentCall, refresh = true) {
  const dir = directory(env);
  const signup = await dir.whatsappSignup();
  let row = await dir.agentPhoneNumber(agentId);
  if (row && refresh) row = await refreshStatus(env, row);
  const fresh = row && row.wa_code && Date.now() - row.wa_code_at < CODE_TTL_MS;
  return {
    number: row ? { id: row.id, number: row.number, kind: row.kind } : null,
    stage: row?.wa_stage ?? "",
    status: row?.wa_sender_status ?? "",
    code: fresh ? row!.wa_code : "",
    owner: Boolean(row && row.email === email),
    signup,
  };
}

/** Ask Twilio where a registering sender has got to; the row as it stands on failure. */
async function refreshStatus(env: Env, row: PhoneNumberRow): Promise<PhoneNumberRow> {
  if (row.wa_stage !== "sender" || SETTLED.has(row.wa_sender_status)) return row;
  try {
    const s = await fetchSender(subaccountKeys(row.wa_account_sid, row.wa_account_token), row.wa_sender_sid);
    if (s.status !== row.wa_sender_status) {
      await directory(env).saveWhatsappSetup(row.id, { wa_sender_status: s.status });
    }
    return { ...row, wa_sender_status: s.status };
  } catch (err) {
    if (err instanceof TwilioError) return row;
    throw err;
  }
}

/** The agent's number, which the caller must hold to connect it. */
async function ownedNumber({ env, agentId, email }: AgentCall): Promise<PhoneNumberRow> {
  const row = await directory(env).agentPhoneNumber(agentId);
  if (!row) throw new ApiError(400, "Choose a number for this agent first.");
  if (row.email !== email) throw new ApiError(403, "Only the number's owner can connect it.");
  return row;
}

const twilioFailed = (err: unknown): never => {
  if (err instanceof TwilioError) throw new ApiError(502, err.message);
  throw err;
};

/** Step 1: the business's subaccount, with a bought number moved in and its texts read. */
async function prepare(call: AgentCall) {
  const { env, url } = call;
  const dir = directory(env);
  const row = await ownedNumber(call);
  if (row.wa_stage === "ready" || row.wa_stage === "sender") return;
  const keys = await dir.twilioKeys();
  if (!twilioOpen(keys)) throw new ApiError(502, "WhatsApp for Business isn't open yet.");
  try {
    let { wa_account_sid: sid, wa_account_token: token } = row;
    if (!sid) {
      // Saved at once, so a retry reuses it rather than opening a second account.
      ({ sid, auth_token: token } = await createSubaccount(keys, `Salts +${row.number}`));
      await dir.saveWhatsappSetup(row.id, {
        wa_stage: "account",
        wa_account_sid: sid,
        wa_account_token: token,
      });
    }
    // The user's own number gets Meta's code on their own phone: nothing to move.
    if (row.kind !== "bought") return;
    await moveNumber(keys, row.twilio_sid, sid);
    const sub = subaccountKeys(sid, token);
    await setSmsUrl(sub, row.twilio_sid, `${url.origin}/twilio/sms/${row.id}`);
    await dir.saveWhatsappSetup(row.id, { wa_stage: "ready" });
  } catch (err) {
    twilioFailed(err);
  }
}

/** Step 3: register the number as a sender in the WABA Embedded Signup made. */
async function connect(call: AgentCall, body: z.infer<typeof ConnectSchema>) {
  const dir = directory(call.env);
  const row = await ownedNumber(call);
  if (row.wa_stage === "sender") throw new ApiError(409, "This number is already connected.");
  const ready = row.kind === "bought" ? row.wa_stage === "ready" : row.wa_stage === "account";
  if (!ready) throw new ApiError(400, "Start connecting the number first.");
  try {
    const s = await createSender(
      subaccountKeys(row.wa_account_sid, row.wa_account_token),
      row.number,
      body.waba_id,
      body.display_name
    );
    await dir.saveWhatsappSetup(row.id, {
      wa_stage: "sender",
      waba_id: body.waba_id,
      wa_sender_sid: s.sid,
      wa_sender_status: s.status,
    });
  } catch (err) {
    twilioFailed(err);
  }
}

export function whatsappBusinessRoutes(app: ApiApp) {
  app.openapi(
    createRoute({
      method: "get",
      path: "/api/agents/{agentId}/whatsapp-business",
      tags: ["Settings"],
      summary: "Where the agent's number is in joining WhatsApp for Business",
      middleware: [agentRoute(may.member)] as const,
      request: { params: AgentParams },
      responses: { 200: jsonOf(WhatsappBusinessSchema), ...refusals(404) },
    }),
    async (c) => c.json(await view(c.var.call), 200)
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/agents/{agentId}/whatsapp-business/prepare",
      tags: ["Settings"],
      summary: "Get the agent's number ready for Meta's signup",
      description:
        "Opens the business's Twilio account and, for a bought number, moves it there so the code Meta texts it shows here. Safe to repeat.",
      middleware: [agentRoute(may.member)] as const,
      request: { params: AgentParams },
      responses: { 200: jsonOf(WhatsappBusinessSchema), ...refusals(400, 403, 404, 502) },
    }),
    async (c) => {
      await prepare(c.var.call);
      return c.json(await view(c.var.call, false), 200);
    }
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/agents/{agentId}/whatsapp-business/connect",
      tags: ["Settings"],
      summary: "Register the agent's number in the business's WhatsApp Business account",
      description: "`waba_id` is the id Meta's Embedded Signup returns.",
      middleware: [agentRoute(may.member)] as const,
      request: {
        params: AgentParams,
        body: { content: { "application/json": { schema: ConnectSchema } } },
      },
      responses: { 200: jsonOf(WhatsappBusinessSchema), ...refusals(400, 403, 404, 409, 502) },
    }),
    async (c) => {
      await connect(c.var.call, c.req.valid("json"));
      return c.json(await view(c.var.call, false), 200);
    }
  );
}

/**
 * Twilio posts the texts a bought number receives here (`/twilio/sms/{numberId}`), signed
 * with its subaccount's auth token. The code in one is kept for the card to show.
 */
export async function handleTwilioSms(
  request: Request,
  env: Env,
  numberId: string
): Promise<Response> {
  const dir = directory(env);
  const row = await dir.phoneNumber(numberId);
  const params = new URLSearchParams(new TextDecoder().decode(await request.arrayBuffer()));
  const signed =
    row &&
    (await twilioSignatureValid(
      row.wa_account_token,
      request.url,
      params,
      request.headers.get("x-twilio-signature") ?? ""
    ));
  if (!row || !signed) return new Response("forbidden", { status: 403 });
  const body = params.get("Body") ?? "";
  if (body) await dir.saveWhatsappSetup(row.id, { wa_code: codeIn(body), wa_code_at: Date.now() });
  // An empty reply: Twilio texts nothing back.
  return new Response("<Response/>", { headers: { "content-type": "text/xml" } });
}
