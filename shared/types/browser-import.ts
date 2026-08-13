/**
 * Shared contract for the "Connect your browser" feature.
 *
 * One source of truth for the types that cross all three processes:
 * backend (read + decrypt) → frontend (orchestrate) → desktop main (inject).
 */

export type BrowserId = "chrome" | "brave" | "edge" | "arc";

export interface BrowserProfile {
  browserId: BrowserId;
  browserName: string;
  /** Profile directory name, e.g. "Default" or "Profile 1". */
  profileDir: string;
  /** Display name from info_cache (may be null). */
  name: string | null;
  /** Account email from info_cache.user_name (may be null). */
  email: string | null;
  /** Last-active time, epoch ms, from the profile directory mtime. */
  lastActiveMs: number | null;
}

/** A decrypted cookie shaped for Electron's `session.cookies.set`. */
export interface ImportCookie {
  url: string;
  name: string;
  value: string;
  domain: string;
  /**
   * True when the source cookie is host-only (Chromium `host_key` had no
   * leading dot). Host-only cookies — including all `__Host-` cookies — must be
   * set with `domain` omitted, or Electron widens their scope / rejects them.
   */
  hostOnly: boolean;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  /** Unix seconds; omitted for session cookies. */
  expirationDate?: number;
  sameSite?: "unspecified" | "no_restriction" | "lax" | "strict";
}

export interface ImportCookiesResult {
  success: boolean;
  imported: number;
  failed: number;
  error?: string;
}
