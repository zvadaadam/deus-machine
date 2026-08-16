/**
 * UUIDv7 generator (RFC 9562).
 * Time-sortable: 48-bit ms timestamp prefix + 74 random bits.
 * Returns lowercase 8-4-4-4-12 string (same format as UUIDv4).
 *
 * Why not an npm package: ~15 lines, zero deps beyond the WebCrypto global.
 * Isomorphic on purpose — backend, agent-server AND the renderer import from
 * here (the composer mints the turn id that correlates its optimistic bubble
 * with the engine's user echo), so this file must not reach for node:crypto.
 */
export function uuidv7(): string {
  const now = Date.now();
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);

  // Bytes 0-5: 48-bit big-endian millisecond timestamp
  bytes[0] = (now / 2 ** 40) & 0xff;
  bytes[1] = (now / 2 ** 32) & 0xff;
  bytes[2] = (now / 2 ** 24) & 0xff;
  bytes[3] = (now / 2 ** 16) & 0xff;
  bytes[4] = (now / 2 ** 8) & 0xff;
  bytes[5] = now & 0xff;

  // Byte 6: version 7 (0111 xxxx)
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  // Byte 8: variant 10 (10xx xxxx)
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
