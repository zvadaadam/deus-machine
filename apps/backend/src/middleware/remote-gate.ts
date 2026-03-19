// backend/src/middleware/remote-gate.ts
// Rejects non-localhost requests when remote access is disabled.
// Uses a 5s cache to avoid DB reads on every request.

import { createMiddleware } from "hono/factory";
import { getAllSettings } from "../services/settings.service";
import { isLocalhost, getClientIp } from "../lib/network";

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

/**
 * If remote_access_enabled is false, reject any non-localhost request with 403.
 * Localhost requests always pass through (desktop app is unaffected).
 */
export const remoteGateMiddleware = createMiddleware(async (c, next) => {
  const clientIp = getClientIp(c);

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
