// apps/web/src/features/session/cloud/webCloudDirectConfig.ts
// The fully-Mac-closed WEB deployment's config + WorkOS session bearer.
//
// This deployment (deusmachine.ai with NO Mac backend) reaches cloud agents
// by minting session tokens from the browser's OWN deus-cloud session. That
// session is obtained through deus-cloud's `deus-web` login flow, handed back as
// a `#token=` URL fragment, and held in sessionStorage — the same mechanism the
// dev-dashboard SPA already uses. The bearer authenticates agnt's `/dashboard`
// exchange directly (Bearer header, cross-origin), so no Mac backend is involved.

/**
 * The mode signal itself lives in shared/config (the deployment-mode enum
 * derives from it); re-exported here so the cloud feature's callers have one
 * import site. See `@/shared/config/webDirectMode` for the entry-path semantics
 * (relay URLs keep their relay behavior on the same build).
 */
import { isCloudDirectWebMode } from "@/shared/config/webDirectMode";
export { isCloudDirectWebMode };

const BEARER_KEY = "deus_cloud_session";

const stripTrailingSlash = (u: string): string => u.replace(/\/$/, "");

/** The agnt REST/WS origin the browser mints against + connects to. */
export function resolveAgntBaseUrl(): string {
  const configured = import.meta.env.VITE_AGNT_BASE_URL as string | undefined;
  return stripTrailingSlash(configured || "https://api.deusmachine.ai");
}

/** The deus-cloud auth origin — the WorkOS `deus-web` login lives here. */
export function resolveDeusCloudUrl(): string {
  const configured = import.meta.env.VITE_DEUS_CLOUD_URL as string | undefined;
  return stripTrailingSlash(configured || "https://cloud.deusmachine.ai");
}

/** The browser's `deus_cloud_session` bearer, or null when signed out. */
export async function readWebCloudSessionBearer(): Promise<string | null> {
  try {
    return sessionStorage.getItem(BEARER_KEY);
  } catch {
    return null;
  }
}

/**
 * Capture a `#token=…` deus-cloud session handed back by the login redirect,
 * store it, and scrub the fragment from the URL/history. Call once on app boot.
 * Returns true when a token was captured. Mirrors apps/dashboard's callback.
 */
export function captureCloudSessionFromFragment(): boolean {
  try {
    const match = window.location.hash.match(/token=([^&]+)/);
    if (!match) return false;
    sessionStorage.setItem(BEARER_KEY, decodeURIComponent(match[1]));
    // Scrub the credential from the address bar + history entry.
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
    return true;
  } catch {
    return false;
  }
}

/**
 * Send the browser to the deus-cloud WorkOS login, returning to `returnPath`
 * here afterward (deus-cloud 302s back with the `#token=` fragment). `deus-web`
 * is deus-cloud's default client, passed explicitly for clarity.
 */
export function beginWebCloudLogin(returnPath = "/"): void {
  const returnTo = `${window.location.origin}${returnPath}`;
  const url = `${resolveDeusCloudUrl()}/auth/login?client=deus-web&return_to=${encodeURIComponent(returnTo)}`;
  window.location.href = url;
}

/** Drop the stored bearer (sign out of the direct-web session). */
export function clearWebCloudSession(): void {
  try {
    sessionStorage.removeItem(BEARER_KEY);
  } catch {
    /* sessionStorage unavailable — nothing to clear */
  }
}

// The last login redirect's timestamp — a loop guard. If login returns without a
// token (misconfig, WorkOS hiccup), a boot gate that redirects on every missing
// bearer would spin; the cooldown breaks that, surfacing "signed out" instead.
const LOGIN_ATTEMPT_KEY = "deus.cloudLoginAt";
const LOGIN_COOLDOWN_MS = 10_000;

/**
 * Redirect to the deus-web login — unless we JUST tried (within the cooldown),
 * which means login bounced back tokenless and redirecting again would loop.
 * Returns whether it actually redirected.
 */
export function redirectToWebCloudLogin(
  returnPath = `${window.location.pathname}${window.location.search}`
): boolean {
  try {
    const last = Number(sessionStorage.getItem(LOGIN_ATTEMPT_KEY) || 0);
    if (Date.now() - last < LOGIN_COOLDOWN_MS) return false;
    sessionStorage.setItem(LOGIN_ATTEMPT_KEY, String(Date.now()));
  } catch {
    /* sessionStorage unavailable — attempt the redirect anyway */
  }
  beginWebCloudLogin(returnPath);
  return true;
}

/**
 * Boot gate for a fully Mac-closed web build: with no bearer in hand, send the
 * user to sign in. A no-op on every backed build (electron/web-dev/relay), and a
 * no-op once signed in (which also resets the loop guard).
 */
export function ensureWebCloudSession(): void {
  if (!isCloudDirectWebMode()) return;
  try {
    if (sessionStorage.getItem(BEARER_KEY)) {
      sessionStorage.removeItem(LOGIN_ATTEMPT_KEY);
      return;
    }
  } catch {
    return;
  }
  redirectToWebCloudLogin();
}

/** The bearer lapsed (agnt answered 401) — drop it and re-authenticate. */
export function handleWebCloudSessionExpired(): void {
  clearWebCloudSession();
  redirectToWebCloudLogin();
}
