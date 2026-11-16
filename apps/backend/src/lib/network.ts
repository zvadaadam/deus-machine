// Allows a local Worker during remote-access integration tests and development.
export const DEFAULT_RELAY_URL = process.env.DEUS_RELAY_URL || "wss://relay.deusmachine.ai";

/**
 * The sign-in service whose access tokens admit a hosted assistant (Deus
 * Cloud's authorization server; its keys are at `<issuer>/oauth2/jwks`).
 * Overridden for tests and local stacks.
 */
export const ASSISTANT_ISSUER =
  process.env.DEUS_ASSISTANT_ISSUER || "https://cooperative-origin-94.authkit.app";

export function isLocalhost(ip: string | undefined): boolean {
  if (!ip) return false;
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1" || ip === "localhost";
}

export function getClientIp(c: any): string | undefined {
  return (
    (c.env as any)?.incoming?.socket?.remoteAddress ||
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    c.req.header("x-real-ip")
  );
}
