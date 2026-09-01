/**
 * The root-domain split: deusmachine.ai serves the LANDING to logged-out
 * first-time visitors at `/`, and the PRODUCT (the deus web app) everywhere
 * else — the Linear/Notion model, decided at the edge by the landing worker.
 *
 * Pure decision function (no platform APIs) so it is unit-testable from the
 * repo's main test suite. The worker entry (`server.ts`) applies it.
 *
 * Ownership rules:
 *  - `/` → the landing for a fresh browser; the app once the `deus_user=1`
 *    marker cookie says this browser has used the product.
 *  - Landing-owned paths → its own build assets (`/assets/*`), framework
 *    internals (`/_*`, `/@*` — dev/HMR + any server-fn routes), and the exact
 *    statics in `apps/landing/public`. `/favicon.png` exists on BOTH sides —
 *    the landing's wins (same brand mark either way).
 *  - Everything else → the app (its bundles live under `/app-assets/*` by
 *    design, precisely so this router can tell the two builds apart).
 */

export type RootDestination = "landing" | "app";

/** Exact static files owned by the landing (mirror of apps/landing/public). */
const LANDING_STATICS = new Set([
  "/claude-code.svg",
  "/favicon.png",
  "/favicon.svg",
  "/llms.txt",
  "/logo192.png",
  "/logo512.png",
  "/manifest.json",
  "/robots.txt",
]);

export function hasReturningUserMarker(cookieHeader: string | null): boolean {
  if (!cookieHeader) return false;
  return /(?:^|;\s*)deus_user=1(?:;|$)/.test(cookieHeader);
}

export function decideRootRequest(pathname: string, cookieHeader: string | null): RootDestination {
  if (pathname === "/") {
    return hasReturningUserMarker(cookieHeader) ? "app" : "landing";
  }
  if (pathname.startsWith("/assets/")) return "landing";
  if (pathname.startsWith("/_") || pathname.startsWith("/@")) return "landing";
  if (LANDING_STATICS.has(pathname)) return "landing";
  return "app";
}
