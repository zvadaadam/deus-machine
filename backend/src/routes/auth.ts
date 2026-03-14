// backend/src/routes/auth.ts
// Auth endpoints for remote access pairing and device management.
// POST /auth/pair — public, rate-limited, exchanges code for token
// POST /auth/generate-pair-code — localhost-only, creates a new code
// GET /auth/devices — localhost-only, lists paired devices
// DELETE /auth/devices/:id — localhost-only, revokes a device

import { Hono } from "hono";
import { parseBody, PairBody } from "../lib/schemas";
import {
  generatePairCode,
  validatePairCode,
  createDeviceToken,
  listDevices,
  revokeDevice,
  checkRateLimit,
  recordFailure,
  resetRateLimit,
} from "../services/auth.service";
import { isLocalhost, getClientIp } from "../lib/network";

const app = new Hono();

function requireLocalhost(c: any): Response | null {
  const ip = getClientIp(c);
  if (!isLocalhost(ip)) {
    return c.json({ error: "This endpoint is only available from localhost" }, 403);
  }
  return null;
}

// POST /auth/pair — public, exchanges pairing code for device token
app.post("/auth/pair", async (c) => {
  const clientIp = getClientIp(c);

  // Rate limit check
  if (clientIp) {
    const lockout = checkRateLimit(clientIp);
    if (lockout > 0) {
      return c.json({ error: "Too many failed attempts. Try again later." }, 429);
    }
  }

  const { code, deviceName } = parseBody(PairBody, await c.req.json());

  if (!validatePairCode(code)) {
    if (clientIp) recordFailure(clientIp);
    return c.json({ error: "Invalid or expired pairing code" }, 401);
  }

  // Successful pairing — create device token
  if (clientIp) resetRateLimit(clientIp);
  const userAgent = c.req.header("user-agent") ?? null;
  const { token, device } = createDeviceToken(
    deviceName ?? "Unknown Device",
    clientIp ?? null,
    userAgent,
  );

  return c.json({
    token,
    device: {
      id: device.id,
      name: device.name,
      created_at: device.created_at,
    },
  });
});

// POST /auth/generate-pair-code — localhost-only
app.post("/auth/generate-pair-code", (c) => {
  const denied = requireLocalhost(c);
  if (denied) return denied;

  const { code, expiresAt } = generatePairCode();
  const expiresInSeconds = Math.round((expiresAt - Date.now()) / 1000);

  return c.json({ code, expires_in_seconds: expiresInSeconds });
});

// GET /auth/devices — localhost-only
app.get("/auth/devices", (c) => {
  const denied = requireLocalhost(c);
  if (denied) return denied;

  return c.json({ devices: listDevices() });
});

// DELETE /auth/devices/:id — localhost-only
app.delete("/auth/devices/:id", (c) => {
  const denied = requireLocalhost(c);
  if (denied) return denied;

  const id = c.req.param("id");
  const deleted = revokeDevice(id);
  if (!deleted) {
    return c.json({ error: "Device not found" }, 404);
  }
  return c.json({ success: true });
});

export default app;
