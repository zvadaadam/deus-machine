import type { Size } from "./units.js";

/**
 * Splits a concatenated JPEG stream (ffmpeg `image2pipe`) into frames.
 *
 * Walks marker segments by their declared length, so bytes inside headers can
 * never be mistaken for an end-of-image marker; inside entropy-coded data a
 * literal 0xFF is always stuffed as 0xFF00, leaving 0xFFD9 unambiguous.
 */
export class JpegSplitter {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): Buffer[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const frames: Buffer[] = [];
    for (;;) {
      const end = findImageEnd(this.buffer);
      if (end < 0) break;
      frames.push(this.buffer.subarray(0, end));
      this.buffer = this.buffer.subarray(end);
    }
    return frames;
  }

  get pendingBytes(): number {
    return this.buffer.length;
  }
}

/** Byte offset just past the first complete image, or -1 if incomplete. */
function findImageEnd(buf: Buffer): number {
  if (buf.length < 4) return -1;
  if (buf[0] !== 0xff || buf[1] !== 0xd8) {
    const start = buf.indexOf(Buffer.from([0xff, 0xd8]));
    throw new Error(`JPEG stream out of sync${start > 0 ? ` (next image at byte ${start})` : ""}`);
  }
  let i = 2;
  let scanStarted = false;
  // Header segments: each has a 2-byte big-endian length.
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) throw new Error("Malformed JPEG header");
    const marker = buf[i + 1];
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    if (marker === 0xd9) return i + 2;
    const length = buf.readUInt16BE(i + 2);
    i += 2 + length;
    if (marker === 0xda) {
      scanStarted = true;
      break;
    }
  }
  if (!scanStarted) return -1;
  // Entropy-coded data until EOI.
  for (; i + 1 < buf.length; i++) {
    if (buf[i] !== 0xff) continue;
    const next = buf[i + 1];
    if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) continue;
    if (next === 0xd9) return i + 2;
  }
  return -1;
}

/** Pixel dimensions from the first SOF marker, without decoding. */
export function jpegSize(buf: Buffer): Size | null {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    const length = buf.readUInt16BE(i + 2);
    const isFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isFrame) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    if (marker === 0xda) return null;
    i += 2 + length;
  }
  return null;
}
