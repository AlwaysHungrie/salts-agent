/**
 * The WhatsApp Cloud API: read a webhook, verify it came from Meta, reply. Unlike
 * Telegram: deliveries are signed over the raw body, repeat until a fast 200, and
 * free-form sends only work within 24 hours of the user's last message.
 */

import { split } from "./telegram";

/** Meta's Graph host. */
export const GRAPH_API = "https://graph.facebook.com";

/**
 * The Graph version every call is pinned to. Shapes change between versions, so this
 * is a deliberate constant rather than whatever the dashboard happens to show today.
 */
export const GRAPH_VERSION = "v23.0";

/** Graph's code for "you are outside the 24-hour customer service window". */
export const OUTSIDE_WINDOW = 131047;

/**
 * A file on a message. Meta names it and never sends the bytes, so every one of these
 * is a download away — see `WhatsApp.download`.
 */
export type WhatsappMedia = {
  id: string;
  /** `audio/ogg; codecs=opus` for a voice note, so the parameters are stripped below. */
  mime_type?: string;
  /** What was written under a picture or a clip, when anything was. */
  caption?: string;
  /** Only a document carries the name it had on the sender's phone. */
  filename?: string;
  /** True when a clip was spoken into the mic rather than attached as a track. */
  voice?: boolean;
};

/** One message, as the webhook reports it. Only the fields this agent reads. */
export type WhatsappMessage = {
  /** `wamid.…` — stable across Meta's retries, which is what makes dedupe possible. */
  id: string;
  /** The sender's number in international form, digits only, no `+`. */
  from: string;
  timestamp: string;
  type: string;
  text?: { body: string };
  audio?: WhatsappMedia;
  image?: WhatsappMedia;
  video?: WhatsappMedia;
  document?: WhatsappMedia;
  /** Set when the user replied to an earlier message. */
  context?: { from?: string; id?: string };
};

/** A file that arrived on a message, named the way the workspace will store it. */
export type WhatsappFile = {
  /** The media id, which is what `download` takes. */
  id: string;
  name: string;
  /** The type without its parameters: `audio/ogg`, not `audio/ogg; codecs=opus`. */
  mime: string;
};

/** The `value` of one `messages` change. */
export type WhatsappValue = {
  messaging_product: string;
  metadata?: { display_phone_number?: string; phone_number_id?: string };
  contacts?: { profile?: { name?: string }; wa_id: string }[];
  messages?: WhatsappMessage[];
  /** Delivery receipts share the webhook and have no `messages` key; skip them. */
  statuses?: { id: string; status: string }[];
};

/** What Meta POSTs to the callback URL. */
export type WhatsappPayload = {
  object?: string;
  entry?: { id?: string; changes?: { field?: string; value?: WhatsappValue }[] }[];
};

/** An inbound message, flattened to what a turn needs. */
export type WhatsappInbound = {
  message: WhatsappMessage;
  /** The sender, digits only. Checked against the agent's configured number. */
  from: string;
  /** The sender's WhatsApp profile name, when they publish one. */
  name: string;
  text: string;
  /** The business number the message was sent to (digits), for `wa.me/<number>` links. */
  businessNumber: string;
  /**
   * What the message carried, undownloaded. Ids rather than bytes, because this whole
   * object is serialised to the session's Durable Object before anything reads it.
   */
  files: WhatsappFile[];
};

export class WhatsApp {
  constructor(
    private readonly token: string,
    private readonly phoneNumberId: string,
    private readonly api: string = GRAPH_API,
    private readonly version: string = GRAPH_VERSION
  ) {}

  private async call<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.api}/${this.version}/${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as {
      error?: { message?: string; code?: number };
      messages?: { id: string }[];
    };
    if (!res.ok || json.error) {
      const code = json.error?.code;
      throw new WhatsappError(
        `whatsapp ${path}: ${json.error?.message ?? res.status}`,
        code ?? res.status
      );
    }
    return json as T;
  }

  /**
   * Send a reply split at WhatsApp's 4096-character limit; only the first chunk quotes.
   * Returns the `wamid`s sent.
   */
  async send(to: string, text: string, replyTo?: string): Promise<string[]> {
    const ids: string[] = [];
    for (const chunk of split(text)) {
      const sent = await this.call<{ messages?: { id: string }[] }>(
        `${this.phoneNumberId}/messages`,
        {
          messaging_product: "whatsapp",
          to,
          type: "text",
          // WhatsApp renders a link preview by fetching the first URL, which turns a
          // reply that merely mentions a site into a request to it.
          text: { preview_url: false, body: chunk },
          ...(replyTo && ids.length === 0 ? { context: { message_id: replyTo } } : {}),
        }
      );
      const id = sent.messages?.[0]?.id;
      if (id) ids.push(id);
    }
    return ids;
  }

  /**
   * Upload a file to Graph's media store and return its id (messages take ids, not bytes).
   * Multipart, so `content-type` is left for `fetch` to set with the boundary.
   */
  async upload(bytes: ArrayBuffer, mime: string, filename: string): Promise<string> {
    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("type", mime);
    form.append("file", new Blob([bytes], { type: mime }), filename);
    const res = await fetch(`${this.api}/${this.version}/${this.phoneNumberId}/media`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}` },
      body: form,
    });
    const json = (await res.json().catch(() => ({}))) as {
      id?: string;
      error?: { message?: string; code?: number };
    };
    if (!res.ok || json.error || !json.id) {
      throw new WhatsappError(
        `whatsapp media: ${json.error?.message ?? res.status}`,
        json.error?.code ?? res.status
      );
    }
    return json.id;
  }

  /**
   * Send uploaded audio; Ogg Opus shows as a voice note. Unquoted: the written reply
   * beside it already quotes.
   */
  async sendVoice(to: string, mediaId: string): Promise<string | undefined> {
    const sent = await this.call<{ messages?: { id: string }[] }>(
      `${this.phoneNumberId}/messages`,
      {
        messaging_product: "whatsapp",
        to,
        type: "audio",
        audio: { id: mediaId },
      }
    );
    return sent.messages?.[0]?.id;
  }

  /** Send an uploaded image, captioned with the prompt it was drawn from. */
  async sendImage(to: string, mediaId: string, caption?: string): Promise<string | undefined> {
    const sent = await this.call<{ messages?: { id: string }[] }>(
      `${this.phoneNumberId}/messages`,
      {
        messaging_product: "whatsapp",
        to,
        type: "image",
        // Meta caps a caption at 1024 characters and refuses the whole send over it.
        image: { id: mediaId, ...(caption ? { caption: caption.slice(0, 1024) } : {}) },
      }
    );
    return sent.messages?.[0]?.id;
  }

  /** Send an uploaded file as a document, under the name it was made with. */
  async sendDocument(to: string, mediaId: string, filename: string): Promise<string | undefined> {
    const sent = await this.call<{ messages?: { id: string }[] }>(
      `${this.phoneNumberId}/messages`,
      {
        messaging_product: "whatsapp",
        to,
        type: "document",
        document: { id: mediaId, filename },
      }
    );
    return sent.messages?.[0]?.id;
  }

  /**
   * Fetch a file the user sent: the id resolves to a short-lived CDN URL, which still
   * needs the access token.
   */
  async download(mediaId: string): Promise<ArrayBuffer> {
    const auth = { authorization: `Bearer ${this.token}` };
    const found = await fetch(`${this.api}/${this.version}/${encodeURIComponent(mediaId)}`, {
      headers: auth,
    });
    const json = (await found.json().catch(() => ({}))) as {
      url?: string;
      error?: { message?: string; code?: number };
    };
    if (!found.ok || json.error || !json.url) {
      throw new WhatsappError(
        `whatsapp media ${mediaId}: ${json.error?.message ?? found.status}`,
        json.error?.code ?? found.status
      );
    }
    const file = await fetch(json.url, { headers: auth });
    if (!file.ok) throw new WhatsappError(`whatsapp download: ${file.status}`, file.status);
    return await file.arrayBuffer();
  }

  /** Read receipt plus typing indicator (Meta only offers them together). Best effort. */
  async typing(messageId: string): Promise<void> {
    await this.call(`${this.phoneNumberId}/messages`, {
      messaging_product: "whatsapp",
      status: "read",
      message_id: messageId,
      typing_indicator: { type: "text" },
    }).catch(() => {
      // See above.
    });
  }
}

/**
 * Subscribe the app to the Business Account's webhooks, which is required alongside the
 * callback URL and easy to miss (test numbers look subscribed). Idempotent.
 */
export async function subscribeApp(
  token: string,
  wabaId: string,
  api: string = GRAPH_API,
  version: string = GRAPH_VERSION
): Promise<void> {
  const res = await fetch(`${api}/${version}/${encodeURIComponent(wabaId)}/subscribed_apps`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  const json = (await res.json().catch(() => ({}))) as {
    success?: boolean;
    error?: { message?: string; code?: number };
  };
  if (!res.ok || json.error || json.success === false) {
    throw new WhatsappError(
      `whatsapp subscribed_apps: ${json.error?.message ?? res.status}`,
      json.error?.code ?? res.status
    );
  }
}

/** A Graph refusal, carrying the code so `131047` can be told from a dead token. */
export class WhatsappError extends Error {
  constructor(
    message: string,
    readonly code: number
  ) {
    super(message);
    this.name = "WhatsappError";
  }
}

/**
 * Whether a delivery came from Meta: HMAC-SHA256 of the raw body under the app secret,
 * checked before parsing. A missing secret refuses rather than passes.
 */
export async function verifySignature(
  secret: string,
  raw: string,
  header: string | null
): Promise<boolean> {
  if (!secret || !header) return false;
  const offered = header.startsWith("sha256=") ? header.slice(7) : "";
  if (offered.length !== 64) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw));
  const expected = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return timingSafeEqual(expected, offered.toLowerCase());
}

/** Constant-time comparison, so a signature cannot be guessed byte by byte. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * The one message worth answering in a batched delivery, or nothing (status receipts are
 * the common case). File messages are read; stickers, contacts and the like are skipped.
 */
export function inboundOf(payload: WhatsappPayload | null): WhatsappInbound | undefined {
  for (const entry of payload?.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field && change.field !== "messages") continue;
      const value = change.value;
      const message = value?.messages?.[0];
      if (!message) continue;
      const media = mediaOf(message);
      if (message.type !== "text" && !media) continue;
      // A picture or a clip says what it is for in its caption; there is no other text.
      const text = (message.text?.body ?? media?.caption ?? "").trim();
      const contact =
        value?.contacts?.find((c) => c.wa_id === message.from) ?? value?.contacts?.[0];
      return {
        message,
        from: message.from,
        name: contact?.profile?.name ?? "",
        text,
        businessNumber: digits(value?.metadata?.display_phone_number ?? ""),
        files: media ? [fileOf(message, media)] : [],
      };
    }
  }
  return undefined;
}

/**
 * The file on a message, if it carries one. A message carries at most one: WhatsApp
 * sends an album of three pictures as three messages, each with its own `wamid`.
 */
function mediaOf(message: WhatsappMessage): WhatsappMedia | undefined {
  return message.audio ?? message.image ?? message.video ?? message.document;
}

/**
 * A name for a file that usually arrives without one; the extension helps transcription
 * and PDF parsing when the type is ambiguous.
 */
function fileOf(message: WhatsappMessage, media: WhatsappMedia): WhatsappFile {
  const mime = (media.mime_type ?? "").split(";")[0].trim() || "application/octet-stream";
  if (media.filename) return { id: media.id, name: media.filename, mime };
  const kind = media.voice ? "voice" : message.type;
  return { id: media.id, name: `${kind}-${message.timestamp}.${extensionOf(mime)}`, mime };
}

/** The extension for a type, for the handful WhatsApp actually sends. */
function extensionOf(mime: string): string {
  const subtype = mime.split("/")[1] ?? "";
  return EXTENSIONS[subtype] ?? subtype ?? "bin";
}

const EXTENSIONS: Record<string, string> = {
  jpeg: "jpg",
  mpeg: "mp3",
  plain: "txt",
  quicktime: "mov",
};

/**
 * Whether the sender is the agent's one configured number (blank answers nobody).
 * Both sides are reduced to digits before comparing.
 */
export function isOwnNumber(configured: string, from: string): boolean {
  const wanted = digits(configured);
  return wanted !== "" && wanted === digits(from);
}

const digits = (value: string) => value.replace(/\D/g, "");

/** A conversation's name, for the sidebar. */
export function chatTitle(inbound: WhatsappInbound): string {
  return `${inbound.name || inbound.from} (WhatsApp)`;
}
