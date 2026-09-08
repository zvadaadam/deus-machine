/** Cloud credentials require TLS; HTTP is only for a local development server. */
export function assertSecureCloudUrl(raw: string): void {
  const url = new URL(raw);
  const loopback =
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("Cloud URLs must use HTTPS except on localhost.");
  }
}
