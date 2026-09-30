import { type UIMessage } from "ai";
import { type Command, parseCommand } from "../commands";
import { turnCost } from "../openrouter";
import { attachmentsOf, claimed } from "./attachments";
import { runCommand } from "./commands";
import { isAudioAttachment } from "./files";
import { reportable, textOf } from "./format";
import { streamSentence } from "./live";
import type { Attachment, SessionHost } from "./types";

/** Asked once, on the first turn, to turn the opening exchange into a sidebar title. */
export const TITLE_PROMPT =
  "Name this conversation in at most four words. Reply with the title only: no quotes, no punctuation at the end, no preamble.";

/**
 * The user's turn: their words, plus a note naming every file they attached and
 * where it sits in the workspace. The bytes are not inlined — the model opens what
 * it needs with the read tool, so a PDF is not re-sent with every later message.
 */
export function userText(host: SessionHost, message: string, attachments: Attachment[]): string {
  if (attachments.length === 0) return message;
  const notes = attachments.map((a) => {
    if (isAudioAttachment(a)) {
      return a.text.trim()
        ? `--- attached audio: ${a.name} (id ${a.id}), already transcribed ---\n${a.text}`
        : `--- attached audio: ${a.name} (id ${a.id}), not transcribed. Call transcribe_audio with attachment_id "${a.id}" if you need the words. ---`;
    }
    // Images and PDFs ride along as content parts, so naming them is enough. A text
    // file is not sent: the model opens it from the workspace when it needs to.
    if (a.kind === "image") return `--- attached image: ${a.name} ---`;
    if (a.kind === "pdf") return `--- attached PDF: ${a.name} ---`;
    return `--- attached file: ${a.name}, in the workspace at ${a.path} ---`;
  });
  return [message, ...notes].filter((part) => part.trim() !== "").join("\n\n");
}

/**
 * The message a turn sends, and the files it claims: the pending ones, or — on a
 * retry — the ones the question being asked again came with.
 *
 * `only` names them outright, and is how a chat channel says "these files, the ones
 * that arrived on this message". A browser turn passes nothing and takes the pending
 * pool, because that is exactly what it means there: files dropped on the composer
 * before the message was sent. A channel has no composer, and its pool is shared with
 * every other message being answered at that moment.
 */
export async function openTurn(
  host: SessionHost,
  message: string,
  retry: boolean,
  only?: string[]
): Promise<UIMessage> {
  // A new question is the end of the last stop. Cleared here and not in
  // `beforeTurn`, which runs again on a retried attempt: an abort is one of the
  // things Think retries, so clearing it there would clear it on the way down from
  // the very stop that set it.
  host.turn.stoppedOnPurpose = false;
  const attachments = retry ? await rewind(host) : claimed(host, only);
  const id = crypto.randomUUID();
  for (const a of attachments) {
    host.exec(`UPDATE attachments SET used = 1 WHERE id = ?`, a.id);
    host.exec(
      `INSERT OR REPLACE INTO message_files (message_id, attachment_id) VALUES (?, ?)`,
      id,
      a.id
    );
  }
  // The user row exists only for its timestamp; the reply's row carries the cost.
  host.exec(`INSERT OR REPLACE INTO usage (message_id, ts) VALUES (?, ?)`, id, Date.now());
  host.exec(`INSERT OR REPLACE INTO message_text (message_id, text) VALUES (?, ?)`, id, message);
  return {
    id,
    role: "user",
    parts: [{ type: "text", text: userText(host, message, attachments) }],
  };
}

/**
 * Undo the last exchange so it can be asked again: the trailing assistant messages
 * and the question that prompted them are deleted from the session, and that
 * question's attachments are handed back so the retry carries the same files.
 */
export async function rewind(host: SessionHost): Promise<Attachment[]> {
  const messages = await host.getMessages();
  let cut = messages.length;
  while (cut > 0 && messages[cut - 1].role === "assistant") cut--;
  const question = cut > 0 && messages[cut - 1].role === "user" ? messages[cut - 1] : null;
  if (question) cut--;

  // Read the links before the rows go: the question's own row is among the ones
  // about to be deleted, and its files are exactly what the retry needs back.
  const attachments = question ? attachmentsOf(host, question.id) : [];

  const dropped = messages.slice(cut);
  if (dropped.length > 0) await host.deleteMessages(dropped.map((m) => m.id));
  for (const message of dropped) {
    host.exec(`DELETE FROM usage WHERE message_id = ?`, message.id);
    host.exec(`DELETE FROM message_files WHERE message_id = ?`, message.id);
    host.exec(`DELETE FROM message_text WHERE message_id = ?`, message.id);
  }
  // They are already marked used, so `pendingAttachments` would never find them.
  for (const a of attachments) host.exec(`UPDATE attachments SET used = 0 WHERE id = ?`, a.id);
  return attachments;
}

/**
 * The sentence to answer with instead of running a turn, when the agent has spent
 * its month. Empty when it may go ahead.
 *
 * Checked before the turn rather than during it: a reply cut off halfway through
 * costs what a whole one costs and is worth less than nothing. Going over by the
 * price of one turn is the deliberate trade — the cost is only known once the turn
 * has happened, so the ceiling is the point where it stops starting new ones.
 */
export async function spendBlocked(host: SessionHost): Promise<string> {
  const { usd, limit } = await host.registry().spendState();
  if (limit <= 0 || usd < limit) return "";
  return (
    `This agent has reached its spending limit for this month ` +
    `($${usd.toFixed(2)} of $${limit.toFixed(2)}). ` +
    `It will answer again next month, or when its administrator raises the limit.`
  );
}

/** A whole turn, without streaming. */
export async function runChat(host: SessionHost, message: string, retry = false) {
  const command = parseCommand(message);
  if (command) {
    const { text, destroy } = await runCommand(host, command);
    if (destroy) host.ctx.waitUntil(host.finishDelete());
    return { body: { reply: text }, turn: { cost_usd: 0, llm_ms: 0 } };
  }
  const blocked = await spendBlocked(host);
  if (blocked) return { body: { reply: blocked }, turn: { cost_usd: 0, llm_ms: 0 } };
  const userMessage = await openTurn(host, message, retry);
  const result = await host.runTurn({ input: [userMessage] });
  const reply = result.status === "completed" ? textOf(result.message as unknown as UIMessage) : "";
  const usage = host.exec<{ cost_usd: number; ms: number }>(
    `SELECT cost_usd, ms FROM usage WHERE message_id = ?`,
    result.message?.id ?? ""
  )[0];

  return {
    body: { reply },
    turn: { cost_usd: usage?.cost_usd ?? 0, llm_ms: usage?.ms ?? 0 },
  };
}

/**
 * Stream a reply as SSE, in the event shape the browser already speaks. Think owns
 * the loop and the persistence; this translates its UI message chunks into the
 * `delta` / `tool` / `tool_done` / `usage` protocol the chat client reads.
 *
 * The object stays resident — and billable — for the whole stream. A stopped reply
 * keeps its partial text and its token cost, because the tokens were generated.
 */
export async function streamChat(
  host: SessionHost,
  message: string,
  retry = false
): Promise<Response> {
  const command = parseCommand(message);
  if (command) return await streamCommand(host, command);
  // Said as the agent would say it, down the same stream: the chat has no other
  // way to show why nothing is coming back.
  const blocked = await spendBlocked(host);
  if (blocked) return streamSentence(blocked);
  const userMessage = await openTurn(host, message, retry);
  // Tool events name the call by id; the name arrives once, when it starts.
  const toolNames = new Map<string, string>();

  // The turn runs against the object, not against this request, and every event it
  // produces is banked as it goes. The response is one listener on that; a browser
  // that reloads mid-reply opens another and is caught up from the first token.
  host.live.start();
  const turn = (async () => {
    try {
      await host.runTurn({
        mode: "stream",
        input: [userMessage],
        callback: {
          onStart: () => {},
          onEvent: (json: string) => {
            const chunk = JSON.parse(json) as {
              type: string;
              delta?: string;
              toolCallId?: string;
              toolName?: string;
            };
            if (chunk.type === "text-delta" && chunk.delta) {
              host.live.emit({ type: "delta", text: chunk.delta });
            } else if (chunk.type === "tool-input-start" && chunk.toolCallId) {
              toolNames.set(chunk.toolCallId, chunk.toolName ?? "tool");
              host.live.emit({ type: "tool", name: chunk.toolName ?? "tool" });
            } else if (chunk.type === "tool-output-available" && chunk.toolCallId) {
              host.live.emit({
                type: "tool_done",
                name: toolNames.get(chunk.toolCallId) ?? "tool",
                ok: true,
              });
            } else if (chunk.type === "tool-output-error" && chunk.toolCallId) {
              host.live.emit({
                type: "tool_done",
                name: toolNames.get(chunk.toolCallId) ?? "tool",
                ok: false,
              });
            }
          },
          onDone: () => {},
          onError: (error: string) => {
            host.live.emit({ type: "error", error: reportable(error, host.name()) });
          },
        },
      });

      host.live.emit({
        type: "usage",
        prompt_tokens: host.usage().prompt,
        completion_tokens: host.usage().completion,
        cost_usd: turnCost(host.usage()),
        llm_ms: host.usage().started ? Date.now() - host.usage().started : 0,
      });
    } catch (err) {
      host.live.emit({ type: "error", error: reportable(err, host.name()) });
    } finally {
      host.live.emit({ type: "done" });
      host.live.end();
    }
  })();
  // The object stays resident — and billable — until the turn is done, whether or
  // not anyone is still listening.
  host.ctx.waitUntil(turn);

  return host.live.attach();
}

/**
 * A command's answer, sent down the same stream a reply would use so the browser
 * draws it as an ordinary message. No turn runs, so there is no cost to report.
 */
export async function streamCommand(host: SessionHost, command: Command): Promise<Response> {
  const { text, destroy } = await runCommand(host, command);
  if (destroy) host.ctx.waitUntil(host.finishDelete());
  return streamSentence(text);
}

/**
 * Ask the model for a short name for the session and write it to the registry, so
 * the sidebar stops showing "New session". Best effort: a failed title must never
 * fail the turn it was generated from.
 */
export async function nameSession(host: SessionHost, userMessage: string, reply: string) {
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${host.openrouterKey()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: host.model(),
        messages: [
          { role: "system", content: TITLE_PROMPT },
          { role: "user", content: `User: ${userMessage}\n\nAssistant: ${reply.slice(0, 500)}` },
        ],
      }),
    });
    if (!res.ok) return;
    const json = (await res.json()) as { choices: { message: { content: string } }[] };
    const title = (json.choices[0]?.message?.content ?? "")
      .replace(/^["'\s]+|["'\s.]+$/g, "")
      .slice(0, 60);
    if (!title) return;
    await host.registry().rename(host.sessionId(), title);
  } catch {
    // Leave the placeholder title in place.
  }
}
