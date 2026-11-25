import { describe, expect, it } from "vitest";
import {
  createReceiverWindow,
  createSenderWindow,
  decodeChunk,
  DEFAULT_WINDOW_BYTES,
  encodeChunk,
  MAX_CHUNK_BYTES,
} from "@shared/tunnel";

describe("stream data frames", () => {
  it("writes the kind and unsigned big-endian id, and reads a frame at a nonzero offset", () => {
    const streamId = 0xfedcba98;
    const payload = Uint8Array.of(12, 34, 56).subarray(1);
    const frame = encodeChunk(streamId, payload);
    expect([...frame]).toEqual([1, 0xfe, 0xdc, 0xba, 0x98, 34, 56]);

    const packet = Uint8Array.of(99, ...frame, 88);
    expect(decodeChunk(packet.subarray(1, -1))).toEqual({ ok: true, streamId, payload });
  });

  it("accepts both an empty payload and exactly 256 KiB", () => {
    expect(MAX_CHUNK_BYTES).toBe(256 * 1024);
    for (const length of [0, MAX_CHUNK_BYTES]) {
      const frame = encodeChunk(0xffff_ffff, new Uint8Array(length));
      const decoded = decodeChunk(frame);
      if (!decoded.ok) throw new Error(decoded.error);
      expect(decoded.streamId).toBe(0xffff_ffff);
      expect(decoded.payload.byteLength).toBe(length);
    }
  });

  it("returns a header error for every truncated frame", () => {
    for (let length = 0; length < 5; length++) {
      expect(decodeChunk(new Uint8Array(length))).toEqual({
        ok: false,
        error: expect.stringMatching(/header/i),
      });
    }
  });

  it("returns a kind error for an unknown frame kind", () => {
    expect(decodeChunk(Uint8Array.of(2, 0, 0, 0, 0))).toEqual({
      ok: false,
      error: expect.stringMatching(/kind/i),
    });
  });

  it("returns a size error for a payload one byte over the limit", () => {
    const oversized = new Uint8Array(5 + MAX_CHUNK_BYTES + 1);
    oversized[0] = 1;
    expect(decodeChunk(oversized)).toEqual({ ok: false, error: expect.stringMatching(/exceeds/i) });
  });

  it("refuses to encode a wrapped or fractional id or an oversized payload", () => {
    for (const id of [-1, 2 ** 32, 0.5, NaN]) {
      expect(() => encodeChunk(id, new Uint8Array())).toThrow(RangeError);
    }
    expect(() => encodeChunk(0, new Uint8Array(MAX_CHUNK_BYTES + 1))).toThrow(RangeError);
  });
});

describe("stream credit", () => {
  it("limits the sender to its opening credit and restores only acknowledged bytes", () => {
    const sender = createSenderWindow(8);
    expect(sender.trySend(5)).toBe(true);
    expect(sender.grant(6)).toBe(false);
    expect(sender.trySend(4)).toBe(false);
    expect(sender.trySend(3)).toBe(true);
    expect(sender.trySend(1)).toBe(false);
    expect(sender.grant(2)).toBe(true);
    expect(sender.trySend(3)).toBe(false);
    expect(sender.trySend(2)).toBe(true);
  });

  it("refuses over-window receives and grants back only consumed bytes", () => {
    expect(DEFAULT_WINDOW_BYTES).toBe(1024 * 1024);
    const receiver = createReceiverWindow();
    expect(receiver.receive(DEFAULT_WINDOW_BYTES - 1)).toBe(true);
    expect(receiver.consume(DEFAULT_WINDOW_BYTES)).toBe(false);
    expect(receiver.receive(2)).toBe(false);
    expect(receiver.receive(1)).toBe(true);
    expect(receiver.consume(7)).toBe(true);
    expect(receiver.receive(8)).toBe(false);
    expect(receiver.receive(7)).toBe(true);
    expect(receiver.consume(DEFAULT_WINDOW_BYTES)).toBe(true);
    expect(receiver.consume(1)).toBe(false);
  });

  it("refuses invalid byte counts without changing either window", () => {
    const sender = createSenderWindow(4);
    const receiver = createReceiverWindow(4);
    for (const bytes of [-1, 0.5, NaN, Infinity, 2 ** 53]) {
      expect(() => createSenderWindow(bytes)).toThrow(RangeError);
      expect(() => createReceiverWindow(bytes)).toThrow(RangeError);
      expect(sender.trySend(bytes)).toBe(false);
      expect(sender.grant(bytes)).toBe(false);
      expect(receiver.receive(bytes)).toBe(false);
      expect(receiver.consume(bytes)).toBe(false);
    }
    expect(sender.trySend(4)).toBe(true);
    expect(receiver.receive(4)).toBe(true);
    expect(sender.trySend(1)).toBe(false);
    expect(receiver.receive(1)).toBe(false);
  });

  it("delivers 200 chunks in order while a slow consumer holds the sender to its window", () => {
    const windowBytes = 31;
    const chunkBytes = 7;
    const source = Uint8Array.from({ length: 200 * chunkBytes }, (_, i) => i % 251);
    const sender = createSenderWindow(windowBytes);
    const receiver = createReceiverWindow(windowBytes);
    const pending: number[] = [];
    const delivered: number[] = [];
    let sent = 0;

    while (delivered.length < source.length) {
      while (sent < source.length && sender.trySend(chunkBytes)) {
        const frame = encodeChunk(3, source.subarray(sent, sent + chunkBytes));
        const chunk = decodeChunk(frame);
        if (!chunk.ok) throw new Error(chunk.error);
        expect(receiver.receive(chunk.payload.byteLength)).toBe(true);
        pending.push(...chunk.payload);
        sent += chunkBytes;
        expect(sent - delivered.length).toBeLessThanOrEqual(windowBytes);
      }
      // The producer fills every available slot before the consumer takes another three bytes.
      if (sent < source.length) {
        expect(sent - delivered.length + chunkBytes).toBeGreaterThan(windowBytes);
      }
      const consumed = pending.splice(0, 3);
      expect(consumed.length).toBeGreaterThan(0);
      delivered.push(...consumed);
      expect(receiver.consume(consumed.length)).toBe(true);
      expect(sender.grant(consumed.length)).toBe(true);
    }
    expect(delivered).toEqual([...source]);
  });
});
