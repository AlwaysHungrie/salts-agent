import type { Env } from "../env";
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

/** Meta's subscription handshake: echo the challenge as plain text. */

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
 * One WhatsApp delivery for one agent: resolve (or create) the sender's session and hand
 * it over after a fast 200. Each delivery is claimed first so a retry is not answered twice.
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
  // `enabled` requires every field, so a half-configured agent is treated as off.
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
        // The business number, which "continue on WhatsApp" links to.
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
