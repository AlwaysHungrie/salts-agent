import { acceptsUploads, enabled, withMcpAuth } from "../capabilities";
import type { McpServerRow } from "../mcp";
import { annotationText, type FileAnnotation } from "../openrouter";
import type { Config } from "../registry";
import { toArrayBuffer } from "../util/bytes";
import { readBase64 } from "./attachments";
import { PARSE_CACHE_DIR } from "./files";
import type { Attachment, SessionHost } from "./types";

/**
 * Which parser OpenRouter runs over a PDF. `mistral-ocr` is the one that reads scans
 * and keeps a table's shape, and it is billed per page — which is affordable only
 * because a document is parsed once per session and replayed after that.
 */
export const PDF_PARSE_ENGINE = "mistral-ocr";

/**
 * Send each PDF a message carried to every connected MCP server that takes uploads,
 * and name the id it came back under. The model sees the PDF's words but cannot copy
 * its bytes into a tool call, so without this a server that stores the original gets
 * the text alone. Uploaded once per server, on the first turn that needs it; a failed
 * upload is not a failed turn, and is tried again on the next.
 */
export async function mcpUploadNotes(
  host: SessionHost,
  config: Config,
  attachments: Attachment[]
): Promise<string[]> {
  const servers = enabled(config, "mcp") ? host.mcpServers().filter(acceptsUploads) : [];
  const notes: string[] = [];
  for (const a of attachments) {
    if (a.kind !== "pdf") continue;
    for (const server of servers) {
      const id = await ensureMcpUpload(host, a, server);
      if (id) notes.push(`[Attachment ${a.name} uploaded to ${server.name}: upload_id=${id}]`);
    }
  }
  return notes;
}

export async function ensureMcpUpload(
  host: SessionHost,
  attachment: Attachment,
  server: McpServerRow
): Promise<string> {
  const cached = host.exec<{ upload_id: string }>(
    `SELECT upload_id FROM mcp_uploads WHERE attachment_id = ? AND server_id = ? AND url = ?`,
    attachment.id,
    server.id,
    server.url
  )[0];
  if (cached) return cached.upload_id;
  const bytes = await host.workspace.readFileBytes(attachment.path);
  if (!bytes) return "";
  try {
    const uploadId = await withMcpAuth(server, host.registry(), (client) =>
      client.upload(toArrayBuffer(bytes), attachment.mime)
    );
    host.exec(
      `INSERT OR REPLACE INTO mcp_uploads (attachment_id, server_id, url, upload_id, ts) VALUES (?, ?, ?, ?, ?)`,
      attachment.id,
      server.id,
      server.url,
      uploadId,
      Date.now()
    );
    return uploadId;
  } catch (err) {
    console.error(
      `mcp upload of ${attachment.id} to ${server.name} failed: ${err instanceof Error ? err.message : err}`
    );
    return "";
  }
}

/**
 * The words of every attachment that has been parsed, in message order. A row whose
 * file has gone missing is forgotten rather than repaired: the PDF is still on hand,
 * so the worst case is one more parse.
 */
export async function parsedDocuments(
  host: SessionHost,
  attachments: Attachment[]
): Promise<{ id: string; name: string; text: string }[]> {
  const found: { id: string; name: string; text: string }[] = [];
  for (const a of attachments) {
    if (a.kind !== "pdf") continue;
    const row = host.exec<{ path: string }>(
      `SELECT path FROM file_cache WHERE attachment_id = ?`,
      a.id
    )[0];
    if (!row?.path) continue;
    // Parses were once cached whole, as JSON. Those rows are dropped rather than
    // read: their contents are a payload, not a document, and putting one in front
    // of the model would be worse than parsing the PDF again.
    if (!row.path.endsWith(".txt")) {
      host.exec(`DELETE FROM file_cache WHERE attachment_id = ?`, a.id);
      await host.workspace.rm(row.path, { force: true });
      continue;
    }
    try {
      const text = await host.workspace.readFile(row.path);
      if (!text?.trim()) throw new Error("empty");
      found.push({ id: a.id, name: a.name, text });
    } catch {
      host.exec(`DELETE FROM file_cache WHERE attachment_id = ?`, a.id);
    }
  }
  return found;
}

/**
 * Parse a PDF once, the way a clip is transcribed once: on the first turn that needs
 * it, not at upload, so nothing stands between the user and sending their message.
 *
 * It takes its own request because OpenRouter does not return annotations on a
 * streamed completion — the parse only comes back on an ordinary one. The reply is
 * thrown away; what is wanted is the parse riding along with it, whose text stands
 * in for the document on this turn and every turn after it.
 */
export async function ensureParsed(host: SessionHost, attachment: Attachment): Promise<void> {
  if (attachment.kind !== "pdf") return;
  if (host.exec(`SELECT attachment_id FROM file_cache WHERE attachment_id = ?`, attachment.id)[0]) {
    return;
  }
  const base64 = await readBase64(host, attachment.path);
  if (!base64) return;

  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${host.openrouterKey()}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: host.model(),
        // One token is enough: the annotation is attached to the message either way,
        // and nothing here reads what the model actually said.
        max_tokens: 1,
        usage: { include: true },
        plugins: [{ id: "file-parser", pdf: { engine: PDF_PARSE_ENGINE } }],
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "." },
              {
                type: "file",
                file: {
                  filename: attachment.name,
                  file_data: `data:application/pdf;base64,${base64}`,
                },
              },
            ],
          },
        ],
      }),
    });
    if (!res.ok) {
      console.error(
        `pdf parse ${res.status} for ${attachment.id}: ${(await res.text()).slice(0, 500)}`
      );
      return;
    }
    const json = (await res.json()) as {
      choices?: { message?: { annotations?: FileAnnotation[] } }[];
      usage?: { cost?: number };
    };
    // The parse is billed on this call, so it belongs to the turn that triggered it.
    if (typeof json.usage?.cost === "number") host.usage().reported += json.usage.cost;

    const files = (json.choices?.[0]?.message?.annotations ?? []).filter((a) => a?.type === "file");
    if (files.length === 0) {
      console.error(`pdf parse returned no annotations for ${attachment.id}`);
      return;
    }
    await cacheFileAnnotations(host, files);
    console.log(
      `parsed ${attachment.name} (${attachment.id}) once with ${PDF_PARSE_ENGINE}, cost ${json.usage?.cost ?? "?"}`
    );
  } catch (err) {
    // A failed parse is not a failed turn: the PDF is still sent as a file, and the
    // only cost is that OpenRouter parses it again on the way through.
    console.error(
      `pdf parse failed for ${attachment.id}: ${err instanceof Error ? err.message : err}`
    );
  }
}

/**
 * Keep what the parse actually said, against the attachment it came from.
 *
 * Only the text is kept. A parse also carries a rendered image per page, and those
 * are the bulk of it — worth nothing to a model that reads text, and worth their
 * weight in tokens to one that does not. The words are what a question about a
 * document is answered from.
 *
 * The annotation names the file and nothing else, so the newest PDF with that name
 * wins the match, and an annotation matching nothing is dropped.
 */
export async function cacheFileAnnotations(
  host: SessionHost,
  files: FileAnnotation[]
): Promise<void> {
  for (const annotation of files) {
    const name = annotation.file?.name;
    if (!name) continue;
    const row = host.exec<{ id: string }>(
      `SELECT id FROM attachments WHERE kind = 'pdf' AND name = ? ORDER BY ts DESC LIMIT 1`,
      name
    )[0];
    if (!row) continue;
    if (host.exec(`SELECT attachment_id FROM file_cache WHERE attachment_id = ?`, row.id)[0])
      continue;
    const text = annotationText(annotation);
    if (!text.trim()) {
      console.error(`pdf parse for ${row.id} carried no text`);
      continue;
    }
    // Kept out of `uploads/`, and out of any directory the read and list tools walk:
    // the parse is plumbing, and a model that finds it sitting beside the PDF will
    // open it, reason about it, and spend a turn's tool budget on a cache file.
    const path = `${PARSE_CACHE_DIR}/${row.id}.txt`;
    try {
      await host.workspace.writeFile(path, text, "text/plain");
      host.exec(
        `INSERT OR REPLACE INTO file_cache (attachment_id, path, ts) VALUES (?, ?, ?)`,
        row.id,
        path,
        Date.now()
      );
    } catch (err) {
      // Caching is an optimisation; failing to cache costs a re-parse, nothing more.
      console.error(
        `file cache write failed for ${row.id}: ${err instanceof Error ? err.message : err}`
      );
    }
  }
}

/**
 * Images and PDFs as model content parts. They are sent with the message rather
 * than read through a tool: a tool result has to be text, so handing a page back
 * that way is not something an OpenAI-shaped API will accept.
 */
export async function fileParts(
  host: SessionHost,
  attachments: Attachment[],
  skip: Set<string> = new Set()
): Promise<
  (
    | { type: "image"; image: string }
    | { type: "file"; data: string; mediaType: string; filename: string }
  )[]
> {
  const parts: (
    | { type: "image"; image: string }
    | { type: "file"; data: string; mediaType: string; filename: string }
  )[] = [];
  for (const a of attachments) {
    if (a.kind !== "image" && a.kind !== "pdf") continue;
    if (skip.has(a.id)) continue;
    const base64 = await readBase64(host, a.path);
    if (!base64) continue;
    parts.push(
      a.kind === "image"
        ? { type: "image", image: `data:${a.mime};base64,${base64}` }
        : {
            type: "file",
            data: `data:application/pdf;base64,${base64}`,
            mediaType: "application/pdf",
            filename: a.name,
          }
    );
  }
  return parts;
}
