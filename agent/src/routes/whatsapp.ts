import type { Env } from "../agent";
import { enabled } from "../capabilities";
import { sessionLimitMessage } from "../registry";
import { deploymentSettings } from "../settings";
import {
  inboundOf,
  isOwnNumber,
  verifySignature,
  WhatsApp,
  chatTitle as whatsappChatTitle,
  type WhatsappPayload,
} from "../whatsapp";
import { callSession, readConfig, registry, syncSessionCount } from "../worker/stores";

/**
 * Meta's subscription handshake. Saving the callback URL in the dashboard makes this
 * exact call, and the field is only subscribed if the challenge comes back verbatim
 * as plain text.
 */

export function whatsappVerify(url: URL, verifyToken: string): Response {
  const mode = url.searchParams.get("hub.mode");
  const offered = url.searchParams.get("hub.verify_token") ?? "";
  const challenge = url.searchParams.get("hub.challenge") ?? "";
  if (mode !== "subscribe" || offered !== verifyToken) {
    return new Response("forbidden", { status: 403 });
  }
  return new Response(challenge, {
    status: 200,
    headers: { "content-type": "text/plain" },
  });
}

/**
 * One delivery from WhatsApp, for one agent. The sender's number is resolved to that
 * agent's session — created on first contact — and the message is handed to the
 * session's own object, which answers in the chat itself.
 *
 * Every agent is a different Meta app with its own number and its own secret, so each
 * has its own route, exactly as Telegram does. What differs is that Meta has no API
 * for setting a callback URL: there is no `syncWebhook` here, and the owner pastes
 * this route into the dashboard by hand. That is what the setup guide is for.
 *
 * Meta retries anything that is not a fast 200, so the turn runs after the response
 * rather than under it — and every delivery is claimed first, or a retry issued while
 * the first turn is still thinking would be answered twice.
 */
export async function handleWhatsappWebhook(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  url: URL,
  agentId: string
): Promise<Response> {
  const reg = registry(env, agentId);
  const config = await readConfig(env, reg);
  // Every field is required, so `enabled` is also the answer to "is this agent's
  // WhatsApp set up". A half-filled one answers the handshake and then fails to
  // verify a signature, which looks like Meta's fault.
  if (!enabled(config, "whatsapp")) return new Response("whatsapp is off", { status: 404 });

  if (request.method === "GET") return whatsappVerify(url, config.whatsapp_verify_token);

  // The body has to be read as text and verified before it is parsed: the signature
  // covers the bytes Meta sent, and re-serialising the parsed JSON is not those bytes.
  const raw = await request.text();
  const signed = await verifySignature(
    config.whatsapp_app_secret,
    raw,
    request.headers.get("x-hub-signature-256")
  );
  if (!signed) return new Response("bad signature", { status: 401 });

  const payload = (() => {
    try {
      return JSON.parse(raw) as WhatsappPayload;
    } catch {
      return null;
    }
  })();
  const inbound = inboundOf(payload);
  // A status receipt — sent, delivered, read — carries no message. Answering one
  // would mean answering the agent's own replies.
  if (!inbound) return new Response("ok");

  // One number, and it is the owner's. Anyone else gets no answer and no session.
  if (!isOwnNumber(config.whatsapp_number, inbound.from)) return new Response("ok");

  // A retry of a message already taken is not an error and must not be one: Meta
  // reads a non-200 as a reason to try again.
  if (!(await reg.claimWhatsappEvent(inbound.message.id))) {
    return new Response("ok", { headers: { "x-whatsapp": "duplicate" } });
  }

  // `wa:` keeps a number that happens to match a Telegram chat id out of that chat's
  // session, since `forChat` matches on the stored id alone.
  const chatId = `wa:${inbound.from}`;
  const existing = await reg.forChat(chatId);
  const sessionId = existing?.id ?? (await reg.freeChatSessionId(agentId, inbound.from, "", "wa"));
  if (!existing) {
    const { max_sessions: whatsappSessionCap } = await deploymentSettings(env);
    if ((await reg.countSessions()) >= whatsappSessionCap) {
      // Said in the chat rather than swallowed, for the same reason as Telegram: to
      // whoever is typing, an agent that answers nothing is a broken one.
      await new WhatsApp(
        config.whatsapp_access_token,
        config.whatsapp_phone_number_id,
        env.WHATSAPP_API_BASE
      )
        .send(inbound.from, sessionLimitMessage(whatsappSessionCap), inbound.message.id)
        .catch(() => {
          // Nothing to do about a chat that cannot be reached.
        });
      return new Response("ok");
    }
    await reg.create(
      sessionId,
      whatsappChatTitle(inbound),
      env.SessionAgent.idFromName(sessionId).toString(),
      {
        source: "whatsapp",
        chat_id: chatId,
        chat_type: "private",
        // WhatsApp has no handles, so this column carries the business number the
        // message was sent to. It is what "continue on WhatsApp" links at, the same
        // way a Telegram group's @handle is.
        chat_username: inbound.businessNumber,
        // Cloud API group messaging needs an Official Business Account, so every
        // conversation here is one person.
        chat_thread_id: "",
      },
      whatsappSessionCap
    );
    await syncSessionCount(env, agentId);
  }
  await reg.touch(sessionId);

  const turn = callSession(env, url.origin, sessionId, "whatsapp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(inbound),
  });
  ctx.waitUntil(turn);
  return new Response("ok", { headers: { "x-session": sessionId } });
}
