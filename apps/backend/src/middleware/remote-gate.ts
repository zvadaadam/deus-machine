// backend/src/middleware/remote-gate.ts
// Rejects non-localhost requests when remote access is disabled.

import { createMiddleware } from "hono/factory";
import { getSetting } from "../services/settings.service";
import { isLocalhost, getClientIp } from "../lib/network";

function isRemoteEnabled(): boolean {
  const enabled = getSetting("remote_access_enabled");
  return enabled === true || enabled === "true";
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
