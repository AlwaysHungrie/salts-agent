import { enabled } from "../capabilities";
import { bytesToBase64, toArrayBuffer } from "../util/bytes";
import { getAttachment } from "./attachments";
import { audioFormat, isAudioAttachment } from "./files";
import type { SessionHost } from "./types";

/**
 * Transcribe audio through an OpenRouter chat model (there is no transcription route),
 * billed to the agent's existing key.
 */
export async function transcribe(
  host: SessionHost,
  bytes: ArrayBuffer,
  mime: string,
  name: string
): Promise<string> {
  const format = audioFormat(mime, name);
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${host.openrouterKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: host.config().transcription_model,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Transcribe this audio verbatim. Reply with the transcript alone — no preamble, no commentary, no quotation marks.",
            },
            { type: "input_audio", input_audio: { data: bytesToBase64(bytes), format } },
          ],
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`transcription ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return (json.choices?.[0]?.message?.content ?? "").trim();
}

/**
 * Transcribe a stored clip on demand, and cache the words on its row so a second
 * call — or a reopened session — does not pay for the same audio twice.
 */
export async function transcribeAttachment(host: SessionHost, id: string): Promise<string> {
  const row = getAttachment(host, id);
  if (!row) return `No attachment with id ${id}.`;
  if (!isAudioAttachment(row)) return `${row.name} is not audio.`;
  if (row.text.trim()) return row.text;
  if (!enabled(host.config(), "audio_input")) {
    return "Audio input is off. Turn it on under Capabilities.";
  }
  const bytes = row.path ? await host.workspace.readFileBytes(row.path) : null;
  if (!bytes) return `The bytes for ${row.name} are gone.`;
  const transcript = await transcribe(host, toArrayBuffer(bytes), row.mime, row.name);
  host.exec(`UPDATE attachments SET text = ? WHERE id = ?`, transcript, id);
  return transcript;
}
