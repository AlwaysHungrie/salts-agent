import { enabled } from "../capabilities";
import { storageFullMessage } from "../registry";
import { bytesToBase64, toArrayBuffer } from "../util/bytes";
import {
  formatMb,
  isPdf,
  isTextLike,
  PARSE_CACHE_DIR,
  publicAttachment,
  uploadPath,
} from "./files";
import type { Attachment, SessionHost } from "./types";

export function getAttachment(host: SessionHost, id: string): Attachment | undefined {
  return host.exec<Attachment>(`SELECT * FROM attachments WHERE id = ?`, id)[0];
}

/** Uploaded but not yet sent: what the next turn will carry. */
export function pendingAttachments(host: SessionHost): Attachment[] {
  return host.exec<Attachment>(`SELECT * FROM attachments WHERE used = 0 ORDER BY ts ASC`);
}

/**
 * The files a turn is opening with: the ones it names, or every pending one when it
 * names none. Named ids are looked up whatever their `used` flag says — the caller
 * has just written them and is the only party that could claim them.
 */
export function claimed(host: SessionHost, only?: string[]): Attachment[] {
  if (!only) return pendingAttachments(host);
  if (only.length === 0) return [];
  const marks = only.map(() => "?").join(", ");
  return host.exec<Attachment>(
    `SELECT * FROM attachments WHERE id IN (${marks}) ORDER BY ts ASC`,
    ...only
  );
}

/**
 * Every file this session writes goes through here, so this is where the agent's
 * byte total is moved. Reported rather than awaited: the file is already written,
 * and a count that lands a moment later is better than an upload that waits on it.
 */
export function insertAttachment(
  host: SessionHost,
  row: Omit<Attachment, "ts" | "used">
): Attachment {
  const full: Attachment = { ...row, ts: Date.now(), used: 0 };
  if (full.bytes > 0) host.ctx.waitUntil(host.registry().addStorageBytes(full.bytes));
  host.exec(
    `INSERT INTO attachments (id, kind, name, mime, text, path, thumb_path, bytes, ts, used)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    full.id,
    full.kind,
    full.name,
    full.mime,
    full.text,
    full.path,
    full.thumb_path,
    full.bytes,
    full.ts
  );
  return full;
}

/** What this session's files come to, in bytes. */
export function storedBytes(host: SessionHost): number {
  try {
    const row = host.exec<{ total: number }>(
      `SELECT COALESCE(SUM(bytes), 0) AS total FROM attachments`
    )[0];
    return Math.max(0, Number(row?.total ?? 0));
  } catch {
    // A session that never got as far as its schema holds no files either.
    return 0;
  }
}

/**
 * Hand this session's bytes back to the agent's total.
 *
 * Called before the rows are deleted, never after — and before the object destroys
 * itself, because a destroyed object cannot report anything. A session whose
 * isolate dies mid-teardown leaves its bytes counted against the agent; the total
 * is a ceiling, not an invoice, so the cost of that is headroom.
 */
export function releaseStorage(host: SessionHost): void {
  const held = storedBytes(host);
  if (held > 0) host.ctx.waitUntil(host.registry().addStorageBytes(-held));
}

/** Only an unsent attachment can be dropped; a sent one belongs to its message. */
export async function removeAttachment(host: SessionHost, id: string) {
  const row = getAttachment(host, id);
  if (!row || row.used === 1) return;
  host.exec(`DELETE FROM attachments WHERE id = ? AND used = 0`, id);
  if (row.bytes > 0) host.ctx.waitUntil(host.registry().addStorageBytes(-row.bytes));
  if (row.path) await host.workspace.rm(`uploads/${id}`, { recursive: true, force: true });
  // The parse outlives nothing: the file it describes is gone.
  host.exec(`DELETE FROM file_cache WHERE attachment_id = ?`, id);
  await host.workspace.rm(`${PARSE_CACHE_DIR}/${id}.txt`, { force: true });
}

export async function serveAttachment(host: SessionHost, id: string): Promise<Response> {
  const row = getAttachment(host, id);
  if (!row?.path) return new Response("not found", { status: 404 });
  const stream = await host.workspace.readFileStream(row.path);
  if (!stream) return new Response("not found", { status: 404 });
  return new Response(stream, {
    headers: {
      "content-type": row.mime,
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
}

export async function serveThumbnail(host: SessionHost, id: string): Promise<Response> {
  const row = getAttachment(host, id);
  if (!row?.thumb_path) return new Response("not found", { status: 404 });
  const stream = await host.workspace.readFileStream(row.thumb_path);
  if (!stream) return new Response("not found", { status: 404 });
  return new Response(stream, {
    headers: {
      "content-type": "image/png",
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
}

type UploadKind = "pdf" | "image" | "audio" | "text";
type UploadResult = { body: unknown; status: number };

const refuse = (error: string, status: number): UploadResult => ({ body: { error }, status });

function uploadKind(mime: string, name: string): UploadKind {
  if (isPdf(mime, name)) return "pdf";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/") || mime.startsWith("video/")) return "audio";
  return "text";
}

/** Why the agent's capabilities refuse this kind of file, or undefined when they allow it. */
async function capabilityRefusal(
  host: SessionHost,
  kind: UploadKind,
  file: File,
  mime: string
): Promise<UploadResult | undefined> {
  const config = host.config();
  if (kind === "image") {
    if (!enabled(config, "vision")) {
      return refuse("Image input is off. Turn it on under Capabilities.", 400);
    }
    // Refused here: at turn time the message and attachment would already be stored.
    if (!(await host.modelSeesImages(config.model))) {
      return refuse(
        `${config.model} cannot see images. Pick a multimodal model under Settings.`,
        400
      );
    }
    return undefined;
  }
  if (kind === "audio") {
    if (!enabled(config, "audio_input")) {
      return refuse("Audio input is off. Turn it on under Capabilities.", 400);
    }
    return undefined;
  }
  if (!enabled(config, "file_ingest")) {
    return refuse("File ingest is off. Turn it on under Capabilities.", 400);
  }
  if (kind === "text" && !mime.startsWith("text/") && !isTextLike(mime, file.name)) {
    return refuse(
      `${file.name} is not a text format. Text, Markdown, CSV, JSON and source files work.`,
      415
    );
  }
  return undefined;
}

/**
 * Take one uploaded file. The per-kind size limit and the agent's storage ceiling are
 * checked before the bytes are read; then the capability for that kind of file. PDFs
 * and audio are stored whole (the read tool and `transcribe_audio` get at them later);
 * a PDF's first-page PNG is rendered by the browser and arrives beside it.
 */
export async function upload(host: SessionHost, request: Request): Promise<UploadResult> {
  const form = await request.formData();
  // The Workers FormData types entries loosely; the runtime hands back a File here.
  const file = form.get("file") as unknown as File | null;
  if (!file || typeof file === "string") return refuse("expected a file field", 400);
  const mime = file.type || "application/octet-stream";
  const kind = uploadKind(mime, file.name);
  const id = crypto.randomUUID().slice(0, 12);
  const path = uploadPath(id, file.name);

  const settings = await host.settingsNow();
  const limit = settings.max_upload_bytes[kind];
  if (file.size > limit) {
    return refuse(
      `${file.name} is ${formatMb(file.size)}; the limit for this kind of file is ${formatMb(limit)}.`,
      413
    );
  }
  const room = await host.registry().storageRoom(settings.max_agent_bytes);
  if (file.size > room) {
    const { bytes } = await host.registry().storageState(settings.max_agent_bytes);
    return refuse(storageFullMessage(bytes, file.size, settings.max_agent_bytes), 413);
  }

  const refused = await capabilityRefusal(host, kind, file, mime);
  if (refused) return refused;

  const stored = { id, name: file.name, mime, text: "", path, thumb_path: "", bytes: file.size };
  let attachment: Attachment;
  if (kind === "text") {
    const text = await file.text();
    await host.workspace.writeFile(path, text, mime);
    attachment = insertAttachment(host, { ...stored, kind: "text", text });
  } else if (kind === "pdf") {
    await host.workspace.writeFileBytes(path, await file.arrayBuffer(), "application/pdf");
    attachment = insertAttachment(host, {
      ...stored,
      kind: "pdf",
      mime: "application/pdf",
      thumb_path: await putThumbnail(host, id, form.get("thumbnail")),
    });
  } else {
    await host.workspace.writeFileBytes(path, await file.arrayBuffer(), mime);
    // Audio is stored as a text-kind attachment whose text is filled in on transcription.
    attachment = insertAttachment(host, { ...stored, kind: kind === "image" ? "image" : "text" });
  }
  return { body: { attachment: publicAttachment(attachment) }, status: 200 };
}

/**
 * Store the PNG of a PDF's first page. The browser renders it, so a malformed or
 * oversized image is dropped rather than trusted: the card falls back to its name.
 */
export async function putThumbnail(
  host: SessionHost,
  id: string,
  thumbnail: unknown
): Promise<string> {
  const file = thumbnail as File | null;
  if (!file || typeof file === "string" || file.size === 0) return "";
  if (file.size > host.settings().max_thumbnail_bytes) return "";
  const path = `uploads/${id}/thumb.png`;
  await host.workspace.writeFileBytes(path, await file.arrayBuffer(), "image/png");
  return path;
}

export async function readBase64(host: SessionHost, path: string): Promise<string> {
  if (!path) return "";
  const bytes = await host.workspace.readFileBytes(path);
  return bytes ? bytesToBase64(toArrayBuffer(bytes)) : "";
}

export function attachmentsOf(host: SessionHost, messageId: string): Attachment[] {
  return host
    .exec<{ attachment_id: string }>(
      `SELECT attachment_id FROM message_files WHERE message_id = ?`,
      messageId
    )
    .map((row) => getAttachment(host, row.attachment_id))
    .filter((a): a is Attachment => !!a);
}

/** Every image in this session so far, so the ones a turn adds can be told apart. */
export function drawnIds(host: SessionHost): Set<string> {
  return new Set(
    host.exec<{ id: string }>(`SELECT id FROM attachments WHERE kind = 'image'`).map((r) => r.id)
  );
}

/**
 * Every object this session spilled into the bucket. It is swept by key prefix
 * rather than by what the workspace remembers, so a row lost to a failed write or
 * an interrupted delete cannot leave its bytes behind for good.
 */
export async function sweepBucket(host: SessionHost): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await host.env.FILES.list({ prefix: `${host.name()}/`, cursor });
    // R2 takes up to 1000 keys per delete call, and a page holds at most 1000.
    if (page.objects.length > 0) {
      await host.env.FILES.delete(page.objects.map((o) => o.key));
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}
