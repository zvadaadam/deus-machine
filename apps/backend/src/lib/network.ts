export const DEFAULT_RELAY_URL = "wss://relay.deusmachine.ai";

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
