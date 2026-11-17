// backend/src/middleware/loopback-origin-gate.ts
// A request from this computer is trusted with no token (remote-auth.ts,
// remote-gate.ts and the /ws route all skip loopback). A browser lets any page
// send one, so before that trust applies this checks who is asking: the Host
// the request was addressed to (a rebound DNS name is not this computer) and,
// when there is one, the page's Origin, which must be one the launcher listed in
// DEUS_WEB_ORIGINS (shared/web-origins.ts). A request with no Origin is not
// from a page's script (the CLI, the desktop main process, agents' tools) and
// passes as before. Requests from other addresses are not this gate's: they
// still need their token.

import { createMiddleware } from "hono/factory";
import {
  WEB_ORIGINS_ENV,
  isListedOrigin,
  parseWebOrigins,
  type WebOriginPattern,
} from "@shared/web-origins";
import { getClientIp, isLocalhost } from "../lib/network";

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);
// host[:port], where host is a name or a bracketed IPv6 address.
const HOST = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::(\d{1,5}))?$/;

export const WRONG_HOST =
  "Deus on this computer answers only requests addressed to localhost, 127.0.0.1 or [::1].";
export const FOREIGN_PAGE =
  "This page is not the Deus app, so it cannot use Deus on this computer.";

function hostname(value: string | undefined): string | null {
  const match = value ? HOST.exec(value.trim().toLowerCase()) : null;
  return match ? match[1] : null;
}

/**
 * The backend's own address as an origin (`http://localhost:<its port>`): a
 * page it serves itself, a workspace's HTML preview, must not be trusted even
 * when a port wildcard would cover it.
 */
function isOwnOrigin(origin: string, ownPort: number | undefined): boolean {
  if (!ownPort) return false;
  const match = /^(https?):\/\/([^/]+)$/.exec(origin.trim().toLowerCase());
  if (!match) return false;
  const host = HOST.exec(match[2]);
  if (!host || !LOOPBACK_HOSTNAMES.has(host[1])) return false;
  // A browser leaves the scheme's default port out of an Origin.
  const port = host[2] ? Number(host[2]) : match[1] === "https" ? 443 : 80;
  return port === ownPort;
}

/** Why a loopback request is refused, or null when it may go on. */
export function refuseLoopbackRequest(
  request: { host: string | undefined; origin: string | undefined; ownPort?: number },
  origins: readonly WebOriginPattern[]
): string | null {
  const name = hostname(request.host);
  if (!name || !LOOPBACK_HOSTNAMES.has(name)) return WRONG_HOST;
  if (request.origin === undefined) return null;
  if (isOwnOrigin(request.origin, request.ownPort)) return FOREIGN_PAGE;
  return isListedOrigin(request.origin, origins) ? null : FOREIGN_PAGE;
}

export function createLoopbackOriginGate(origins: readonly WebOriginPattern[]) {
  return createMiddleware(async (c, next) => {
    if (!isLocalhost(getClientIp(c))) {
      await next();
      return;
    }
    const refusal = refuseLoopbackRequest(
      {
        host: c.req.header("host"),
        origin: c.req.header("origin"),
        // The port this request reached (the Node server's socket).
        ownPort: (c.env as { incoming?: { socket?: { localPort?: number } } } | undefined)?.incoming
          ?.socket?.localPort,
      },
      origins
    );
    if (refusal) return c.json({ error: refusal }, 403);
    await next();
  });
}

function originsFromEnvironment(): WebOriginPattern[] {
  const { origins, invalid } = parseWebOrigins(process.env[WEB_ORIGINS_ENV]);
  if (invalid.length > 0) {
    console.warn(
      `[origin-gate] ${WEB_ORIGINS_ENV} entries that are not an origin, ignored:`,
      invalid
    );
  }
  return origins;
}

export const loopbackOriginGate = createLoopbackOriginGate(originsFromEnvironment());
