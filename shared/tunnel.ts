// At 20 Mbit/s a small frame queued behind a 256 KiB chunk on the same socket waits about 100 ms.
// A GiB is 4,096 chunks, or about 205 billed requests because Durable Objects count 20 incoming
// WebSocket messages as one request.
export const MAX_CHUNK_BYTES = 256 * 1024;
// A stream's throughput is at most its window divided by the credit round-trip time (about
// 49 Mbit/s for 1 MiB at an effective 170 ms round trip on staging, 2026-11-25).
export const DEFAULT_WINDOW_BYTES = 1024 * 1024;

const STREAM_DATA = 1;
const HEADER_BYTES = 5;
const CHUNK_TOO_LARGE = `Chunk payload exceeds ${MAX_CHUNK_BYTES} bytes`;

export function encodeChunk(streamId: number, payload: Uint8Array): Uint8Array<ArrayBuffer> {
  if (!Number.isInteger(streamId) || streamId < 0 || streamId > 0xffff_ffff) {
    throw new RangeError("Stream id must be an unsigned 32-bit integer");
  }
  if (payload.byteLength > MAX_CHUNK_BYTES) throw new RangeError(CHUNK_TOO_LARGE);

  const frame = new Uint8Array(HEADER_BYTES + payload.byteLength);
  frame[0] = STREAM_DATA;
  new DataView(frame.buffer).setUint32(1, streamId, false);
  frame.set(payload, HEADER_BYTES);
  return frame;
}

type DecodedChunk =
  | { ok: true; streamId: number; payload: Uint8Array }
  | { ok: false; error: string };

export function decodeChunk(frame: Uint8Array): DecodedChunk {
  if (frame.byteLength < HEADER_BYTES) return { ok: false, error: "Truncated chunk header" };
  if (frame[0] !== STREAM_DATA) return { ok: false, error: "Unknown frame kind" };
  if (frame.byteLength - HEADER_BYTES > MAX_CHUNK_BYTES) {
    return { ok: false, error: CHUNK_TOO_LARGE };
  }

  const header = new DataView(frame.buffer, frame.byteOffset, HEADER_BYTES);
  return { ok: true, streamId: header.getUint32(1, false), payload: frame.subarray(HEADER_BYTES) };
}

function isByteCount(bytes: number): boolean {
  return Number.isSafeInteger(bytes) && bytes >= 0;
}

// Each side counts outstanding bytes independently, so a peer cannot increase the opening window.
function creditWindow(capacity: number) {
  if (!isByteCount(capacity)) throw new RangeError("Invalid opening credit");
  let outstanding = 0;

  return {
    reserve(bytes: number): boolean {
      if (!isByteCount(bytes) || bytes > capacity - outstanding) return false;
      outstanding += bytes;
      return true;
    },
    release(bytes: number): boolean {
      if (!isByteCount(bytes) || bytes > outstanding) return false;
      outstanding -= bytes;
      return true;
    },
  };
}

export function createSenderWindow(openingCredit: number) {
  const window = creditWindow(openingCredit);
  return { trySend: window.reserve, grant: window.release };
}

export function createReceiverWindow(openingCredit = DEFAULT_WINDOW_BYTES) {
  const window = creditWindow(openingCredit);
  return {
    receive: window.reserve,
    // Grant these bytes back to the sender only if consume succeeds.
    consume: window.release,
  };
}
