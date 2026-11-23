export function isBinaryContent(bytes: Uint8Array): boolean {
  return bytes.subarray(0, 8192).includes(0);
}
