/**
 * Pack PCM samples into Ogg Opus, the only container Telegram and WhatsApp play as a
 * voice note. libopus runs as WebAssembly; the Ogg framing is written by hand.
 */

import wasmModule from "@evan/opus/wasm/opus.wasm";

/**
 * What the speaking model hands back: 24 kHz mono, 16-bit little-endian. Opus takes
 * that rate as it is, so nothing is resampled.
 */
export const VOICE_SAMPLE_RATE = 24000;

/** A voice note is speech, and 24 kbit/s of mono Opus is more than speech needs. */
const BITRATE = 24000;

/**
 * One packet per 20 ms, the rate everything that records speech uses. It decides both
 * the encoder's frame size and the granule step, which is why it lives up here.
 */
const FRAME_MS = 20;

/** libopus constants. `voip` is the application tuned for speech rather than music. */
const APPLICATION_VOIP = 2048;
const OPUS_SET_BITRATE = 4002;
const OPUS_GET_LOOKAHEAD = 4027;

/** Scratch space inside the instance: one buffer in, one out, reused every frame. */
const PCM_CAPACITY = 32768;
const PACKET_CAPACITY = 8192;

/**
 * The WASM instance, once per isolate. The memory view is retaken on growth, since
 * growing detaches existing views.
 */
let wasm: OpusExports;
let memory: Uint8Array;
let pcmPtr = 0;
let packetPtr = 0;

type OpusExports = {
  memory: WebAssembly.Memory;
  malloc: (size: number) => number;
  free: (ptr: number) => void;
  opus_strerror: (code: number) => number;
  opus_encoder_get_size: (channels: number) => number;
  opus_encoder_init: (ptr: number, rate: number, channels: number, application: number) => number;
  opus_encoder_ctl_set: (ptr: number, request: number, value: number) => number;
  opus_encoder_ctl_get: (ptr: number, request: number) => number;
  opus_encode: (
    ptr: number,
    pcm: number,
    samplesPerChannel: number,
    out: number,
    capacity: number
  ) => number;
};

function instance(): OpusExports {
  if (wasm) return wasm;
  const built = new WebAssembly.Instance(wasmModule as WebAssembly.Module, {
    wasi_snapshot_preview1: {
      fd_seek: () => 0,
      fd_write: () => 0,
      fd_close: () => 0,
      proc_exit: () => {},
    },
    env: {
      emscripten_notify_memory_growth: () => {
        memory = new Uint8Array(wasm.memory.buffer);
      },
    },
  });
  wasm = built.exports as unknown as OpusExports;
  pcmPtr = wasm.malloc(PCM_CAPACITY);
  packetPtr = wasm.malloc(PACKET_CAPACITY);
  memory = new Uint8Array(wasm.memory.buffer);
  return wasm;
}

/** What libopus says went wrong, rather than the number it says it with. */
function checked(code: number): number {
  if (code >= 0) return code;
  let message = "";
  for (let at = wasm.opus_strerror(code); memory[at] !== 0; at++) {
    message += String.fromCharCode(memory[at]);
  }
  return ((): never => {
    throw new Error(`opus: ${message || code}`);
  })();
}

/** Mono samples to a voice note; a trailing partial frame is padded with silence. */
export function pcm16ToOggOpus(pcm: Int16Array, sampleRate = VOICE_SAMPLE_RATE): Uint8Array {
  const api = instance();
  const samplesPerFrame = (sampleRate / 1000) * FRAME_MS;
  const encoder = api.malloc(api.opus_encoder_get_size(1));
  try {
    checked(api.opus_encoder_init(encoder, sampleRate, 1, APPLICATION_VOIP));
    checked(api.opus_encoder_ctl_set(encoder, OPUS_SET_BITRATE, BITRATE));
    // Encoder pre-skip, stated at 48 kHz (the rate all granule positions use).
    const preSkip = Math.round(
      (api.opus_encoder_ctl_get(encoder, OPUS_GET_LOOKAHEAD) * 48000) / sampleRate
    );

    const ogg = new Ogg();
    ogg.page([identification(preSkip, sampleRate)], { first: true });
    ogg.page([comment()]);

    const frames = Math.ceil(pcm.length / samplesPerFrame);
    const frame = new Int16Array(samplesPerFrame);
    const granuleStep = (48000 / 1000) * FRAME_MS;
    let batch: Uint8Array[] = [];
    let granule = 0;
    for (let i = 0; i < frames; i++) {
      frame.fill(0);
      frame.set(pcm.subarray(i * samplesPerFrame, Math.min(pcm.length, (i + 1) * samplesPerFrame)));
      batch.push(encode(api, encoder, frame));
      granule += granuleStep;
      // A page holds at most 255 segments, so it cannot hold an unbounded number of
      // packets. Fifty 20 ms frames is a second of speech per page, well inside that.
      const last = i === frames - 1;
      if (batch.length === 50 || last) {
        ogg.page(batch, { granule, last });
        batch = [];
      }
    }
    // Nothing was said: still a valid file, just an empty one.
    if (frames === 0) ogg.page([], { granule: 0, last: true });
    return ogg.done();
  } finally {
    api.free(encoder);
  }
}

/** One frame in, one Opus packet out, through the buffers the instance already holds. */
function encode(api: OpusExports, encoder: number, frame: Int16Array): Uint8Array {
  memory.set(new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength), pcmPtr);
  const size = checked(api.opus_encode(encoder, pcmPtr, frame.length, packetPtr, PACKET_CAPACITY));
  return memory.slice(packetPtr, packetPtr + size);
}

/* -------------------------------------------------------------------- ogg -- */

/** The Opus identification header, which `isVoiceNote` checks for. */
function identification(preSkip: number, sampleRate: number): Uint8Array {
  const head = new Uint8Array(19);
  const view = new DataView(head.buffer);
  head.set(ascii("OpusHead"), 0);
  head[8] = 1; // version
  head[9] = 1; // channels
  view.setUint16(10, preSkip, true);
  view.setUint32(12, sampleRate, true);
  view.setInt16(16, 0, true); // output gain
  head[18] = 0; // channel mapping family: mono/stereo
  return head;
}

/** The comment header, which Opus requires and nothing here has anything to say in. */
function comment(): Uint8Array {
  const vendor = ascii("salt-agent");
  const tags = new Uint8Array(8 + 4 + vendor.length + 4);
  const view = new DataView(tags.buffer);
  tags.set(ascii("OpusTags"), 0);
  view.setUint32(8, vendor.length, true);
  tags.set(vendor, 12);
  view.setUint32(12 + vendor.length, 0, true); // no user comments
  return tags;
}

/**
 * Ogg pages: header, segment table, packets. The CRC covers the page with its field
 * zeroed, so it is written last.
 */
class Ogg {
  /** One logical stream, named by any number; a voice note has nothing to collide with. */
  private readonly serial = 0x5a17a6e7;
  private sequence = 0;
  private readonly pages: Uint8Array[] = [];

  page(packets: Uint8Array[], { granule = 0, first = false, last = false } = {}) {
    const segments: number[] = [];
    for (const packet of packets) {
      let left = packet.length;
      while (left >= 255) {
        segments.push(255);
        left -= 255;
      }
      // A final segment under 255 is what ends a packet, so a packet whose length is a
      // multiple of 255 ends with a zero.
      segments.push(left);
    }
    const payload = packets.reduce((total, p) => total + p.length, 0);
    const page = new Uint8Array(27 + segments.length + payload);
    const view = new DataView(page.buffer);
    page.set(ascii("OggS"), 0);
    page[4] = 0; // stream structure version
    page[5] = (first ? 0x02 : 0) | (last ? 0x04 : 0);
    view.setBigUint64(6, BigInt(granule), true);
    view.setUint32(14, this.serial, true);
    view.setUint32(18, this.sequence++, true);
    view.setUint32(22, 0, true); // checksum, filled in below
    page[26] = segments.length;
    page.set(segments, 27);
    let at = 27 + segments.length;
    for (const packet of packets) {
      page.set(packet, at);
      at += packet.length;
    }
    view.setUint32(22, crc32(page), true);
    this.pages.push(page);
  }

  done(): Uint8Array {
    const file = new Uint8Array(this.pages.reduce((total, p) => total + p.length, 0));
    let at = 0;
    for (const page of this.pages) {
      file.set(page, at);
      at += page.length;
    }
    return file;
  }
}

/**
 * Ogg's checksum: CRC-32 with the same polynomial as everything else and none of the
 * reflection — bits high to low, no initial value, no final inversion.
 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let value = i << 24;
    for (let bit = 0; bit < 8; bit++) {
      value = value & 0x80000000 ? ((value << 1) ^ 0x04c11db7) >>> 0 : (value << 1) >>> 0;
    }
    table[i] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0;
  for (const byte of bytes) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ byte) & 0xff]) >>> 0;
  return crc >>> 0;
}

function ascii(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  return bytes;
}
