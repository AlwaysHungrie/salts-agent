import { acceptsUploads, enabled, withMcpAuth } from "../capabilities";
import type { McpServerRow } from "../mcp";
import { annotationText, type FileAnnotation } from "../openrouter";
import type { Config } from "../registry";
import { toArrayBuffer } from "../util/bytes";
import { readBase64 } from "./attachments";
import { PARSE_CACHE_DIR } from "./files";
import type { Attachment, SessionHost } from "./types";

/**
 * OpenRouter's PDF parser: `mistral-ocr` reads scans and tables. Billed per page, so a
 * document is parsed once per session and replayed.
 */
export const PDF_PARSE_ENGINE = "mistral-ocr";

/**
 * Upload each PDF to every connected server that takes uploads, and name its id for the
 * model (which cannot copy bytes into a tool call). Once per server; retried on failure.
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

/** The text of every parsed attachment. A row whose file is missing is forgotten. */
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
    // Legacy whole-JSON parse caches are dropped, not fed to the model.
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
 * Parse a PDF on the first turn that needs it, with a separate non-streamed request
 * (OpenRouter only returns annotations there). The reply is discarded; the parse is kept.
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
 * Cache the text of each parse against its attachment (page images are dropped). The
 * annotation only names the file, so the newest PDF with that name wins.
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
    // Outside any directory the model's tools walk, or it would read the cache file.
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
 * Images and PDFs as content parts: a tool result must be text, so they cannot come back
 * through a tool.
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
