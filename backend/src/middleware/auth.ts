// backend/src/middleware/auth.ts
// Bearer token validation for remote access.
// Localhost requests are exempt (desktop app needs zero auth changes).
// Public paths (health, pairing) are also exempt.

import { createMiddleware } from "hono/factory";
import {
  validateDeviceToken,
  updateLastSeen,
  checkRateLimit,
  type PairedDevice,
} from "../services/auth.service";

const PUBLIC_PATHS = new Set([
  "/api/health",
  "/api/auth/pair",
]);

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
 * Auth middleware for remote access.
 * 1. Localhost → skip auth entirely
 * 2. Public paths → skip auth
 * 3. Rate-limited IP → 429
 * 4. Valid Bearer token → attach device to context, update last_seen
 * 5. Missing/invalid token → 401
 */
export const authMiddleware = createMiddleware(async (c, next) => {
  // Use the TCP socket address first — proxy headers are trivially spoofable
  // when no reverse proxy sits in front of the server.
  // In @hono/node-server, the socket lives at c.env.incoming.socket.
  const clientIp = (c.env as any)?.incoming?.socket?.remoteAddress
    || c.req.header("x-forwarded-for")?.split(",")[0]?.trim()
    || c.req.header("x-real-ip");

  // Localhost exempt — desktop app unchanged
  if (isLocalhost(clientIp)) {
    await next();
    return;
  }

  // Public paths exempt
  if (PUBLIC_PATHS.has(c.req.path)) {
    await next();
    return;
  }

  // Rate limit check
  if (clientIp) {
    const lockout = checkRateLimit(clientIp);
    if (lockout > 0) {
      return c.json(
        { error: "Too many failed attempts. Try again later." },
        429,
      );
    }
  }

  // Bearer token validation
  const authHeader = c.req.header("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "Authentication required" }, 401);
  }

  const token = authHeader.slice(7);
  const device = validateDeviceToken(token);
  if (!device) {
    return c.json({ error: "Invalid or revoked token" }, 401);
  }

  // Update last seen (fire-and-forget — don't block the request)
  updateLastSeen(device.token_hash);

  // Strip token_hash before attaching to context — downstream handlers don't need it
  const { token_hash: _, ...safeDevice } = device;
  c.set("device", safeDevice);

  await next();
});
