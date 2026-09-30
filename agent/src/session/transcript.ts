import type { UIMessage } from "ai";
import { storageFullMessage } from "../registry";
import { base64ToBytes } from "../util/bytes";
import { attachmentsOf, getAttachment, readBase64 } from "./attachments";
import { publicAttachment, uploadPath } from "./files";
import { stepsOf, textOf } from "./format";
import type { Attachment, PackedAttachment, SessionHost, Snapshot, TranscriptPage } from "./types";

/**
 * A transcript page as the API serves it: Think's messages plus files and cost. Paged
 * from the end; `before` walks back from the oldest message the client holds.
 */
export async function transcriptPage(
  host: SessionHost,
  limit: number,
  before = ""
): Promise<TranscriptPage> {
  const { max_message_page } = host.settings();
  const visible = (await host.getMessages()).filter(
    (m) => m.role === "user" || m.role === "assistant"
  );

  // An unknown `before` id (e.g. after a reset) falls back to the newest page.
  const end = before ? visible.findIndex((m) => m.id === before) : -1;
  const upTo = end === -1 ? visible.length : end;
  const size = Math.max(1, Math.min(limit, max_message_page));
  const start = Math.max(0, upTo - size);
  const page = visible.slice(start, upTo);

  const messages = page.map((m) => {
    const usage = host.exec<{
      prompt_tokens: number;
      completion_tokens: number;
      cost_usd: number;
      ms: number;
      ts: number;
    }>(`SELECT * FROM usage WHERE message_id = ?`, m.id)[0];
    const steps = stepsOf(m);
    const toolLines = steps.some((s) => s.kind === "tools");
    return {
      id: m.id,
      role: m.role as "user" | "assistant",
      content: spokenText(host, m),
      ts: usage?.ts ?? 0,
      prompt_tokens: usage?.prompt_tokens ?? 0,
      completion_tokens: usage?.completion_tokens ?? 0,
      cost_usd: usage?.cost_usd ?? 0,
      ms: usage?.ms ?? 0,
      attachments: attachmentsOf(host, m.id).map(publicAttachment),
      steps: toolLines ? JSON.stringify(steps) : "[]",
    };
  });

  return {
    messages,
    has_more: start > 0,
    // How many messages sit before this window. A fork counts from the start of
    // the transcript, so the client has to know what it is not holding.
    offset: start,
    total: visible.length,
  };
}

/** What the user typed, without the file notes added for the model. */
export function spokenText(host: SessionHost, message: UIMessage): string {
  const typed = host.exec<{ text: string }>(
    `SELECT text FROM message_text WHERE message_id = ?`,
    message.id
  )[0];
  return typed ? typed.text : textOf(message);
}

/**
 * The first `count` messages with every attachment they reference, bytes included,
 * so the fork can stand on its own.
 */
export async function exportTurns(host: SessionHost, count: number): Promise<Snapshot> {
  const visible = (await host.getMessages()).filter(
    (m) => m.role === "user" || m.role === "assistant"
  );
  const kept = visible.slice(0, Math.max(0, count));
  const keep = new Set(kept.map((m) => m.id));

  const pack = async (ids: string[]): Promise<PackedAttachment[]> =>
    await Promise.all(
      ids
        .map((id) => getAttachment(host, id))
        .filter((a): a is Attachment => !!a)
        .map(async (a) => ({
          ...a,
          data: await readBase64(host, a.path),
          thumb: await readBase64(host, a.thumb_path),
        }))
    );

  const carried = kept.flatMap((m) => attachmentsOf(host, m.id).map((a) => a.id));
  // The message just past the cut is the question a fork hands back for editing;
  // its files travel too, so the new session's composer opens with the same chips.
  const dropped = visible[Math.max(0, count)];
  const pending = dropped?.role === "user" ? attachmentsOf(host, dropped.id).map((a) => a.id) : [];

  return {
    messages: (await host.getMessages()).filter((m) => keep.has(m.id)),
    attachments: await pack(carried),
    links: host
      .exec<{ message_id: string; attachment_id: string }>(
        `SELECT message_id, attachment_id FROM message_files`
      )
      .filter((row) => keep.has(row.message_id)),
    texts: host
      .exec<{ message_id: string; text: string }>(`SELECT message_id, text FROM message_text`)
      .filter((row) => keep.has(row.message_id)),
    pending: await pack(pending),
  };
}

/**
 * Replay a snapshot into this empty session. Attachment ids are kept but the bytes are
 * copied, so either session can be deleted independently.
 */
export async function importTurns(host: SessionHost, snapshot: Snapshot): Promise<void> {
  const carried = (snapshot.attachments ?? []).map((a) => [a, 1] as const);
  // Copied unsent (used = 0), so they show as chips and ride the next turn.
  const pending = (snapshot.pending ?? []).map((a) => [a, 0] as const);

  // Copied bytes are charged like an upload, and refused the same way when there is no room.
  const incoming = [...carried, ...pending].reduce((sum, [a]) => sum + (a.bytes ?? 0), 0);
  const { max_agent_bytes } = await host.settingsNow();
  if (incoming > 0 && incoming > (await host.registry().storageRoom(max_agent_bytes))) {
    const { bytes } = await host.registry().storageState(max_agent_bytes);
    throw new Error(storageFullMessage(bytes, incoming, max_agent_bytes));
  }

  for (const [a, used] of [...carried, ...pending]) {
    let path = "";
    if (a.data) {
      path = uploadPath(a.id, a.name);
      await host.workspace.writeFileBytes(path, base64ToBytes(a.data), a.mime);
    }
    // The first-page image is copied the same way: a fork that lost its thumbnails
    // would redraw every PDF card as a bare name.
    let thumb = "";
    if (a.thumb) {
      thumb = `uploads/${a.id}/thumb.png`;
      await host.workspace.writeFileBytes(thumb, base64ToBytes(a.thumb), "image/png");
    }
    if ((a.bytes ?? 0) > 0) host.ctx.waitUntil(host.registry().addStorageBytes(a.bytes));
    host.exec(
      `INSERT OR REPLACE INTO attachments (id, kind, name, mime, text, path, thumb_path, bytes, ts, used)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      a.id,
      a.kind,
      a.name,
      a.mime,
      a.text,
      path,
      thumb,
      a.bytes,
      a.ts,
      used
    );
  }

  const messages = snapshot.messages ?? [];
  if (messages.length > 0) await host.addMessages(messages);

  // Ids are preserved across the copy, so which question carried which file — and
  // what each question actually said — travels as its own rows.
  for (const link of snapshot.links ?? []) {
    host.exec(
      `INSERT OR REPLACE INTO message_files (message_id, attachment_id) VALUES (?, ?)`,
      link.message_id,
      link.attachment_id
    );
  }
  for (const row of snapshot.texts ?? []) {
    host.exec(
      `INSERT OR REPLACE INTO message_text (message_id, text) VALUES (?, ?)`,
      row.message_id,
      row.text
    );
  }
}
