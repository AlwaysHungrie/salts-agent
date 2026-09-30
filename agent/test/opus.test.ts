import { describe, expect, it } from "vitest";
import { isVoiceNote } from "../src/channel";
import { VOICE_SAMPLE_RATE, pcm16ToOggOpus } from "../src/opus";

/** A second of tone, which is what the speaking model hands over the shape of. */
function tone(seconds: number): Int16Array {
  const pcm = new Int16Array(Math.round(VOICE_SAMPLE_RATE * seconds));
  for (let i = 0; i < pcm.length; i++) {
    pcm[i] = Math.round(8000 * Math.sin((2 * Math.PI * 220 * i) / VOICE_SAMPLE_RATE));
  }
  return pcm;
}

/** Ogg pages, as a reader finds them: each one starts with its own capture pattern. */
function pages(file: Uint8Array): { headerType: number; granule: bigint; sequence: number }[] {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const found: { headerType: number; granule: bigint; sequence: number }[] = [];
  for (let at = 0; at + 27 <= file.length;) {
    expect(String.fromCharCode(...file.subarray(at, at + 4))).toBe("OggS");
    const segments = file[at + 26];
    let payload = 0;
    for (let i = 0; i < segments; i++) payload += file[at + 27 + i];
    found.push({
      headerType: file[at + 5],
      granule: view.getBigUint64(at + 6, true),
      sequence: view.getUint32(at + 18, true),
    });
    at += 27 + segments + payload;
  }
  return found;
}

describe("packing samples into a voice note", () => {
  it("writes a file both chat apps will play", () => {
    const file = pcm16ToOggOpus(tone(1));
    // The same check `channel.sendVoice` makes before either channel is handed bytes.
    expect(isVoiceNote(file.buffer as ArrayBuffer)).toBe(true);
    // Encoded, not merely wrapped: a second of speech at 24 kbit/s is a few kilobytes,
    // against the 48000 the samples took.
    expect(file.length).toBeGreaterThan(1000);
    expect(file.length).toBeLessThan(12000);
  });

  it("opens with the two headers Opus requires, and marks the ends of the stream", () => {
    const file = pcm16ToOggOpus(tone(1));
    const found = pages(file);
    expect(found.length).toBeGreaterThan(2);
    // The identification page begins the stream and carries no audio yet.
    expect(found[0].headerType).toBe(0x02);
    expect(found[0].granule).toBe(0n);
    const text = new TextDecoder().decode(file.subarray(0, 200));
    expect(text).toContain("OpusHead");
    expect(text).toContain("OpusTags");
    // Sequence numbers run unbroken, and the last page says it is the last.
    expect(found.map((p) => p.sequence)).toEqual(found.map((_, i) => i));
    expect(found[found.length - 1].headerType).toBe(0x04);
  });

  it("counts granule positions at 48 kHz, whatever rate went in", () => {
    const file = pcm16ToOggOpus(tone(1));
    const found = pages(file);
    // A second of 24 kHz audio is 48000 samples once Ogg has restated it.
    expect(found[found.length - 1].granule).toBe(48000n);
    // And they only ever climb.
    const audio = found.slice(2).map((p) => p.granule);
    expect([...audio].sort((a, b) => Number(a - b))).toEqual(audio);
  });

  it("keeps the tail of a sentence that does not fill a frame", () => {
    // 20 ms frames at 24 kHz is 480 samples; 500 leaves a frame nearly empty, which is
    // padded rather than dropped.
    const file = pcm16ToOggOpus(tone(500 / VOICE_SAMPLE_RATE));
    expect(isVoiceNote(file.buffer as ArrayBuffer)).toBe(true);
    expect(pages(file)[pages(file).length - 1].granule).toBe(1920n);
  });

  it("says nothing, validly, when handed nothing", () => {
    const file = pcm16ToOggOpus(new Int16Array(0));
    expect(isVoiceNote(file.buffer as ArrayBuffer)).toBe(true);
    expect(pages(file)[pages(file).length - 1].headerType).toBe(0x04);
  });
});
