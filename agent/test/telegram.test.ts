import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { EMPTY_MCP_SERVER } from "../src/registry";
import { signedIn } from "./clerk";
import {
  MCP_MEDIA_TOOL,
  PLATFORM_RESET,
  RESET_FILE_ID,
  SLOW_REPLY_MS,
  SPOKEN_TEXT,
  TELEGRAM_FILE_BODY,
  replyTo,
} from "./openrouter-mock";

/**
 * The Telegram channel, end to end.
 *
 * It had no coverage at all until the channel seam was built: `api.telegram.org` is
 * sealed off by the suite's outbound mock, so every turn this file drives used to run
 * only in production. The Worker is pointed at a stand-in through `TELEGRAM_API_BASE`
 * — see vitest.config.ts — and the seal on the real host is untouched.
 *
 * What is worth checking here is what the channel seam claims: that Telegram and
 * WhatsApp run the same eight steps, so a feature written once reaches both. The
 * voice note and the drawn image below are the two halves of that claim — neither
 * channel has a line of code of its own for either.
 */

const BASE = "https://worker.test";
const BOT_TOKEN = "123456:mock-bot-token";

const someone = (label = "tg") => `${label}-${crypto.randomUUID().slice(0, 8)}@x.com`;

/** A chat id no other test uses: the stand-in's log of sends is shared by the file. */
const chatId = () => -Math.floor(Math.random() * 1e11) - 1e11;

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

/** The secret Telegram sends back on every update, as server.ts derives it. */
async function webhookSecret(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

/** An agent with Telegram configured, and the route that answers for it. */
async function agentFixture(patch: Record<string, unknown> = {}) {
  const email = someone();
  const agent = (await (
    await SELF.fetch(
      `${BASE}/api/agents`,
      as(email, {
        method: "POST",
        body: JSON.stringify({
          name: "Telegram Agent",
          allowed_emails: email,
          openrouter_api_key: "sk-fake-but-valid",
        }),
      })
    )
  ).json()) as { id: string };

  const res = await SELF.fetch(
    `${BASE}/api/agents/${agent.id}/config`,
    as(email, {
      method: "PATCH",
      body: JSON.stringify({
        cap_telegram: 1,
        telegram_bot_token: BOT_TOKEN,
        telegram_bot_username: "mock_bot",
        // The whitelists ship as placeholders that match nobody, which is the whole
        // point of them; these tests are the owner talking to their own bot.
        telegram_user_whitelist: "",
        telegram_group_whitelist: "",
        ...patch,
      }),
    })
  );
  expect(res.ok).toBe(true);
  return { agentId: agent.id, email, chat: chatId(), hook: `${BASE}/telegram/webhook/${agent.id}` };
}

/** One private message, in the shape Telegram actually posts. */
function update(chat: number, text: string, messageId = Math.floor(Math.random() * 1e6)) {
  return {
    update_id: Math.floor(Math.random() * 1e9),
    message: {
      message_id: messageId,
      date: 1758000000,
      text,
      chat: { id: chat, type: "private", first_name: "Owner", username: "owner" },
      from: { id: chat, is_bot: false, first_name: "Owner", username: "owner" },
    },
  };
}

/** The same, carrying a document the agent is expected to ingest. */
function withDocument(chat: number, text: string, fileId?: string) {
  const message = update(chat, text).message;
  return {
    update_id: Math.floor(Math.random() * 1e9),
    message: {
      ...message,
      document: {
        file_id: fileId ?? `file-${crypto.randomUUID().slice(0, 8)}`,
        file_name: "notes.txt",
        mime_type: "text/plain",
        file_size: TELEGRAM_FILE_BODY.length,
      },
    },
  };
}

async function post(hook: string, payload: unknown) {
  return await SELF.fetch(hook, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": await webhookSecret(BOT_TOKEN),
    },
    body: JSON.stringify(payload),
  });
}

/** The sessions an agent still holds, newest first. */
async function sessionIds(agentId: string, email: string): Promise<string[]> {
  const res = await SELF.fetch(`${BASE}/api/agents/${agentId}/sessions`, as(email));
  const { sessions } = (await res.json()) as { sessions: { id: string }[] };
  return sessions.map((s) => s.id);
}

/** What the Telegram stand-in was asked to send to one chat. */
async function sentTo(chat: number) {
  const res = await fetch(`https://telegram.test/__sent?chat=${chat}`);
  return (await res.json()) as {
    chatId: string;
    text: string;
    replyTo?: number;
    photo?: string;
    voice?: number;
    document?: string;
    mime?: string;
    caption?: string;
  }[];
}

/** Telegram is answered before the turn runs, so a delivered reply is waited for. */
async function waitForReply(chat: number, count = 1, tries = 120) {
  for (let i = 0; i < tries; i++) {
    const sent = await sentTo(chat);
    if (sent.length >= count) return sent;
    await scheduler.wait(50);
  }
  return await sentTo(chat);
}

describe("a whole round trip", () => {
  it("answers the chat with a real model reply, quoting the message", async () => {
    const { hook, chat } = await agentFixture();
    const messageId = 4242;
    const res = await post(hook, update(chat, "hello there", messageId));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-session")).toBeTruthy();

    const [sent] = await waitForReply(chat);
    expect(sent.text).toBe(replyTo("hello there"));
    expect(sent.replyTo).toBe(messageId);
  });

  it("gives the same chat the same session on the next message", async () => {
    const { hook, chat } = await agentFixture();
    const one = await post(hook, update(chat, "first"));
    const two = await post(hook, update(chat, "second"));
    expect(two.headers.get("x-session")).toBe(one.headers.get("x-session"));
  });

  it("answers a command without running a turn", async () => {
    const { hook, chat } = await agentFixture();
    await post(hook, update(chat, "!new"));
    const [sent] = await waitForReply(chat);
    expect(sent.text).toContain("Starting fresh");
  });

  it("stops a reply that is still being written with !stop", async () => {
    const { hook, chat } = await agentFixture();
    // `!!slow` dribbles the reply out, so there is a turn in flight to interrupt.
    await post(hook, update(chat, "!!slow tell me everything you know"));
    await scheduler.wait(SLOW_REPLY_MS / 4);
    await post(hook, update(chat, "!stop"));

    const [first] = await waitForReply(chat);
    expect(first.text).toContain("Stopped.");

    // The stopped turn says nothing of its own. Waiting out the whole reply it would
    // have written is the only way to know it never arrives.
    await scheduler.wait(SLOW_REPLY_MS * 2);
    expect(await sentTo(chat)).toHaveLength(1);

    // And the session is left usable: stopping one reply must not cost the next one.
    await post(hook, update(chat, "are you still there"));
    const sent = await waitForReply(chat, 2);
    expect(sent[1].text).toBe(replyTo("are you still there"));
  });

  it("says so when !stop has nothing to stop", async () => {
    const { hook, chat } = await agentFixture();
    await post(hook, update(chat, "!stop"));
    const [sent] = await waitForReply(chat);
    expect(sent.text).toContain("Nothing to stop");
  });

  it("keeps the old session on !new, and drops it on !clear", async () => {
    // The one difference between the two commands, checked on the thing that differs:
    // what the agent still lists afterwards.
    for (const command of ["!new", "!clear"] as const) {
      const { hook, chat, agentId, email } = await agentFixture();
      const before = (await post(hook, update(chat, "hello"))).headers.get("x-session");
      await waitForReply(chat);

      await post(hook, update(chat, command));
      const [, said] = await waitForReply(chat, 2);
      expect(said.text).toContain("Starting fresh");

      // The chat carries on either way, on a session that is not the old one.
      const after = (await post(hook, update(chat, "again"))).headers.get("x-session");
      expect(after).not.toBe(before);

      const ids = await sessionIds(agentId, email);
      expect(ids).toContain(after);
      expect(ids.includes(before as string)).toBe(command === "!new");
    }
  });

  it("refuses an update that is not signed with the bot's secret", async () => {
    const { hook, chat } = await agentFixture();
    const res = await SELF.fetch(hook, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "not-the-secret",
      },
      body: JSON.stringify(update(chat, "let me in")),
    });
    expect(res.status).toBe(401);
    expect(await sentTo(chat)).toHaveLength(0);
  });
});

describe("what the channel seam buys", () => {
  it("sends a voice note, with no Telegram code of its own", async () => {
    // The tool, the speaking model and the Ogg Opus check are the ones WhatsApp uses.
    // Only `Channel.sendVoice` differs, and that is fifteen lines in telegram.ts.
    const { hook, chat } = await agentFixture({ cap_voice_output: 1 });
    await post(hook, update(chat, "!!voice say it out loud"));

    const sent = await waitForReply(chat, 2);
    const note = sent.find((s) => s.voice !== undefined);
    expect(note).toBeTruthy();
    expect(note?.voice).toBeGreaterThan(0);
    // Spoken, not written: the words are in the note, not in a bubble.
    expect(sent.every((s) => s.text !== SPOKEN_TEXT)).toBe(true);
    expect(sent.some((s) => s.text === "Sent it.")).toBe(true);
  });

  it("sends a drawn image as a photo", async () => {
    const { hook, chat } = await agentFixture({ cap_image_generation: 1 });
    await post(hook, update(chat, "!!draw something"));

    const sent = await waitForReply(chat, 2);
    const photo = sent.find((s) => s.photo !== undefined);
    expect(photo).toBeTruthy();
    // The prompt rides along as the caption.
    expect(photo?.caption).toContain("mock drawing");
  });

  it("sends a file the reply links as a document, and drops the dead link", async () => {
    const { hook, chat, agentId } = await agentFixture();
    await env.SessionRegistry.get(env.SessionRegistry.idFromName(agentId)).addMcpServer({
      ...EMPTY_MCP_SERVER,
      id: crypto.randomUUID(),
      name: "Reports",
      url: "https://mcp.test/media/mcp",
      tools_json: JSON.stringify([MCP_MEDIA_TOOL]),
      created_at: Date.now(),
    });
    await post(hook, update(chat, "!!export mcp_reports_build_report"));

    const sent = await waitForReply(chat, 3);
    const doc = sent.find((s) => s.document !== undefined);
    expect(doc?.document).toBe("Client report.xlsx");
    expect(doc?.mime).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    const text = sent.find((s) => s.text.startsWith("Your dashboard is ready"));
    expect(text?.text).toBe("Your dashboard is ready: Client report.xlsx");
  });

  it("ingests a file the message carried", async () => {
    const { hook, chat, email } = await agentFixture({ cap_file_ingest: 1 });
    const res = await post(hook, withDocument(chat, "what does this say"));
    const sessionId = res.headers.get("x-session")!;
    await waitForReply(chat);

    // Read back off the transcript rather than the pending-files list: by the time the
    // turn has answered, the file has been sent with it and is no longer pending.
    const page = (await (
      await SELF.fetch(`${BASE}/agents/session-agent/${sessionId}/messages`, as(email))
    ).json()) as { messages: { role: string; attachments?: { name: string }[] }[] };
    const names = page.messages.flatMap((m) => (m.attachments ?? []).map((a) => a.name));
    expect(names).toContain("notes.txt");
  });

  it("apologises for a platform reset in one line, without the SQL", async () => {
    // A deploy restarts the object under whatever request is running, and Cloudflare
    // says so by naming a failed SQL query and an isolate reset. The chat used to get
    // that verbatim. It is the same mapping the browser gets, so it belongs here.
    const { hook, chat } = await agentFixture({ cap_file_ingest: 1 });
    await post(hook, withDocument(chat, "read this", RESET_FILE_ID));

    const [sent] = await waitForReply(chat);
    expect(sent.text).toBe(
      "Something went wrong: Session restarted before your message was processed."
    );
    expect(sent.text).not.toContain("SQL");
    expect(sent.text).not.toContain(PLATFORM_RESET);
  });
});
