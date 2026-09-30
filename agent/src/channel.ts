/**
 * A chat channel as a turn sees one. Telegram and WhatsApp differ on the wire but run the
 * same turn steps; a channel omits what it cannot do (no `sendVoice` = no voice notes).
 */

import { enabled } from "./capabilities";
import type { Config, SessionRow } from "./registry";
import {
  Telegram,
  addressesBot,
  messageFiles,
  messageTextWithQuote,
  topicId,
  type TelegramMessage,
} from "./telegram";
import { OUTSIDE_WINDOW, WhatsApp, WhatsappError, type WhatsappInbound } from "./whatsapp";

/** Which wire a session talks over. The registry stores this as a session's `source`. */
export type ChannelId = "telegram" | "whatsapp";

/** Voice notes must be Ogg Opus on both channels; anything else arrives as a file. */
export const VOICE_MIME = "audio/ogg";

/**
 * Whether these bytes are Ogg Opus (`OggS` page, `OpusHead` payload). Checked because a
 * mismatched upload is accepted but will not play on the phone.
 */
export function isVoiceNote(bytes: ArrayBuffer): boolean {
  const head = new Uint8Array(bytes.slice(0, 64));
  const text = String.fromCharCode(...head);
  return text.startsWith("OggS") && text.includes("OpusHead");
}

/**
 * Sent when a task is scheduled on WhatsApp: Meta only allows free-form messages within
 * 24 hours of the user's last one, so a later delivery may fail. Telegram has no such rule.
 */
export const WHATSAPP_WINDOW_NOTICE =
  "Meta policy disallows me to send you a message if we don't have an active chat session. To ensure scheduled messages reach you, send me a message every 24 hours.";

/** One conversation. `replyTo` quotes the question; absent on scheduled replies. */
export type ChannelTarget = {
  /** Telegram: the chat id. WhatsApp: the number, digits only. */
  to: string;
  /** A Telegram forum topic. A conversation inside a conversation; nothing else has one. */
  threadId?: number;
  /** The inbound message being answered: a Telegram message id, or a `wamid`. */
  replyTo?: string;
};

/**
 * A file that arrived with a message. `read` is lazy so a file over the storage ceiling
 * is dropped without being downloaded.
 */
export type ChannelFile = {
  name: string;
  mime: string;
  /** What the channel says it weighs, before it is fetched. 0 when it does not say. */
  size: number;
  read: () => Promise<ArrayBuffer>;
};

/** One inbound message, reduced to what a turn needs and told which wire to answer on. */
export type ChannelInbound = {
  channel: Channel;
  target: ChannelTarget;
  /** What was said, with any quoted message already folded in. */
  text: string;
  files: ChannelFile[];
};

/**
 * A channel the turn loop can talk to. Features check the optional members, never `id`
 * (which is for logs and the registry's `source`).
 */
export type Channel = {
  id: ChannelId;
  /** Look busy. Best effort: a turn that failed to look busy must not fail. */
  typing: (target: ChannelTarget) => Promise<void>;
  /** Send a reply, split by the channel at its own length limit. */
  sendText: (target: ChannelTarget, text: string) => Promise<void>;
  /** Send an image the agent drew. Absent on a channel that cannot carry one. */
  sendImage?: (
    target: ChannelTarget,
    bytes: ArrayBuffer,
    name: string,
    caption: string
  ) => Promise<void>;
  /** Send a voice note. The bytes are Ogg Opus; see `VOICE_MIME`. */
  sendVoice?: (target: ChannelTarget, bytes: ArrayBuffer) => Promise<void>;
  /** A line this channel owes the user whenever a task is scheduled. */
  scheduledNotice?: string;
  /**
   * Why this error means the chat is unreachable for good, if it does: no retry or apology,
   * since the apology would be refused too.
   */
  unreachable: (err: unknown) => string | undefined;
  /** Where a reply with no inbound message goes: the conversation this session is. */
  targetOf: (row: SessionRow) => ChannelTarget | undefined;
};

/** The API hosts, which the tests point at stand-ins. */
export type ChannelEnv = {
  TELEGRAM_API_BASE?: string;
  WHATSAPP_API_BASE?: string;
};

/** A channel, or the reason there is none (callers log it or hand it to the model). */
export type OpenedChannel =
  { channel: Channel; reason?: never } | { channel?: never; reason: string };

export function openChannel(source: string, config: Config, env: ChannelEnv): OpenedChannel {
  if (source === "telegram") {
    if (!enabled(config, "telegram")) return { reason: "telegram is not set up on this agent" };
    if (!config.telegram_bot_token) return { reason: "the Telegram bot token is missing" };
    return { channel: telegramChannel(config, env) };
  }
  if (source === "whatsapp") {
    if (!enabled(config, "whatsapp")) return { reason: "whatsapp is not set up on this agent" };
    if (!config.whatsapp_access_token || !config.whatsapp_phone_number_id) {
      return { reason: "the WhatsApp credentials are missing" };
    }
    return { channel: whatsappChannel(config, env) };
  }
  // A browser session. The reply is streamed to the page that asked for it and drawn
  // images are attachments in the transcript, so there is nothing to send anywhere.
  return { reason: `this conversation is not on a chat channel` };
}

/* ---------------------------------------------------------------- telegram -- */

function telegramChannel(config: Config, env: ChannelEnv): Channel {
  const bot = new Telegram(config.telegram_bot_token, env.TELEGRAM_API_BASE);
  return {
    id: "telegram",
    typing: (target) => bot.typing(target.to, target.threadId),
    sendText: async (target, text) => {
      await bot.send(target.to, text, Number(target.replyTo) || undefined, target.threadId);
    },
    sendImage: async (target, bytes, name, caption) => {
      await bot.sendPhoto(target.to, bytes, name, caption, target.threadId);
    },
    sendVoice: async (target, bytes) => {
      if (!isVoiceNote(bytes)) throw new Error(NOT_A_VOICE_NOTE);
      await bot.sendVoice(target.to, bytes, target.threadId);
    },
    // Telegram delivers or it errors; there is no state it refuses from.
    unreachable: () => undefined,
    targetOf: (row) =>
      row.chat_id
        ? // The topic is stored as text; a chat without topics keeps it empty.
          { to: row.chat_id, threadId: Number(row.chat_thread_id) || undefined }
        : undefined,
  };
}

/**
 * One Telegram update as a turn reads it, or why it is not for us. One client serves all its files.
 */
export function telegramInbound(
  message: TelegramMessage,
  config: Config,
  env: ChannelEnv
): ChannelInbound | { skipped: string } {
  const opened = openChannel("telegram", config, env);
  if (!opened.channel) return { skipped: opened.reason };
  if (!addressesBot(message, config.telegram_bot_username)) {
    // A group message that does not name the bot is not for it.
    return { skipped: "not addressed" };
  }
  const bot = new Telegram(config.telegram_bot_token, env.TELEGRAM_API_BASE);
  return {
    channel: opened.channel,
    target: {
      to: String(message.chat.id),
      // Without the topic an answer surfaces in the group's General topic rather than
      // in the one that asked.
      threadId: topicId(message) || undefined,
      replyTo: String(message.message_id),
    },
    text: messageTextWithQuote(message) || "(no text)",
    files: messageFiles(message).map((file) => ({
      name: file.name,
      mime: file.mime,
      size: file.size,
      read: () => bot.download(file.file_id),
    })),
  };
}

/* ---------------------------------------------------------------- whatsapp -- */

function whatsappChannel(config: Config, env: ChannelEnv): Channel {
  const chat = new WhatsApp(
    config.whatsapp_access_token,
    config.whatsapp_phone_number_id,
    env.WHATSAPP_API_BASE
  );
  return {
    id: "whatsapp",
    // Meta only offers the typing bubble as part of a read receipt, so there is
    // nothing to mark and nothing to show until a message has come in.
    typing: async (target) => {
      if (target.replyTo) await chat.typing(target.replyTo);
    },
    sendText: async (target, text) => {
      await chat.send(target.to, text, target.replyTo);
    },
    // Both of these are an upload followed by a send: Meta takes no bytes on the
    // message itself, only an id of something already in its media store.
    sendImage: async (target, bytes, name, caption) => {
      const mime = name.toLowerCase().endsWith(".jpg") ? "image/jpeg" : "image/png";
      await chat.sendImage(target.to, await chat.upload(bytes, mime, name), caption);
    },
    sendVoice: async (target, bytes) => {
      if (!isVoiceNote(bytes)) throw new Error(NOT_A_VOICE_NOTE);
      await chat.sendVoice(target.to, await chat.upload(bytes, VOICE_MIME, "voice-note.ogg"));
    },
    scheduledNotice: WHATSAPP_WINDOW_NOTICE,
    unreachable: (err) =>
      err instanceof WhatsappError && err.code === OUTSIDE_WINDOW
        ? "outside the 24-hour window"
        : undefined,
    targetOf: (row) => {
      // The chat id is `wa:<number>` — see the WhatsApp webhook in server.ts.
      const to = row.chat_id.startsWith("wa:") ? row.chat_id.slice(3) : row.chat_id;
      return to ? { to } : undefined;
    },
  };
}

/**
 * One WhatsApp delivery as a turn reads it. File sizes are 0: the webhook does not say,
 * and the turn weighs what it downloads.
 */
export function whatsappInbound(
  inbound: WhatsappInbound,
  config: Config,
  env: ChannelEnv
): ChannelInbound | { skipped: string } {
  const opened = openChannel("whatsapp", config, env);
  if (!opened.channel) return { skipped: opened.reason };
  const chat = new WhatsApp(
    config.whatsapp_access_token,
    config.whatsapp_phone_number_id,
    env.WHATSAPP_API_BASE
  );
  return {
    channel: opened.channel,
    target: { to: inbound.from, replyTo: inbound.message.id },
    text: inbound.text || "(no text)",
    files: (inbound.files ?? []).map((file) => ({
      name: file.name,
      mime: file.mime,
      size: 0,
      read: () => chat.download(file.id),
    })),
  };
}

/** Said to the model, which is the only party that can do anything about it. */
const NOT_A_VOICE_NOTE =
  "that audio is not Ogg Opus, which is the only kind a chat app plays as a voice note";
