// backend/src/lib/relay-bridge.ts
// Shared relay bridge secret management.
// The process-local secret authenticates in-process HTTP bridge requests
// (from the relay tunnel). External clients cannot know this value,
// preventing x-relay-bridge-secret header spoofing.

import type { Context } from "hono";

let _bridgeSecret: string | null = null;

/** Called once by server.ts at startup to register the bridge secret. */
export function setRelayBridgeSecret(secret: string): void {
  if (!secret.trim()) {
    throw new Error("Relay bridge secret must be a non-empty string");
  }
  _bridgeSecret = secret;
}

/**
 * Check whether an incoming request carries a valid relay bridge secret.
 * Returns true if the x-relay-bridge-secret header matches the stored secret.
 */
export function isRelayBridgeRequest(c: Context): boolean {
  const bridgeSecret = c.req.header("x-relay-bridge-secret");
  return !!(bridgeSecret && _bridgeSecret && bridgeSecret === _bridgeSecret);
}
