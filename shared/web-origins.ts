/**
 * Which web pages may use the backend as this computer's own app.
 *
 * The backend trusts a request from a loopback address with no token, and a
 * browser lets any page send one (a site in any browser, a page in the app's
 * Browser tab). So whoever starts the backend names the origins its pages load
 * from in `DEUS_WEB_ORIGINS`, and a loopback request whose `Origin` is not
 * among them is refused (`apps/backend/src/middleware/loopback-origin-gate.ts`).
 * The list is exact: `scheme://host` or `scheme://host:port`, where the port may
 * be `*`. `null` and `file://` can never be listed: a sandboxed frame on any
 * site sends the first, and every local file the second.
 */

export const WEB_ORIGINS_ENV = "DEUS_WEB_ORIGINS";

/** The packaged window's origin: its scheme is served by the desktop app. */
export const APP_SCHEME = "app";
export const APP_HOST = "deus";
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;

/**
 * A web app served on this computer at any port: `bun run dev:web` and the
 * end-to-end runners, which put Vite in front of a backend.
 */
export const LOOPBACK_WEB_ORIGINS = "http://localhost:*,http://127.0.0.1:*";

export interface WebOriginPattern {
  scheme: string;
  host: string;
  /** A port, `"*"` for any (or none), or `null` for none. */
  port: string | null;
}

// scheme://host[:port]: a host is a name, an IPv4 address or a bracketed IPv6
// address; nothing after it (no path, query, credentials or trailing slash).
const ORIGIN = /^([a-z][a-z0-9+.-]*):\/\/([a-z0-9.-]+|\[[0-9a-f:.]+\])(?::(\d{1,5}|\*))?$/;

function parse(value: string, allowWildcard: boolean): WebOriginPattern | null {
  const match = ORIGIN.exec(value.trim().toLowerCase());
  if (!match) return null;
  const [, scheme, host, port = null] = match;
  if (port === "*" && !allowWildcard) return null;
  if (port !== null && port !== "*" && Number(port) > 65535) return null;
  return { scheme, host, port };
}

/**
 * The list a launcher gave. Entries that are not an origin are left out and
 * named in `invalid`, so the backend can say so; an empty or missing value is
 * no origin at all.
 */
export function parseWebOrigins(value: string | undefined): {
  origins: WebOriginPattern[];
  invalid: string[];
} {
  const origins: WebOriginPattern[] = [];
  const invalid: string[] = [];
  for (const entry of (value ?? "").split(",")) {
    if (!entry.trim()) continue;
    const pattern = parse(entry, true);
    if (pattern) origins.push(pattern);
    else invalid.push(entry.trim());
  }
  return { origins, invalid };
}

/** Whether an `Origin` header names one of these origins. */
export function isListedOrigin(origin: string, patterns: readonly WebOriginPattern[]): boolean {
  const asked = parse(origin, false);
  if (!asked) return false;
  return patterns.some(
    (pattern) =>
      pattern.scheme === asked.scheme &&
      pattern.host === asked.host &&
      (pattern.port === "*" || pattern.port === asked.port)
  );
}
