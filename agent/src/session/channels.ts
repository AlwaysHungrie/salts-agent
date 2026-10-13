import type { UIMessage } from "ai";
import { enabled } from "../capabilities";
import {
  type Channel,
  type ChannelFile,
  type ChannelInbound,
  type ChannelTarget,
  openChannel,
} from "../channel";
import { parseCommand } from "../commands";
import { toArrayBuffer } from "../util/bytes";
import { attachmentsOf, drawnIds, getAttachment, insertAttachment } from "./attachments";
import { runCommand } from "./commands";
import { isPdf, isSheet, uploadPath } from "./files";
import { reportable, textOf, turnFailure } from "./format";
import { openTurn, spendBlocked } from "./turns";
import type { Attachment, SessionHost } from "./types";

/**
 * Post a reply to this session's chat, over the channel named by its `source` (not by
 * which credentials exist). Best effort, but every no-send is logged: nobody watches.
 */
export async function deliverToChat(
  host: SessionHost,
  message: UIMessage,
  drawnBefore: Set<string>
): Promise<void> {
  const row = await host.registry().get(host.sessionId());
  // A browser session, or one cut loose from its chat by `!new`, has nowhere to post.
  if (!row?.chat_id) {
    console.log(`delivery skipped for session ${host.name()}: no chat to post to`);
    return;
  }
  const opened = openChannel(row.source, host.config(), host.env);
  if (!opened.channel) {
    console.warn(`delivery skipped for session ${host.name()}: ${opened.reason}`);
    return;
  }
  const channel = opened.channel;
  // Nothing to quote: the task was scheduled in some earlier exchange, and quoting
  // the message that asked for it would be a reply to yesterday.
  const target = channel.targetOf(row);
  if (!target) {
    console.warn(`delivery skipped for session ${host.name()}: chat id ${row.chat_id}`);
    return;
  }

  try {
    const text = textOf(message);
    await channel.sendText(target, chatText(text) || "(no reply)");
    console.log(`${channel.id} delivered for session ${host.name()} to ${target.to}`);
    await sendDrawn(host, channel, target, drawnBefore);
    await sendLinked(host, channel, target, text, message.id, drawnBefore);
    if (host.turn.scheduled && channel.scheduledNotice) {
      await channel.sendText(target, channel.scheduledNotice);
    }
  } catch (err) {
    const unreachable = channel.unreachable(err);
    if (unreachable) {
      console.warn(
        `${channel.id} unreachable for session ${host.name()}: ${unreachable}; scheduled reply not delivered`
      );
      return;
    }
    console.error(
      `${channel.id} delivery failed for session ${host.name()}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Send a voice note to this session's chat, for the `send_voice_note` tool. Refusals are
 * thrown so the model can tell the user; it asks the channel, not which channel it is.
 */
export async function sendVoiceNote(host: SessionHost, bytes: Uint8Array): Promise<string> {
  const row = await host.registry().get(host.sessionId());
  if (!row?.chat_id)
    throw new Error("this session is not tied to a chat, so a voice note has nowhere to go");
  const opened = openChannel(row.source, host.config(), host.env);
  if (!opened.channel) throw new Error(opened.reason);
  const channel = opened.channel;
  const target = channel.targetOf(row);
  if (!target) throw new Error(`this session's chat id (${row.chat_id}) names no conversation`);
  if (!channel.sendVoice) throw new Error(`${channel.id} cannot carry a voice note`);

  // `sendVoice` takes the whole buffer, so a view over part of a larger one is
  // copied out first rather than sent with its neighbours attached.
  await channel.sendVoice(
    target,
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  );
  console.log(`${channel.id} voice note sent for session ${host.name()} to ${target.to}`);
  return "Voice note sent. Say so in your reply rather than repeating the words you spoke.";
}

/**
 * Answer one chat-channel message: the same steps for every channel (typing, commands,
 * spend check, files, turn, reply, drawn images, apology on failure). The webhook has
 * already checked who may talk.
 */
export async function channelTurn(
  host: SessionHost,
  inbound: ChannelInbound | { skipped: string }
): Promise<{ ok: boolean; skipped?: string }> {
  if ("skipped" in inbound) return { ok: false, skipped: inbound.skipped };
  const { channel, target } = inbound;
  await channel.typing(target);

  try {
    // A command is answered by the session itself, without a turn: the model has no
    // say in whether it gets reset, and a wedged session could not run one anyway.
    const command = parseCommand(inbound.text);
    if (command) {
      const { text, destroy } = await runCommand(host, command);
      await channel.sendText(target, text);
      if (destroy) await host.finishDelete();
      return { ok: true };
    }

    const blocked = await spendBlocked(host);
    if (blocked) {
      await channel.sendText(target, blocked);
      return { ok: true };
    }

    const attached = await ingestFiles(host, inbound.files);
    const drawnBefore = drawnIds(host);

    const result = await host.runTurn({
      input: [await openTurn(host, inbound.text, false, attached)],
    });
    if (host.turn.stoppedOnPurpose) {
      // `!stop` already answered in this chat, so this turn sends nothing. Checked regardless
      // of status: a turn cancelled before its first chunk reports `completed`.
      return { ok: true };
    }
    if (result.status !== "completed") {
      // The turn carries why it stopped; a chat that only ever says "try again"
      // cannot be told apart from one that is broken in a way retrying will not fix.
      console.error(
        `${channel.id} turn ${result.status} in session ${host.name()}: ${result.error ?? "no reason given"}`
      );
    }
    const reply =
      result.status === "completed"
        ? textOf(result.message as unknown as UIMessage)
        : turnFailure(result.status, result.error);

    await channel.sendText(target, chatText(reply) || "(no reply)");
    // An image the agent drew during the turn is a file in a chat, not a link.
    await sendDrawn(host, channel, target, drawnBefore);
    // So is a file the reply links: the link only opens in the browser app.
    await sendLinked(host, channel, target, reply, result.message?.id ?? "", drawnBefore);
    // Its own message, so the model cannot paraphrase away what the user must do.
    if (host.turn.scheduled && channel.scheduledNotice) {
      await channel.sendText(target, channel.scheduledNotice);
    }
    return { ok: true };
  } catch (err) {
    // An unreachable chat gets no apology: that send would be refused too.
    const unreachable = channel.unreachable(err);
    if (unreachable) {
      console.warn(`${channel.id} unreachable for session ${host.name()}: ${unreachable}`);
      return { ok: false, skipped: unreachable };
    }
    // One readable line, as the browser gets; `reportable` logs the full error.
    await channel
      .sendText(
        { ...target, replyTo: undefined },
        `Something went wrong: ${reportable(err, host.name())}`
      )
      .catch(() => {
        // The chat is unreachable; the error is already the answer to the request.
      });
    return { ok: false };
  }
}

/**
 * Pull a message's files into the workspace as though uploaded (same rows, checks and
 * ceiling). Returns their ids so this turn claims exactly these, not a concurrent turn's.
 */
export async function ingestFiles(host: SessionHost, files: ChannelFile[]): Promise<string[]> {
  const taken: string[] = [];
  const config = host.config();
  for (const file of files) {
    const isImage = file.mime.startsWith("image/");
    const isAudio = file.mime.startsWith("audio/") || file.mime.startsWith("video/");
    const allowed = isImage
      ? enabled(config, "vision") && (await host.modelSeesImages(config.model))
      : isAudio
        ? enabled(config, "audio_input")
        : enabled(config, "file_ingest");
    if (!allowed) continue;

    const bytes = await file.read();
    // Over the storage ceiling the file is dropped and the turn goes on with the text.
    const maxAgentBytes = host.settings().max_agent_bytes;
    if (bytes.byteLength > (await host.registry().storageRoom(maxAgentBytes))) {
      console.warn(
        `file dropped in session ${host.name()}: agent is at its ${maxAgentBytes} byte storage limit`
      );
      continue;
    }
    const id = crypto.randomUUID().slice(0, 12);
    taken.push(id);
    const path = uploadPath(id, file.name);
    await host.workspace.writeFileBytes(path, bytes, file.mime);
    const pdf = isPdf(file.mime, file.name);
    const sheet = isSheet(file.mime, file.name);
    const textual = !isImage && !isAudio && !pdf && !sheet;
    insertAttachment(host, {
      id,
      kind: isImage ? "image" : pdf ? "pdf" : sheet ? "sheet" : "text",
      name: file.name,
      mime: file.mime,
      text: textual
        ? new TextDecoder().decode(bytes).slice(0, host.settings().max_upload_bytes.text)
        : "",
      path,
      thumb_path: "",
      bytes: bytes.byteLength,
    });
  }
  return taken;
}

/** Send images drawn this turn as pictures; a channel that cannot carry one sends nothing. */
export async function sendDrawn(
  host: SessionHost,
  channel: Channel,
  target: ChannelTarget,
  before: Set<string>
): Promise<void> {
  if (!channel.sendImage) return;
  const drawn = host
    .exec<Attachment>(`SELECT * FROM attachments WHERE kind = 'image' ORDER BY ts ASC`)
    .filter((a) => !before.has(a.id));
  for (const image of drawn) {
    const bytes = await host.workspace.readFileBytes(image.path);
    if (!bytes) continue;
    await channel.sendImage(target, toArrayBuffer(bytes), image.name, image.text);
  }
}

/** A Markdown link (or image) to a session file: `[label](/agents/.../files/<id>)`. */
const FILE_LINK = /!?\[([^\]]*)\]\([^)\s]*\/files\/([\w-]+)\)/g;

/**
 * The reply as a chat shows it: a link to a session file is a relative path no chat app
 * can open, so only its label stays; the file itself follows as its own message.
 */
export function chatText(reply: string): string {
  return reply.replace(FILE_LINK, (_, label: string) => label);
}

/**
 * Send each session file the reply links or carries, once, as a file. A file a tool made
 * hangs on the reply even when the text only names it (see showMadeFiles), and the browser
 * shows it there; a chat has only this send. Images drawn this turn are skipped:
 * `sendDrawn` has already sent them. A channel without the send sends nothing.
 */
export async function sendLinked(
  host: SessionHost,
  channel: Channel,
  target: ChannelTarget,
  reply: string,
  replyId: string,
  drawnBefore: Set<string>
): Promise<void> {
  const ids = new Set([
    ...[...reply.matchAll(FILE_LINK)].map((m) => m[2]),
    ...attachmentsOf(host, replyId).map((a) => a.id),
  ]);
  for (const id of ids) {
    const file = getAttachment(host, id);
    if (!file || (file.kind === "image" && !drawnBefore.has(id))) continue;
    const { sendImage, sendFile } = channel;
    if (file.kind === "image" ? !sendImage : !sendFile) continue;
    const bytes = await host.workspace.readFileBytes(file.path);
    if (!bytes) continue;
    if (file.kind === "image")
      await sendImage?.(target, toArrayBuffer(bytes), file.name, file.text);
    else await sendFile?.(target, toArrayBuffer(bytes), file.name, file.mime);
  }
}
