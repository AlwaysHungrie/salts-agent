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
import { drawnIds, insertAttachment } from "./attachments";
import { runCommand } from "./commands";
import { isPdf, uploadPath } from "./files";
import { reportable, textOf, turnFailure } from "./format";
import { openTurn, spendBlocked } from "./turns";
import type { Attachment, SessionHost } from "./types";

/**
 * Post a reply to the chat this session belongs to, over whichever channel it came
 * in on. Best effort throughout: the turn is already in the transcript, so a chat
 * that cannot be reached must not turn a completed task into a failed one.
 *
 * The channel is decided by the session's `source` rather than by which credentials
 * happen to be filled in: an agent may have both channels on, and a WhatsApp chat id
 * posted to Telegram would land in whichever chat that number happens to name.
 *
 * Every way this can come to nothing is logged, and that is deliberate: nobody is
 * watching a scheduled task, the answer is already in the transcript, and a silent
 * no-send is the one failure this path cannot afford.
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
    await channel.sendText(target, textOf(message) || "(no reply)");
    console.log(`${channel.id} delivered for session ${host.name()} to ${target.to}`);
    await sendDrawn(host, channel, target, drawnBefore);
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
 * Speak a note into this session's chat.
 *
 * Called by the `send_voice_note` tool, mid-turn, which is why every refusal here is
 * a thrown reason rather than a logged one: the model reads it as the tool's result
 * and can say something true to the user instead of promising audio that never
 * arrived.
 *
 * It asks the channel whether it does voice notes rather than asking which channel
 * it is, so the tool works on every channel that can carry one and on no channel
 * that cannot. The chat comes from the session's row and not from the message being
 * answered, so a note asked for by a scheduled task goes where an ordinary reply
 * would.
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
 * One message from a chat channel, answered.
 *
 * The same eight steps for every channel, because they were the same eight steps
 * when they were written twice: look busy, answer a command without a turn, check
 * the spend, take in what came attached, run, reply, send what was drawn, apologise
 * if it broke. What differs between Telegram and WhatsApp is held by the channel
 * object — see channel.ts — so nothing here branches on which one it is.
 *
 * The chat is a session like any other, so the turn is the turn the browser runs:
 * the same settings, tools, memory and transcript. What is different is the ends —
 * files arrive from the channel rather than from an upload, and the reply is posted
 * back rather than streamed.
 *
 * Who may talk is settled before this: the webhook checks the whitelist or the
 * configured number before a session exists, and these routes are only reachable
 * from it.
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
      // `!stop` has already said so in this chat, so this turn owes it nothing —
      // not the half-answer to a question that was withdrawn, and least of all
      // "that turn was cut short", which reads as a fault when it was an
      // instruction. What it wrote is in the transcript either way.
      //
      // Read without looking at the status, because a turn cancelled before its
      // first chunk reports `completed` with nothing in it. The flag is the only
      // thing that tells a stop that was asked for from one that was not.
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

    await channel.sendText(target, reply || "(no reply)");
    // An image the agent drew during the turn is a file in a chat, not a link.
    await sendDrawn(host, channel, target, drawnBefore);
    // Said as its own message rather than folded into the answer, so the model
    // cannot paraphrase away the one thing the user has to do for the task to
    // arrive. The window is open by definition here — they just wrote.
    if (host.turn.scheduled && channel.scheduledNotice) {
      await channel.sendText(target, channel.scheduledNotice);
    }
    return { ok: true };
  } catch (err) {
    // A chat that is out of reach for good takes no apology: on WhatsApp the send
    // that would carry it is the send being refused. The answer is already in the
    // transcript, and the browser can still read it.
    const unreachable = channel.unreachable(err);
    if (unreachable) {
      console.warn(`${channel.id} unreachable for session ${host.name()}: ${unreachable}`);
      return { ok: false, skipped: unreachable };
    }
    // The same one line the browser gets: a raw platform error names SQL statements
    // and isolate resets, which is not an answer to someone who asked a question.
    // `reportable` logs the whole thing and returns the sentence worth sending.
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
 * Pull what a message carried into the workspace, as though it had been uploaded:
 * the same rows, the same paths, the same capability checks, so the turn that
 * follows cannot tell the difference.
 *
 * The files are `ChannelFile`s and not any one channel's shape, so a channel that
 * learns to hand over inbound media gets all of this — the capability gates, the
 * storage ceiling, the PDF and audio handling — without a line here.
 *
 * Returns the ids it took in, and the turn that follows claims those rather than
 * whatever is pending. The pool is the session's, and two messages sent a second
 * apart are two turns running side by side inside one Durable Object: downloading
 * the second clip while the first turn is still opening is enough for one turn to
 * claim both files and answer both questions, which is what it did.
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
    // The agent's ceiling applies to what arrives over a chat channel too. The file
    // is dropped and the turn goes on with the text: the alternative is an agent
    // that stops answering because somebody sent it a video.
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
    const textual = !isImage && !isAudio && !pdf;
    insertAttachment(host, {
      id,
      kind: isImage ? "image" : pdf ? "pdf" : "text",
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

/**
 * Images created during this turn, sent to the chat as pictures rather than as the
 * links they are in the browser. A channel that cannot carry one sends nothing and
 * says nothing: the reply already describes what was drawn.
 */
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
