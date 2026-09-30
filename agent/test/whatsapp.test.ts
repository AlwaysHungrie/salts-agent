import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  SCHEDULED_PROMPT,
  SPOKEN_TEXT,
  UNSUBSCRIBABLE_WABA_ID,
  WINDOW_CLOSED_WA_ID,
  replyTo,
} from "./openrouter-mock";
import { isVoiceNote } from "../src/channel";
import { inboundOf, isOwnNumber, verifySignature } from "../src/whatsapp";
import { signedIn } from "./clerk";

/**
 * The WhatsApp channel, from the handshake to a delivered answer.
 *
 * Everything Meta does that Telegram does not is what these cover: a signed body, a
 * delivery that repeats, a status receipt that is not a message, and one configured
 * number rather than a whitelist. See docs/whatsapp-setup.md.
 */

const BASE = "https://worker.test";
const APP_SECRET = "test-app-secret";
const VERIFY_TOKEN = "test-verify-token";

const someone = (label = "user") => `${label}-${crypto.randomUUID().slice(0, 8)}@x.com`;

/** What `agent.ts` prefixes a scheduled task's user message with. */
const SCHEDULED_PREFIX = "[scheduled task] ";

/** The window warning, verbatim, so a reworded one fails here rather than in the wild. */
const WINDOW_NOTICE =
  "Meta policy disallows me to send you a message if we don't have an active chat session. To ensure scheduled messages reach you, send me a message every 24 hours.";

function as(email: string, init: RequestInit = {}) {
  return {
    ...init,
    headers: {
      "content-type": "application/json",
      ...signedIn(email),
      ...(init.headers as Record<string, string> | undefined),
    },
  };
}

/**
 * A number no other test uses. The Graph stand-in's log of what it was asked to send
 * is shared by the whole file, so "did this test's reply go out" is only answerable
 * if each test owns its recipient.
 */
const waNumber = () =>
  `91${Math.floor(Math.random() * 1e10)
    .toString()
    .padStart(10, "0")}`;

/** A WhatsApp Business Account id no other test uses, for the same reason. */
const wabaId = () =>
  `1${Math.floor(Math.random() * 1e14)
    .toString()
    .padStart(14, "0")}`;

/** Which accounts the Worker has asked Graph to subscribe. */
async function subscribed(): Promise<string[]> {
  const res = await fetch("https://graph.facebook.com/__subscribed");
  return (await res.json()) as string[];
}

/** An agent with nothing configured on it yet, and the address that owns it. */
async function bareAgent(): Promise<{ id: string; email: string }> {
  const email = someone("wa");
  const agent = (await (
    await SELF.fetch(
      `${BASE}/api/agents`,
      as(email, {
        method: "POST",
        body: JSON.stringify({
          name: "WhatsApp Agent",
          allowed_emails: email,
          openrouter_api_key: "sk-fake-but-valid",
        }),
      })
    )
  ).json()) as { id: string };
  return { id: agent.id, email };
}

/** An agent with WhatsApp configured, and the route that answers for it. */
async function agentFixture(patch: Record<string, unknown> = {}) {
  const { id, email } = await bareAgent();
  const agent = { id };

  const number = waNumber();
  const waba = wabaId();
  const res = await SELF.fetch(
    `${BASE}/api/agents/${agent.id}/config`,
    as(email, {
      method: "PATCH",
      body: JSON.stringify({
        cap_whatsapp: 1,
        whatsapp_number: number,
        whatsapp_phone_number_id: "123456789012345",
        whatsapp_waba_id: waba,
        whatsapp_access_token: "EAA-test-token",
        whatsapp_app_secret: APP_SECRET,
        whatsapp_verify_token: VERIFY_TOKEN,
        ...patch,
      }),
    })
  );
  expect(res.ok).toBe(true);
  return {
    agentId: agent.id,
    email,
    number,
    waba,
    saved: (await res.json()) as { whatsapp?: { ok: boolean; error?: string } },
    hook: `${BASE}/whatsapp/webhook/${agent.id}`,
  };
}

/** One text message, in the shape Meta actually posts. */
function delivery(from: string, text: string, wamid = `wamid.${crypto.randomUUID()}`) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "1104349325675223",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "15551477730", phone_number_id: "123456789012345" },
              contacts: [{ profile: { name: "Owner" }, wa_id: from }],
              messages: [
                { from, id: wamid, timestamp: "1758000000", type: "text", text: { body: text } },
              ],
            },
          },
        ],
      },
    ],
  };
}

/** The same, carrying a file instead of words — a voice note, a picture, a document. */
function mediaDelivery(
  from: string,
  type: "audio" | "image" | "video" | "document",
  media: Record<string, unknown>,
  wamid = `wamid.${crypto.randomUUID()}`
) {
  const payload = delivery(from, "", wamid);
  payload.entry[0].changes[0].value.messages = [
    { from, id: wamid, timestamp: "1758000000", type, [type]: media },
  ] as never;
  return payload;
}

/** One inbound voice note, in the shape Meta posts it: an id, and Opus in Ogg. */
const voiceNote = (from: string, id = `media-${crypto.randomUUID().slice(0, 8)}`) =>
  mediaDelivery(from, "audio", { id, mime_type: "audio/ogg; codecs=opus", voice: true });

/** A file put in a session from the browser, which leaves it pending until a turn sends it. */
async function uploadToSession(sessionId: string, email: string, name: string) {
  const form = new FormData();
  form.set("file", new File(["notes from the browser"], name, { type: "text/plain" }));
  const res = await SELF.fetch(`${BASE}/agents/session-agent/${sessionId}/files`, {
    method: "POST",
    headers: signedIn(email),
    body: form,
  });
  expect(res.ok).toBe(true);
}

/** What is waiting to be sent with this session's next message. */
async function pending(sessionId: string, email: string): Promise<string[]> {
  const res = await SELF.fetch(`${BASE}/agents/session-agent/${sessionId}/files`, as(email));
  return ((await res.json()) as { attachments: { name: string }[] }).attachments.map((a) => a.name);
}

/** Which inbound media ids the Worker has fetched the bytes of. */
async function downloaded(): Promise<string[]> {
  const res = await fetch("https://graph.facebook.com/__downloaded");
  return (await res.json()) as string[];
}

const hex = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** Sign a body the way Meta does, so a test can post something the Worker accepts. */
async function sign(raw: string, secret = APP_SECRET): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return `sha256=${hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw)))}`;
}

async function post(hook: string, payload: unknown, signature?: string) {
  const raw = JSON.stringify(payload);
  return await SELF.fetch(hook, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": signature ?? (await sign(raw)),
    },
    body: raw,
  });
}

/** What the Graph stand-in was asked to send to one number. */
async function sentTo(to: string) {
  const res = await fetch(`https://graph.facebook.com/__sent?to=${to}`);
  return (await res.json()) as {
    to: string;
    body: string;
    replyTo?: string;
    audio?: string;
    image?: string;
    caption?: string;
  }[];
}

/** What the Graph stand-in was asked to put in its media store. */
async function uploads() {
  const res = await fetch("https://graph.facebook.com/__media");
  return (await res.json()) as { id: string; mime: string; bytes: number; name: string }[];
}

/** The bytes of a file, as a string, for the container checks. */
const bytesOf = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;

/** Meta's answer arrives after the 200, so a delivered reply is waited for. */
async function waitForReply(to: string, count = 1, tries = 100) {
  for (let i = 0; i < tries; i++) {
    const sent = await sentTo(to);
    if (sent.length >= count) return sent;
    await scheduler.wait(50);
  }
  return await sentTo(to);
}

describe("the subscription handshake", () => {
  it("returns the challenge verbatim when the verify token matches", async () => {
    const { hook } = await agentFixture();
    const res = await SELF.fetch(
      `${hook}?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=1158201444`
    );
    expect(res.status).toBe(200);
    // Meta compares the body byte for byte and subscribes nothing if it differs.
    expect(await res.text()).toBe("1158201444");
    expect(res.headers.get("content-type")).toContain("text/plain");
  });

  it("refuses a wrong verify token", async () => {
    const { hook } = await agentFixture();
    const res = await SELF.fetch(
      `${hook}?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1158201444`
    );
    expect(res.status).toBe(403);
  });

  it("is not there at all when the capability is off", async () => {
    const { hook } = await agentFixture({ cap_whatsapp: 0 });
    const res = await SELF.fetch(
      `${hook}?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=1`
    );
    expect(res.status).toBe(404);
  });

  it("is not there when a required field is blank", async () => {
    // Half-configured is off, not half-on: a route that answers the handshake and
    // then cannot verify a signature looks like Meta's fault.
    const { hook } = await agentFixture({ whatsapp_app_secret: "" });
    const res = await SELF.fetch(
      `${hook}?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=1`
    );
    expect(res.status).toBe(404);
  });
});

describe("the signature on a delivery", () => {
  it("refuses a body signed with the wrong secret", async () => {
    const { hook, number } = await agentFixture();
    const payload = delivery(number, "hello");
    const forged = await sign(JSON.stringify(payload), "not-the-app-secret");
    expect((await post(hook, payload, forged)).status).toBe(401);
  });

  it("refuses a delivery with no signature at all", async () => {
    const { hook, number } = await agentFixture();
    const res = await SELF.fetch(hook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(delivery(number, "hello")),
    });
    expect(res.status).toBe(401);
  });

  it("refuses when the app secret is unset rather than waving it through", async () => {
    // An unconfigured Worker that accepts unsigned webhooks looks like it works.
    expect(await verifySignature("", "{}", "sha256=" + "0".repeat(64))).toBe(false);
  });

  it("accepts the signature Meta would send", async () => {
    const raw = JSON.stringify({ hello: "world" });
    expect(await verifySignature(APP_SECRET, raw, await sign(raw))).toBe(true);
    // A body altered after signing is a different body.
    expect(await verifySignature(APP_SECRET, raw + " ", await sign(raw))).toBe(false);
  });
});

describe("what counts as a message", () => {
  it("ignores a status receipt, which carries no message", async () => {
    const { hook } = await agentFixture();
    const receipt = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "1104349325675223",
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: { phone_number_id: "123456789012345" },
                statuses: [{ id: "wamid.sent1", status: "delivered" }],
              },
            },
          ],
        },
      ],
    };
    const res = await post(hook, receipt);
    // A 200 with no session: answering a delivery receipt would answer the agent's
    // own replies, forever.
    expect(res.status).toBe(200);
    expect(res.headers.get("x-session")).toBe(null);
    expect(inboundOf(receipt)).toBeUndefined();
  });

  it("reads the sender, the profile name and the text out of a real payload", () => {
    const inbound = inboundOf(delivery("919718497676", "  hello  ", "wamid.abc"));
    expect(inbound?.from).toBe("919718497676");
    expect(inbound?.name).toBe("Owner");
    expect(inbound?.text).toBe("hello");
    expect(inbound?.message.id).toBe("wamid.abc");
  });
});

describe("the one number the agent answers", () => {
  it("answers nobody when the number is blank", () => {
    // There is no whitelist and so no empty state that could mean "everyone".
    expect(isOwnNumber("", "919718497676")).toBe(false);
  });

  it("matches however the number was typed", () => {
    expect(isOwnNumber("+91 97184-97676", "919718497676")).toBe(true);
    expect(isOwnNumber("919718497676", "919718497676")).toBe(true);
    expect(isOwnNumber("919718497676", "919718497677")).toBe(false);
  });

  it("gives another number no answer and no session", async () => {
    const { hook } = await agentFixture();
    const stranger = waNumber();
    const res = await post(hook, delivery(stranger, "let me in"));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-session")).toBe(null);
    expect(await sentTo(stranger)).toHaveLength(0);
  });
});

describe("two agents on WhatsApp", () => {
  it("keeps each agent's deliveries on its own route and its own session", async () => {
    const one = await agentFixture();
    const two = await agentFixture();

    const first = await post(one.hook, delivery(one.number, "for the first"));
    const second = await post(two.hook, delivery(two.number, "for the second"));
    expect(first.headers.get("x-session")).toBeTruthy();
    expect(second.headers.get("x-session")).toBeTruthy();
    expect(first.headers.get("x-session")).not.toBe(second.headers.get("x-session"));

    // The second agent's number is not the first agent's owner.
    const crossed = await post(one.hook, delivery(two.number, "wrong route"));
    expect(crossed.headers.get("x-session")).toBe(null);
  });
});

describe("a delivery that repeats", () => {
  it("answers the same wamid once", async () => {
    const { hook, number } = await agentFixture();
    const payload = delivery(number, "only once");

    const first = await post(hook, payload);
    expect(first.status).toBe(200);
    const second = await post(hook, payload);
    // Meta reads a non-200 as a reason to try again, so a duplicate is still a 200.
    expect(second.status).toBe(200);
    expect(second.headers.get("x-whatsapp")).toBe("duplicate");
    expect(second.headers.get("x-session")).toBe(null);
  });
});

describe("a whole round trip", () => {
  it("answers the owner with a real model reply, in the same chat", async () => {
    const { hook, number } = await agentFixture();
    const wamid = `wamid.${crypto.randomUUID()}`;
    const res = await post(hook, delivery(number, "hello there", wamid));
    expect(res.status).toBe(200);
    const sessionId = res.headers.get("x-session");
    expect(sessionId).toBeTruthy();
    // `wa-` and not `tg-`: a WhatsApp number and a Telegram chat id of the same
    // digits must not share a Durable Object.
    expect(sessionId).toContain(`~wa-${number}`);

    const [sent] = await waitForReply(number);
    expect(sent.body).toBe(replyTo("hello there"));
    // The answer quotes the message it answers, so a burst of questions is legible.
    expect(sent.replyTo).toBe(wamid);
  });

  it("gives the same number the same session on the next message", async () => {
    const { hook, number } = await agentFixture();
    const one = await post(hook, delivery(number, "first"));
    const two = await post(hook, delivery(number, "second"));
    expect(two.headers.get("x-session")).toBe(one.headers.get("x-session"));
  });
});

describe("the 24-hour window", () => {
  it("logs a refused send rather than failing the turn", async () => {
    const { hook } = await agentFixture({ whatsapp_number: WINDOW_CLOSED_WA_ID });
    // Graph answers 131047 for this recipient. The turn still ran and is in the
    // transcript; only the delivery is refused, and no retry can fix that.
    const res = await post(hook, delivery(WINDOW_CLOSED_WA_ID, "are you there"));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-session")).toBeTruthy();
  });
});

describe("the account subscription", () => {
  it("subscribes the business account when the settings are saved", async () => {
    const { waba, saved } = await agentFixture();
    expect(saved.whatsapp).toEqual({ ok: true });
    expect(await subscribed()).toContain(waba);
  });

  it("reports a refused subscription instead of failing the save", async () => {
    const { id, email } = await bareAgent();
    const res = await SELF.fetch(
      `${BASE}/api/agents/${id}/config`,
      as(email, {
        method: "PATCH",
        body: JSON.stringify({
          cap_whatsapp: 1,
          whatsapp_number: waNumber(),
          whatsapp_phone_number_id: "123456789012345",
          whatsapp_waba_id: UNSUBSCRIBABLE_WABA_ID,
          whatsapp_access_token: "EAA-test-token",
          whatsapp_app_secret: APP_SECRET,
          whatsapp_verify_token: VERIFY_TOKEN,
        }),
      })
    );
    expect(res.ok).toBe(true);
    const payload = (await res.json()) as {
      config: { whatsapp_waba_id: string };
      whatsapp?: { ok: boolean; error?: string };
    };
    // The credentials are stored either way: the subscription is a separate call.
    expect(payload.config.whatsapp_waba_id).toBe(UNSUBSCRIBABLE_WABA_ID);
    expect(payload.whatsapp?.ok).toBe(false);
    expect(payload.whatsapp?.error).toContain("subscribed_apps");
  });

  it("does not subscribe while the account id is blank", async () => {
    const { id, email } = await bareAgent();
    const before = (await subscribed()).length;
    const res = await SELF.fetch(
      `${BASE}/api/agents/${id}/config`,
      as(email, {
        method: "PATCH",
        body: JSON.stringify({ cap_whatsapp: 1, whatsapp_access_token: "EAA-test-token" }),
      })
    );
    expect(res.ok).toBe(true);
    expect((await res.json()) as { whatsapp?: unknown }).not.toHaveProperty("whatsapp");
    expect((await subscribed()).length).toBe(before);
  });
});

describe("a task scheduled from WhatsApp", () => {
  it("delivers the task's answer to the chat when it runs", async () => {
    const { hook, number } = await agentFixture({ cap_scheduled_tasks: 1 });
    expect((await post(hook, delivery(number, "!!schedule the digest"))).status).toBe(200);

    // Three sends: the answer, the window warning, and the task's own answer once the
    // alarm has fired. The last one is the whole point — before it, a scheduled task
    // wrote its reply into the transcript and the phone never heard about it.
    const sent = await waitForReply(number, 3, 200);
    expect(sent[0].body).toBe("Scheduled it.");
    expect(sent[2].body).toContain(`${SCHEDULED_PREFIX}${SCHEDULED_PROMPT}`);
    // Nothing to quote: the message that asked for the task is long past.
    expect(sent[2].replyTo).toBeUndefined();
  });

  it("warns about the 24-hour window as its own message", async () => {
    const { hook, number } = await agentFixture({ cap_scheduled_tasks: 1 });
    await post(hook, delivery(number, "!!schedule the digest"));

    const sent = await waitForReply(number, 2);
    expect(sent[1].body).toBe(WINDOW_NOTICE);
  });

  it("still delivers after `!new` has moved the chat to another session", async () => {
    const { hook, number } = await agentFixture({ cap_scheduled_tasks: 1 });
    // `!new` hands the chat to a successor session, which is named after the chat id.
    // A WhatsApp chat id is `wa:<number>`, and a session id carrying that colon is
    // routed to its Durable Object percent-encoded — so the object looked itself up
    // under a name the registry had never stored, found no chat, and dropped every
    // scheduled reply without a word.
    expect((await post(hook, delivery(number, "!new"))).status).toBe(200);
    expect((await waitForReply(number))[0].body).toContain("Starting fresh");

    await post(hook, delivery(number, "!!schedule the digest"));
    const sent = await waitForReply(number, 4, 200);
    expect(sent[1].body).toBe("Scheduled it.");
    expect(sent[3].body).toContain(`${SCHEDULED_PREFIX}${SCHEDULED_PROMPT}`);
  });

  it("says nothing about the window on a turn that scheduled nothing", async () => {
    const { hook, number } = await agentFixture({ cap_scheduled_tasks: 1 });
    await post(hook, delivery(number, "hello"));

    const sent = await waitForReply(number);
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toBe(replyTo("hello"));
  });
});

describe("a voice note", () => {
  it("uploads Ogg Opus and sends it beside the written reply", async () => {
    const { hook, number } = await agentFixture({ cap_voice_output: 1 });
    expect((await post(hook, delivery(number, "!!voice say it out loud"))).status).toBe(200);

    // Two sends: the note, which the tool posts mid-turn, and the reply the turn ends
    // with. The written answer still goes out — a voice note is an addition to it.
    const sent = await waitForReply(number, 2);
    const note = sent.find((s) => s.audio);
    expect(note).toBeTruthy();
    expect(sent.some((s) => s.body === "Sent it.")).toBe(true);
    // The spoken words are heard, not read: they are in the note, not in a bubble.
    expect(sent.every((s) => s.body !== SPOKEN_TEXT)).toBe(true);

    // Meta takes no bytes on a send: the note is an upload the message names by id.
    const upload = (await uploads()).find((u) => u.id === note?.audio);
    expect(upload).toBeTruthy();
    // Ogg Opus and nothing else is rendered as a voice note; an MP3 of the same words
    // arrives as a file with a download button.
    expect(upload?.mime).toBe("audio/ogg");
    expect(upload?.bytes).toBeGreaterThan(0);
  });

  it("says nothing aloud when the capability is off", async () => {
    const { hook, number } = await agentFixture();
    const before = (await uploads()).length;
    await post(hook, delivery(number, "!!voice say it out loud"));

    // The model is never handed the tool, so nothing is spoken and nothing uploaded.
    const sent = await waitForReply(number);
    expect(sent.every((s) => !s.audio)).toBe(true);
    expect((await uploads()).length).toBe(before);
  });

  it("counts only Ogg Opus as a voice note", () => {
    // Graph accepts the wrong codec and Meta delivers it; the only sign of trouble is
    // a bubble on the phone that will not play, so the check happens before the upload.
    expect(isVoiceNote(bytesOf(`OggS${"\u0000".repeat(24)}OpusHeadmock`))).toBe(true);
    expect(isVoiceNote(bytesOf("ID3\u0003mp3 all the way down"))).toBe(false);
    expect(isVoiceNote(bytesOf(`OggS${"\u0000".repeat(24)}vorbis`))).toBe(false);
    expect(isVoiceNote(bytesOf(""))).toBe(false);
  });
});

describe("a voice note the user sent", () => {
  it("names the clip, strips the codec off its type and dates its filename", () => {
    const inbound = inboundOf(voiceNote("919718497676", "media-abc"));
    expect(inbound?.files).toEqual([
      { id: "media-abc", name: "voice-1758000000.ogg", mime: "audio/ogg" },
    ]);
    // A voice note carries no words. The turn still has to run: the clip is the message.
    expect(inbound?.text).toBe("");
  });

  it("downloads it and files it in the session as an attachment", async () => {
    const { hook, number, email } = await agentFixture({ cap_audio_input: 1 });
    const res = await post(hook, voiceNote(number, "media-inbound1"));
    const sessionId = res.headers.get("x-session")!;
    await waitForReply(number);

    // Two hops: the id resolves to a URL, and the URL serves the bytes.
    expect(await downloaded()).toContain("media-inbound1");
    const page = (await (
      await SELF.fetch(`${BASE}/agents/session-agent/${sessionId}/messages`, as(email))
    ).json()) as { messages: { attachments?: { name: string; mime: string }[] }[] };
    const files = page.messages.flatMap((m) => m.attachments ?? []);
    expect(files.map((f) => f.name)).toContain("voice-1758000000.ogg");
    expect(files.map((f) => f.mime)).toContain("audio/ogg");
  });

  it("leaves it on Meta's servers when Audio input is off", async () => {
    const { hook, number } = await agentFixture();
    await post(hook, voiceNote(number, "media-inbound2"));

    // The turn still answers; the clip is simply never fetched.
    await waitForReply(number);
    expect(await downloaded()).not.toContain("media-inbound2");
  });

  it("reads a picture's caption as the message it came with", () => {
    const inbound = inboundOf(
      mediaDelivery("919718497676", "image", {
        id: "media-pic",
        mime_type: "image/jpeg",
        caption: "  what is this  ",
      })
    );
    expect(inbound?.text).toBe("what is this");
    expect(inbound?.files[0]?.name).toBe("image-1758000000.jpg");
  });

  it("keeps the name a document was sent under", () => {
    const inbound = inboundOf(
      mediaDelivery("919718497676", "document", {
        id: "media-doc",
        mime_type: "application/pdf",
        filename: "invoice.pdf",
      })
    );
    expect(inbound?.files[0]?.name).toBe("invoice.pdf");
  });

  it("answers with the clip that arrived, not with whatever else is pending", async () => {
    // Two messages a second apart are two turns running side by side in one Durable
    // Object, and the pending pool is the session's. A turn that takes the pool takes
    // the other message's clip with it and answers both questions at once, which is
    // what it did: "First clip … Second clip", to someone who had asked one thing.
    const { hook, number, email } = await agentFixture({ cap_audio_input: 1, cap_file_ingest: 1 });
    const opened = await post(hook, delivery(number, "hello"));
    const sessionId = opened.headers.get("x-session")!;
    await waitForReply(number);

    await uploadToSession(sessionId, email, "notes.txt");
    await post(hook, voiceNote(number, "media-alone"));
    await waitForReply(number, 2);

    const page = (await (
      await SELF.fetch(`${BASE}/agents/session-agent/${sessionId}/messages`, as(email))
    ).json()) as { messages: { role: string; attachments?: { name: string }[] }[] };
    const carried = page.messages
      .filter((m) => m.role === "user")
      .map((m) => (m.attachments ?? []).map((a) => a.name));
    // The clip went out by itself. Nothing carried two files, and nothing carried a
    // file the message it belongs to never had.
    expect(carried).toEqual([[], ["voice-1758000000.ogg"]]);
    // The browser's file is untouched and still waiting for the message it was for.
    expect(await pending(sessionId, email)).toEqual(["notes.txt"]);
  });

  it("ignores a message that is neither words nor a file", async () => {
    // A location, a contact card, an order: nothing to read and nothing to download,
    // so answering one would be the agent replying to nothing.
    const location = delivery("919718497676", "");
    location.entry[0].changes[0].value.messages = [
      {
        from: "919718497676",
        id: "wamid.loc",
        timestamp: "1758000000",
        type: "location",
        location: { latitude: 19.07, longitude: 72.87 },
      },
    ] as never;
    expect(inboundOf(location)).toBeUndefined();
  });
});

describe("an image the agent drew", () => {
  it("is uploaded and sent as a picture", async () => {
    // WhatsApp could not send one until the channel seam: Telegram takes a photo in
    // the same call as a message, Meta wants the bytes in its media store first.
    const { hook, number } = await agentFixture({ cap_image_generation: 1 });
    expect((await post(hook, delivery(number, "!!draw something"))).status).toBe(200);

    const sent = await waitForReply(number, 2);
    const picture = sent.find((s) => s.image);
    expect(picture).toBeTruthy();
    // The prompt rides along as the caption.
    expect(picture?.caption).toContain("mock drawing");

    const upload = (await uploads()).find((u) => u.id === picture?.image);
    expect(upload?.mime).toBe("image/png");
    expect(upload?.bytes).toBeGreaterThan(0);
  });
});
