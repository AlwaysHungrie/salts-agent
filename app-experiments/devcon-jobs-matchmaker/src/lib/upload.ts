import "server-only";
import { Binary } from "mongodb";
import { resumeParts } from "./db";
import { Refusal } from "./http";
import { partBytes, type ResumePart } from "./rules";

/**
 * The parts of an upload joined in order, or null when any is missing or the wrong size.
 * `found` may arrive in any order.
 */
export function joinParts(found: { part: number; data: Uint8Array }[], parts: number, size: number): Uint8Array<ArrayBuffer> | null {
  if (found.length !== parts) return null;
  const sorted = [...found].sort((a, b) => a.part - b.part);
  const out = new Uint8Array(size);
  let at = 0;
  for (const [i, { part, data }] of sorted.entries()) {
    if (part !== i || data.byteLength !== partBytes(i, size)) return null;
    out.set(data, at);
    at += data.byteLength;
  }
  return at === size ? out : null;
}

/**
 * Keep one part of a user's resume upload. The first part drops any earlier upload of
 * theirs, so a user holds at most one. Answers with the whole file once the last part
 * is in, and null until then. Parts are sent one after another, so the last arrives last.
 */
export async function savePart(userId: string, meta: ResumePart, bytes: Uint8Array): Promise<File | null> {
  const { uploadId, part, parts, size, name } = meta;
  const col = await resumeParts();
  if (part === 0) await col.deleteMany({ userId });
  await col.replaceOne(
    { userId, uploadId, part },
    { userId, uploadId, part, parts, size, name, data: new Binary(bytes), createdAt: new Date() },
    { upsert: true },
  );
  if (part < parts - 1) return null;

  const docs = await col.find({ userId, uploadId, parts, size }).toArray();
  await col.deleteMany({ userId, uploadId });
  const whole = joinParts(
    docs.map((d) => ({ part: d.part, data: d.data.buffer })),
    parts,
    size,
  );
  if (!whole) throw new Refusal("Part of your resume went missing. Try again.", 400);
  return new File([whole], name, { type: "application/pdf" });
}
