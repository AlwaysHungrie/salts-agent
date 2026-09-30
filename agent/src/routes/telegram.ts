import type { Env } from "../env";
import { sessionLimitMessage } from "../registry";
import { deploymentSettings } from "../settings";
import { allowedBy, chatTitle, Telegram, type TelegramUpdate, topicId } from "../telegram";
import { webhookSecret } from "../worker/integrations";
import { callSession, readConfig, registry, syncSessionCount } from "../worker/stores";

/**
 * One Telegram update for one agent: resolve (or create) the chat's session and hand the
 * message over, after a fast 200 so Telegram does not retry. Each bot has its own route.
 */
export async function handleWebhook(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  agentId: string
): Promise<Response> {
  const reg = registry(env, agentId);
  const config = await readConfig(env, reg);
  if (!config.cap_telegram || !config.telegram_bot_token) {
    return new Response("telegram is off", { status: 404 });
  }
  const offered = request.headers.get("x-telegram-bot-api-secret-token") ?? "";
  if (offered !== (await webhookSecret(config.telegram_bot_token))) {
    return new Response("bad secret", { status: 401 });
  }

  const update = (await request.json().catch(() => null)) as TelegramUpdate | null;
  const message = update?.message;
  // Edits are ignored: answering them again would double every correction.
  if (!message?.chat) return new Response("ok");

  const chatId = String(message.chat.id);
  // A forum topic is a conversation of its own, so it keys a session of its own.
  const topic = topicId(message);
  const threadId = topic ? String(topic) : "";

  // Whitelists: a DM is judged by sender, a group by chat and topic. Others are dropped
  // before any session exists.
  const allowed =
    message.chat.type === "private"
      ? allowedBy(config.telegram_user_whitelist, [
          message.from?.username,
          message.from?.id !== undefined ? String(message.from.id) : undefined,
        ])
      : allowedBy(config.telegram_group_whitelist, [
          threadId ? `${chatId}:${threadId}` : chatId,
          chatId,
          message.chat.username,
        ]);
  if (!allowed) return new Response("ok");

  const existing = await reg.forChat(chatId, threadId);
  const sessionId = existing?.id ?? (await reg.freeChatSessionId(agentId, chatId, threadId));
  if (!existing) {
    // A full agent says so in the chat rather than going silent.
    const { max_sessions: telegramSessionCap } = await deploymentSettings(env);
    if ((await reg.countSessions()) >= telegramSessionCap) {
      const config = await readConfig(env, reg);
      if (config.telegram_bot_token) {
        await new Telegram(config.telegram_bot_token, env.TELEGRAM_API_BASE)
          .send(
            chatId,
            sessionLimitMessage(telegramSessionCap),
            message.message_id,
            Number(threadId) || undefined
          )
          .catch(() => {
            // Nothing to do about a chat that cannot be reached.
          });
      }
      return new Response("ok");
    }
    await reg.create(
      sessionId,
      chatTitle(message),
      env.SessionAgent.idFromName(sessionId).toString(),
      {
        source: "telegram",
        chat_id: chatId,
        chat_type: message.chat.type,
        // A public group links by handle; a private one links by its internal id.
        chat_username: message.chat.type === "private" ? "" : (message.chat.username ?? ""),
        chat_thread_id: threadId,
      },
      telegramSessionCap
    );
    await syncSessionCount(env, agentId);
  }
  await reg.touch(sessionId);

  const url = new URL(request.url);
  const turn = callSession(env, url.origin, sessionId, "telegram", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(message),
  });
  // Telegram is told the update landed straight away; the answer arrives in the chat.
  ctx.waitUntil(turn);
  return new Response("ok", { headers: { "x-session": sessionId } });
}
