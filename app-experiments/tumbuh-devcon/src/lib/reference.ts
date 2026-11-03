import { head, put } from "@vercel/blob";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * The one picture the site keeps, a single object overwritten each time. No database.
 * On Vercel it is a Blob (BLOB_READ_WRITE_TOKEN); locally, a file.
 */
const NAME = "reference.jpg";
const FILE = path.join(process.cwd(), "data", NAME);
const blob = () => !!process.env.BLOB_READ_WRITE_TOKEN;

export async function readReference(): Promise<Buffer | null> {
  try {
    if (blob()) {
      const { url } = await head(NAME);
      const res = await fetch(url, { cache: "no-store" });
      return res.ok ? Buffer.from(await res.arrayBuffer()) : null;
    }
    return await readFile(FILE);
  } catch {
    return null;
  }
}

export async function writeReference(bytes: Buffer): Promise<void> {
  if (blob()) {
    await put(NAME, bytes, {
      access: "public",
      contentType: "image/jpeg",
      addRandomSuffix: false,
      allowOverwrite: true,
    });
    return;
  }
  await mkdir(path.dirname(FILE), { recursive: true });
  await writeFile(FILE, bytes);
}
