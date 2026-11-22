/**
 * The browser's own Deus account session (the `deus-web` sign-in). A leaf
 * module: device grants are scoped by its account, and both the relay and
 * web-direct transports read it.
 */
export const CLOUD_SESSION_KEY = "deus_cloud_session";

export interface RelayAccount {
  /** The session's `sub`, read unverified: it scopes local state; Deus Cloud verifies it. */
  accountId: string;
  bearer: string;
}

export function cloudSessionClaims(bearer: string | null): { sub: string; exp?: unknown } | null {
  if (!bearer) return null;
  try {
    const payload = bearer.split(".")[1] ?? "";
    const claims = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    return typeof claims?.sub === "string" && claims.sub ? claims : null;
  } catch {
    return null;
  }
}

/** The signed-in account, or null. An expired session reads as signed out. */
export function readRelayAccount(): RelayAccount | null {
  let bearer: string | null = null;
  try {
    bearer = sessionStorage.getItem(CLOUD_SESSION_KEY);
  } catch {
    return null;
  }
  if (!bearer) return null;
  const payload = cloudSessionClaims(bearer);
  if (!payload) return null;
  if (typeof payload.exp === "number" && payload.exp * 1000 <= Date.now()) return null;
  return { accountId: payload.sub, bearer };
}
