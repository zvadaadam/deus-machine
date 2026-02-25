// backend/src/middleware/remote-gate.ts
// Rejects non-localhost requests when remote access is disabled.
// Uses a 5s cache to avoid DB reads on every request.

import { createMiddleware } from "hono/factory";
import { getAllSettings } from "../services/settings.service";

let cachedEnabled = false;
let cacheExpiry = 0;
const CACHE_TTL_MS = 5_000;

function isRemoteEnabled(): boolean {
  const now = Date.now();
  if (now < cacheExpiry) return cachedEnabled;

  const settings = getAllSettings();
  cachedEnabled = settings.remote_access_enabled === true || settings.remote_access_enabled === "true";
  cacheExpiry = now + CACHE_TTL_MS;
  return cachedEnabled;
}

function isLocalhost(ip: string | undefined): boolean {
  if (!ip) return false; // Unknown IP should be treated as remote, not local
  return (
    ip === "127.0.0.1" ||
    ip === "::1" ||
    ip === "::ffff:127.0.0.1" ||
    ip === "localhost"
  );
}

/**
 * If remote_access_enabled is false, reject any non-localhost request with 403.
 * Localhost requests always pass through (desktop app is unaffected).
 */
export const remoteGateMiddleware = createMiddleware(async (c, next) => {
  // Use the TCP socket address first — proxy headers are trivially spoofable
  // when no reverse proxy sits in front of the server.
  // In @hono/node-server, the socket lives at c.env.incoming.socket.
  const clientIp = (c.env as any)?.incoming?.socket?.remoteAddress
    || c.req.header("x-forwarded-for")?.split(",")[0]?.trim()
    || c.req.header("x-real-ip");

  if (isLocalhost(clientIp)) {
    await next();
    return;
  }

  if (!isRemoteEnabled()) {
    return c.json({ error: "Remote access is not enabled" }, 403);
  }

  await next();
});

/** Force-invalidate the settings cache (e.g., after toggling the setting). */
export function invalidateRemoteGateCache(): void {
  cacheExpiry = 0;
}
