/**
 * The Bot API, as much of it as the agent needs: read an update, pull down whatever
 * the user attached, and answer. Nothing here knows about sessions or turns.
 */

/** Telegram's own host. A local Bot API server can stand in through the Env var. */
export const TELEGRAM_API = "https://api.telegram.org";

/** The slice of Telegram's update shape this agent reads. */
export type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
};

export type TelegramMessage = {
  message_id: number;
  date: number;
  text?: string;
  caption?: string;
  chat: { id: number; type: string; title?: string; username?: string; first_name?: string };
  from?: { id: number; is_bot: boolean; first_name?: string; username?: string };
  entities?: { type: string; offset: number; length: number }[];
  /**
   * The forum topic, the second half of a conversation's identity. Absent outside forums
   * and in "General".
   */
  message_thread_id?: number;
  is_topic_message?: boolean;
  /**
   * The message this one replies to. Telegram sends only one level, already flattened,
   * so this shape does not recurse.
   */
  reply_to_message?: {
    message_id: number;
    text?: string;
    caption?: string;
    from?: { id: number; is_bot: boolean; first_name?: string; username?: string };
    /** Set when the reply target is the topic's opening service message: a title, not a quote. */
    forum_topic_created?: { name: string };
  };
  photo?: { file_id: string; file_size?: number; width: number; height: number }[];
  document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
  voice?: { file_id: string; mime_type?: string; file_size?: number; duration: number };
  audio?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
};

/** A file named in an update, resolved to something the agent can store. */
export type TelegramFile = {
  file_id: string;
  name: string;
  mime: string;
  size: number;
};

/** Telegram rejects a message over 4096 characters, so a long reply is split. */
const MESSAGE_LIMIT = 4096;

/** A quoted message is context, not the message, so it is shown only this far. */
const QUOTE_LIMIT = 300;

export class Telegram {
  constructor(
    private readonly token: string,
    private readonly api: string = TELEGRAM_API
  ) {}

  private async call<T>(method: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.api}/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as { ok: boolean; result: T; description?: string };
    if (!json.ok) throw new Error(`telegram ${method}: ${json.description ?? res.status}`);
    return json.result;
  }

  /**
   * Point the bot at this Worker. The secret token comes back on every update as a
   * header, and is what makes a webhook call trustworthy.
   */
  async setWebhook(url: string, secret: string): Promise<void> {
    await this.call("setWebhook", {
      url,
      secret_token: secret,
      allowed_updates: ["message"],
      drop_pending_updates: true,
    });
  }

  async deleteWebhook(): Promise<void> {
    await this.call("deleteWebhook", { drop_pending_updates: true });
  }

  /** Telegram's view of the webhook: target, queue and last error. */
  async webhookInfo(): Promise<{
    url: string;
    pending_update_count: number;
    last_error_date?: number;
    last_error_message?: string;
  }> {
    return await this.call("getWebhookInfo", {});
  }

  /** The bot's own username, so a group mention can be recognised. */
  async me(): Promise<{ id: number; username: string }> {
    return await this.call("getMe", {});
  }

  /** "Typing…", so a long turn does not look like a dropped message. */
  async typing(chatId: string, threadId?: number): Promise<void> {
    await this.call("sendChatAction", {
      chat_id: chatId,
      action: "typing",
      ...(threadId ? { message_thread_id: threadId } : {}),
    }).catch(() => {
      // Nothing depends on the indicator; a failure here must not fail the turn.
    });
  }

  /** Send a reply, split at Telegram's length limit. Returns the message ids sent. */
  async send(chatId: string, text: string, replyTo?: number, threadId?: number): Promise<number[]> {
    const ids: number[] = [];
    for (const chunk of split(text)) {
      const sent = await this.call<{ message_id: number }>("sendMessage", {
        chat_id: chatId,
        text: chunk,
        // Without the thread a reply lands in the group's General topic, not the one
        // that was talking.
        ...(threadId ? { message_thread_id: threadId } : {}),
        // Telegram's Markdown is strict enough that a stray underscore breaks the
        // whole message, so replies are sent as plain text.
        ...(replyTo && ids.length === 0
          ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } }
          : {}),
      });
      ids.push(sent.message_id);
    }
    return ids;
  }

  /** Send an image the agent drew. */
  async sendPhoto(
    chatId: string,
    bytes: ArrayBuffer,
    name: string,
    caption?: string,
    threadId?: number
  ) {
    const form = new FormData();
    form.set("chat_id", chatId);
    if (threadId) form.set("message_thread_id", String(threadId));
    if (caption) form.set("caption", caption.slice(0, 1000));
    form.set("photo", new Blob([bytes]), name);
    const res = await fetch(`${this.api}/bot${this.token}/sendPhoto`, {
      method: "POST",
      body: form,
    });
    if (!res.ok) throw new Error(`telegram sendPhoto: ${res.status} ${await res.text()}`);
  }

  /** Send a file the agent made (an exported workbook, a PDF) as a download. */
  async sendDocument(
    chatId: string,
    bytes: ArrayBuffer,
    name: string,
    mime: string,
    threadId?: number
  ) {
    const form = new FormData();
    form.set("chat_id", chatId);
    if (threadId) form.set("message_thread_id", String(threadId));
    form.set("document", new Blob([bytes], { type: mime }), name);
    const res = await fetch(`${this.api}/bot${this.token}/sendDocument`, {
      method: "POST",
      body: form,
    });
    if (!res.ok) throw new Error(`telegram sendDocument: ${res.status} ${await res.text()}`);
  }

  /** Send a voice note (`sendVoice`, not `sendAudio`): Ogg Opus shows as a waveform. */
  async sendVoice(chatId: string, bytes: ArrayBuffer, threadId?: number) {
    const form = new FormData();
    form.set("chat_id", chatId);
    if (threadId) form.set("message_thread_id", String(threadId));
    form.set("voice", new Blob([bytes], { type: "audio/ogg" }), "voice-note.ogg");
    const res = await fetch(`${this.api}/bot${this.token}/sendVoice`, {
      method: "POST",
      body: form,
    });
    if (!res.ok) throw new Error(`telegram sendVoice: ${res.status} ${await res.text()}`);
  }

  /** Download a file the user sent. Telegram serves it from a one-shot path. */
  async download(fileId: string): Promise<ArrayBuffer> {
    const file = await this.call<{ file_path: string }>("getFile", { file_id: fileId });
    const res = await fetch(`${this.api}/file/bot${this.token}/${file.file_path}`);
    if (!res.ok) throw new Error(`telegram download: ${res.status}`);
    return await res.arrayBuffer();
  }
}

/** Split on paragraph, then line, then hard. Shared with WhatsApp's same 4096 limit. */
export function split(text: string): string[] {
  if (text.length <= MESSAGE_LIMIT) return [text || "…"];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > MESSAGE_LIMIT) {
    const window = rest.slice(0, MESSAGE_LIMIT);
    const cut =
      window.lastIndexOf("\n\n") > 0
        ? window.lastIndexOf("\n\n")
        : window.lastIndexOf("\n") > 0
          ? window.lastIndexOf("\n")
          : MESSAGE_LIMIT;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/** The text of a message: its own, or the caption of whatever it carried. */
export function messageText(message: TelegramMessage): string {
  return (message.text ?? message.caption ?? "").trim();
}

/**
 * The forum topic a message belongs to, or 0 for a chat without topics. A forum's
 * "General" topic carries no thread id of its own, so it counts as the group itself.
 */
export function topicId(message: TelegramMessage): number {
  return message.is_topic_message ? (message.message_thread_id ?? 0) : 0;
}

/**
 * What identifies a conversation: the chat, and the topic inside it if there is one.
 * A group is one conversation; a forum is one conversation per topic.
 */
export function chatKey(message: TelegramMessage): string {
  const topic = topicId(message);
  return topic ? `${message.chat.id}:${topic}` : String(message.chat.id);
}

/** The replied-to message as a capped Markdown blockquote, or empty. */
export function quotedText(message: TelegramMessage): string {
  const parent = message.reply_to_message;
  // In a forum, the first message of a topic "replies" to the service message that
  // opened it. That is structure, not something anyone said.
  if (!parent || parent.forum_topic_created) return "";
  const body = (parent.text ?? parent.caption ?? "").trim();
  if (!body) return "";
  const who = parent.from?.first_name ?? parent.from?.username ?? "";
  const clipped = body.length > QUOTE_LIMIT ? `${body.slice(0, QUOTE_LIMIT).trimEnd()}…` : body;
  const lines = (who ? `${who}: ${clipped}` : clipped).split("\n");
  return lines.map((line) => `> ${line}`).join("\n");
}

/** A message as the agent reads it: the quoted context, then what was said. */
export function messageTextWithQuote(message: TelegramMessage): string {
  const quote = quotedText(message);
  const text = messageText(message);
  return [quote, text].filter((part) => part !== "").join("\n\n");
}

/**
 * Files attached to one message, largest photo size only — Telegram sends a ladder of
 * thumbnails and the last entry is the full-size one.
 */
export function messageFiles(message: TelegramMessage): TelegramFile[] {
  const files: TelegramFile[] = [];
  const photo = message.photo?.[message.photo.length - 1];
  if (photo) {
    files.push({
      file_id: photo.file_id,
      name: `photo-${message.message_id}.jpg`,
      mime: "image/jpeg",
      size: photo.file_size ?? 0,
    });
  }
  if (message.document) {
    files.push({
      file_id: message.document.file_id,
      name: message.document.file_name ?? `file-${message.message_id}`,
      mime: message.document.mime_type ?? "application/octet-stream",
      size: message.document.file_size ?? 0,
    });
  }
  const clip = message.voice ?? message.audio;
  if (clip) {
    files.push({
      file_id: clip.file_id,
      name:
        "file_name" in clip && clip.file_name ? clip.file_name : `voice-${message.message_id}.ogg`,
      mime: clip.mime_type ?? "audio/ogg",
      size: clip.file_size ?? 0,
    });
  }
  return files;
}

/**
 * Whether the bot should answer. A direct message is always for the bot; in a group it
 * answers when named, or when the message is a reply to something it said.
 */
export function addressesBot(message: TelegramMessage, botUsername: string): boolean {
  if (message.chat.type === "private") return true;
  const text = messageText(message).toLowerCase();
  return botUsername !== "" && text.includes(`@${botUsername.toLowerCase()}`);
}

/**
 * Whitelist entries, one per line: `/pattern/` is a regex over the whole value; anything
 * else is a case-insensitive match, leading @ ignored.
 */
export function whitelistEntries(list: string): string[] {
  return list
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

/**
 * Whether any of `candidates` is on the list. An empty list allows everything: the
 * capability is a switch, and a whitelist is the narrowing you opt into.
 */
export function allowedBy(list: string, candidates: (string | undefined)[]): boolean {
  const entries = whitelistEntries(list);
  if (entries.length === 0) return true;
  const values = candidates
    .filter((c): c is string => !!c)
    .map((c) => c.replace(/^@+/, "").toLowerCase());
  return entries.some((entry) => {
    if (entry.length > 1 && entry.startsWith("/") && entry.endsWith("/")) {
      try {
        const pattern = new RegExp(entry.slice(1, -1), "i");
        return values.some((v) => pattern.test(v));
      } catch {
        // A half-typed regex matches nothing rather than throwing the update away.
        return false;
      }
    }
    const wanted = entry.replace(/^@+/, "").toLowerCase();
    return values.some((v) => v === wanted);
  });
}

/** A sidebar name. Topics are named after the topic when known, else its number. */
export function chatTitle(message: TelegramMessage): string {
  const chat = message.chat;
  const topic = topicId(message);
  if (chat.title) {
    if (!topic) return chat.title;
    const named = message.reply_to_message?.forum_topic_created?.name;
    return `${chat.title} / ${named ?? `Topic ${topic}`}`;
  }
  const who = chat.first_name ?? chat.username ?? message.from?.first_name ?? "Telegram";
  return `${who} (Telegram)`;
}
