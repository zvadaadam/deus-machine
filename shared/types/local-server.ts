/**
 * Local server discovery types — shared between frontend and backend.
 *
 * Inspired by Codex's localhost-discovery feature. The backend probes a
 * curated list of common dev ports, parses the HTML response for title +
 * CSS theme, and synthesizes a small SVG preview. The frontend renders
 * these as cards in the browser tab's empty state.
 */

/**
 * Where this server entry came from. Currently only the curated port
 * probe; chat-history mining will add another value here when wired up.
 */
export type LocalServerSource = "port-scan";

/** Last-known reachability. */
export type LocalServerStatus =
  /** Last probe got an HTTP response (any status). */
  | "running"
  /** Last probe failed (timeout, ECONNREFUSED, DNS error). */
  | "offline";

/** Background colors extracted from the page's CSS, used to render the SVG preview. */
export interface LocalServerTheme {
  /** CSS color string from `html`/`body` `background-color`. */
  backgroundColor: string;
  /** CSS color string from `html`/`body` `color`. */
  textColor: string;
}

export interface LocalServer {
  /** Canonical URL — always `http://host:port/`. Used as identity. */
  url: string;
  /** Hostname (`localhost`, `127.0.0.1`, etc.). */
  host: string;
  /** Port number. */
  port: number;
  /** `<title>` from the page, falls back to `host:port`. */
  title: string | null;
  /** Theme extracted from the page CSS, null if probe failed. */
  theme: LocalServerTheme | null;
  /** Inline `data:image/svg+xml;base64,...` synthesized from the theme. */
  previewImageDataUrl: string | null;
  /** Last reachability check. */
  status: LocalServerStatus;
  /** Where the entry came from. */
  source: LocalServerSource;
}

/** Top-level shape returned by the `local_servers` query. */
export interface LocalServersSnapshot {
  /** Servers sorted by port ascending. */
  servers: LocalServer[];
  /** Whether a refresh is currently in flight (UI can show a subtle spinner). */
  isLoading: boolean;
  /** Epoch ms of the last completed refresh. */
  refreshedAt: number | null;
}
