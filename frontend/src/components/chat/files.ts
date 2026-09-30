import type { Attachment } from "@/lib/agent";

/** Where the browser reads an attachment's bytes from. */
export function fileUrl(sessionId: string, id: string) {
  return `/api/sessions/${encodeURIComponent(sessionId)}/files/${encodeURIComponent(id)}`;
}

/** The render of a PDF's first page, drawn at the head of its card. */
export function thumbUrl(sessionId: string, id: string) {
  return `${fileUrl(sessionId, id)}/thumb`;
}

/** Softens the last line of a file preview, so the cut reads as a sample. */
export const FADE = "linear-gradient(to bottom, #000 55%, transparent 100%)";

/** A voice note is stored as a text attachment; only its mime type gives it away. */
export function isAudio(a: Attachment) {
  return a.mime.startsWith("audio/") || a.mime.startsWith("video/");
}
