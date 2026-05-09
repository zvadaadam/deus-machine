/**
 * Local server discovery — finds running localhost dev servers.
 *
 * Strategy (cribbed from Codex):
 *  1. Probe a curated list of common dev ports in parallel via plain
 *     `http.request` (no port scanning of all 65k — just the ones that
 *     matter for dev work).
 *  2. ANY HTTP response counts as "running". For 2xx HTML responses we
 *     additionally extract the `<title>` and the page's `body`/`html` CSS
 *     background/text colors so the card has a richer preview.
 *  3. Synthesize a tiny SVG "browser window" preview using those colors —
 *     no real screenshot capture needed.
 *
 * Each probe runs under a single AbortController so the request, its body
 * read, and any nested CSS fetches share one 800ms time budget and tear
 * down together — no orphaned sockets outliving the sweep.
 *
 * Public API:
 *   - getDiscoveredServers(): synchronous read of the cached snapshot.
 *   - refreshDiscovery(): triggers a re-probe; calls listener when done.
 *   - startBackgroundRefresh(): kicks off the 60s interval.
 *
 * The cache lives in module state. v1 has no disk persistence — every
 * app start re-probes (it takes <1s). Add persistence in v2 if needed.
 */

import http from "node:http";
import https from "node:https";
import type { IncomingMessage } from "node:http";
import { URL } from "node:url";

import type {
  LocalServer,
  LocalServerStatus,
  LocalServerTheme,
  LocalServersSnapshot,
} from "@shared/types";

// ---- Tuning constants ----

/** Per-request timeout. Codex uses 800ms; matches well to dev servers' first-byte time. */
const PROBE_TIMEOUT_MS = 800;
/**
 * Read-freshness window. When a caller (WS subscribe, HTTP query) hits the
 * cache and it's older than this, kick off a background re-probe so a server
 * the user just started shows up within a couple of seconds — without a
 * manual refresh. The background sweep handles the no-active-reader case.
 */
const READ_FRESHNESS_MS = 5_000;
/** Background sweep interval — keeps already-subscribed clients fresh while idle. */
const BACKGROUND_REFRESH_MS = 60_000;
/** Cap HTML body read so a misbehaving page can't blow up memory. */
const MAX_HTML_BYTES = 128 * 1024;
/** Cap CSS body read; we only need theme colors. */
const MAX_CSS_BYTES = 64 * 1024;
/** Most stylesheets to fetch per page when extracting theme. */
const MAX_STYLESHEETS = 2;

/**
 * Curated dev-port allowlist. We probe these in parallel; anything outside
 * this list is invisible. Add ports here when a new framework comes up —
 * the cost of a probe is one localhost GET with an 800ms timeout.
 */
const KNOWN_PORTS: readonly number[] = [
  ...range(3000, 3020), // Next.js, Express, Rails
  ...range(4000, 4010), // Phoenix, Vinxi
  ...range(5000, 5010), // Flask, .NET, AdonisJS
  ...range(5173, 5180), // Vite
  ...range(6006, 6010), // Storybook
  ...range(7000, 7010),
  ...range(8000, 8010), // Django, Python http.server
  ...range(8080, 8090), // Tomcat, generic, Metro (8081)
  ...range(9000, 9010),
  1111,
  1234,
  1313, // Hugo
  1420, // Tauri default
  4321, // Astro
  8787, // Cloudflare Wrangler / workerd
  19000,
  19001,
  19002, // Expo classic
  24678, // Vite HMR
];

/** Hostnames we consider "local". */
const LOCAL_HOSTS: readonly string[] = ["localhost", "127.0.0.1"];

/**
 * macOS AirPlay Receiver listens on 5000 and 7000 by default and responds
 * to HTTP enough to pass our generic probe. Distinguish it from real dev
 * servers by inspecting the `Server` response header: AirPlay always
 * identifies as `AirTunes/<version>`. Mirrors Codex's check verbatim.
 */
const AIRPLAY_PORTS: ReadonlySet<number> = new Set([5000, 7000]);
const AIRPLAY_SERVER_PREFIX = "airtunes/";

// ---- Module state (singleton-style, matches existing services) ----

interface CacheEntry {
  snapshot: LocalServersSnapshot;
  /** Promise of an in-flight refresh; null if none running. */
  inflight: Promise<LocalServersSnapshot> | null;
}

const cache: CacheEntry = {
  snapshot: { servers: [], isLoading: false, refreshedAt: null },
  inflight: null,
};

let backgroundTimer: NodeJS.Timeout | null = null;

/**
 * Optional callback invoked after each refresh completes. Wired up by
 * query-engine to push updates to subscribers.
 */
let onRefreshComplete: (() => void) | null = null;

// ---- Public API ----

/**
 * Read the current snapshot. Triggers a background refresh if cache is
 * stale, but always returns immediately with whatever's cached.
 */
export function getDiscoveredServers(): LocalServersSnapshot {
  if (isCacheStale() && cache.inflight === null) {
    void refreshDiscovery();
  }
  return cache.snapshot;
}

/**
 * Force a re-probe. Returns the new snapshot.
 * Concurrent calls dedupe on the same in-flight promise.
 */
export function refreshDiscovery(): Promise<LocalServersSnapshot> {
  if (cache.inflight) return cache.inflight;

  cache.snapshot = { ...cache.snapshot, isLoading: true };

  cache.inflight = probeAllPorts()
    .then((servers) => {
      const next: LocalServersSnapshot = {
        servers,
        isLoading: false,
        refreshedAt: Date.now(),
      };
      cache.snapshot = next;
      return next;
    })
    .catch((err) => {
      console.error("[local-servers] refresh failed:", err);
      const next: LocalServersSnapshot = {
        ...cache.snapshot,
        isLoading: false,
      };
      cache.snapshot = next;
      return next;
    })
    .finally(() => {
      cache.inflight = null;
      onRefreshComplete?.();
    });

  return cache.inflight;
}

/**
 * Register a callback fired after each completed refresh.
 * Used by query-engine to invalidate("local_servers") subscribers.
 */
export function setRefreshListener(listener: (() => void) | null): void {
  onRefreshComplete = listener;
}

/** Start the periodic background sweep. Idempotent. */
export function startBackgroundRefresh(): void {
  if (backgroundTimer) return;
  // Don't pin the event loop open.
  backgroundTimer = setInterval(() => {
    void refreshDiscovery();
  }, BACKGROUND_REFRESH_MS);
  backgroundTimer.unref();
}

/** Stop the periodic background sweep. Used by tests. */
export function stopBackgroundRefresh(): void {
  if (backgroundTimer) {
    clearInterval(backgroundTimer);
    backgroundTimer = null;
  }
}

// ---- Probing ----

interface ProbeSuccess {
  status: "running";
  title: string | null;
  theme: LocalServerTheme | null;
  /** Raw `Server:` header — used to disambiguate macOS AirPlay from real servers. */
  serverHeader: string | null;
}

interface ProbeFailure {
  status: "offline";
}

type ProbeResult = ProbeSuccess | ProbeFailure;

async function probeAllPorts(): Promise<LocalServer[]> {
  // One probe per (host, port) — `localhost` is enough; both hostnames
  // resolve to the same socket.
  const targets = KNOWN_PORTS.map((port) => ({
    host: "localhost",
    port,
    url: `http://localhost:${port}/`,
  }));

  const results = await Promise.all(
    targets.map(async (t) => {
      const result = await probeUrl(t.url);
      if (result.status !== "running") return null;
      if (isAirPlay(t.port, result.serverHeader)) return null;
      return buildServerEntry({ ...t, probe: result });
    })
  );

  return results.filter((s): s is LocalServer => s !== null).sort((a, b) => a.port - b.port);
}

function buildServerEntry(args: {
  host: string;
  port: number;
  url: string;
  probe: ProbeSuccess;
}): LocalServer {
  const { host, port, url, probe } = args;
  const title = probe.title ?? `${host}:${port}`;
  return {
    url,
    host,
    port,
    title,
    theme: probe.theme,
    previewImageDataUrl: synthesizePreviewSvg({ title, url, theme: probe.theme }),
    status: "running",
    source: "port-scan",
  };
}

/**
 * HTTP GET the URL with a strict total time budget. On any HTTP response,
 * report `running` and parse title/theme if it's a 2xx HTML reply. On
 * timeout, refused, or DNS error, report `offline` so the caller drops it.
 *
 * One AbortController bounds the entire probe (request + body read + CSS
 * fetches inside extractTheme). When it fires, every in-flight socket and
 * stream is torn down together — no orphaned work that outlives the sweep.
 */
async function probeUrl(url: string): Promise<ProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    return await probeWithSignal(url, 2, controller.signal);
  } finally {
    clearTimeout(timer);
    // Cancel anything still mid-flight (e.g. a CSS fetch we no longer need).
    controller.abort();
  }
}

async function probeWithSignal(
  url: string,
  redirectsLeft: number,
  signal: AbortSignal
): Promise<ProbeResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { status: "offline" };
  }
  if (signal.aborted) return { status: "offline" };

  return new Promise<ProbeResult>((resolve) => {
    let settled = false;
    const finish = (r: ProbeResult) => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };

    const requester = parsed.protocol === "https:" ? https.request : http.request;
    const req = requester(
      parsed,
      {
        method: "GET",
        signal, // Node tears the request down automatically when signal fires
        headers: {
          Accept: "text/html,application/xhtml+xml,*/*;q=0.1",
          "User-Agent": "Deus local server discovery",
        },
      },
      async (res) => {
        const redirect = redirectTarget(res, parsed);
        if (redirect && redirectsLeft > 0) {
          res.resume();
          const next = await probeWithSignal(redirect, redirectsLeft - 1, signal);
          finish(next);
          return;
        }

        // ANY HTTP response — even 404, 401, 500 — proves something is
        // listening. Backends and bundlers often have no root route; we
        // still want them in the list. Only the HTML metadata (title,
        // theme) requires a 2xx HTML response.
        const status = res.statusCode ?? 0;
        const contentType = String(res.headers["content-type"] ?? "").toLowerCase();
        const serverHeader = headerString(res.headers["server"]);
        const canParseHtml = status >= 200 && status < 300 && contentType.includes("html");

        if (!canParseHtml) {
          res.resume();
          finish({ status: "running", title: null, theme: null, serverHeader });
          return;
        }

        const html = await readBody(res, MAX_HTML_BYTES, signal);
        const title = extractTitle(html);
        const theme = await extractTheme(html, parsed, signal);
        finish({ status: "running", title, theme, serverHeader });
      }
    );

    // Covers DNS errors, ECONNREFUSED, and AbortError on signal abort.
    req.on("error", () => finish({ status: "offline" }));
    req.end();
  });
}

function redirectTarget(res: IncomingMessage, base: URL): string | null {
  const status = res.statusCode ?? 0;
  if (status < 300 || status >= 400) return null;
  const location = res.headers.location;
  if (!location) return null;
  try {
    const next = new URL(location, base);
    // Only follow same-host redirects to a local target.
    if (!isLocalHost(next.hostname)) return null;
    return next.toString();
  } catch {
    return null;
  }
}

function isLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return LOCAL_HOSTS.includes(h) || h === "[::1]" || h === "::1" || h.endsWith(".localhost");
}

function isAirPlay(port: number, serverHeader: string | null): boolean {
  if (!AIRPLAY_PORTS.has(port)) return false;
  if (serverHeader == null) return false;
  return serverHeader.trim().toLowerCase().startsWith(AIRPLAY_SERVER_PREFIX);
}

function headerString(value: string | string[] | undefined): string | null {
  if (value == null) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

/**
 * Read up to `maxBytes` of a response body. Always resolves — never rejects,
 * since a partial body is better than an unhandled rejection for theme
 * extraction. Stops early on abort, hitting the byte cap, or stream end.
 */
async function readBody(
  res: IncomingMessage,
  maxBytes: number,
  signal: AbortSignal
): Promise<string> {
  return new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;

    const finish = () => {
      if (done) return;
      done = true;
      signal.removeEventListener("abort", finish);
      try {
        res.destroy();
      } catch {
        // Stream may already be torn down by Node when the parent req aborted.
      }
      resolve(Buffer.concat(chunks).toString("utf8"));
    };

    if (signal.aborted) {
      finish();
      return;
    }
    signal.addEventListener("abort", finish, { once: true });

    res.on("data", (chunk: Buffer) => {
      const room = maxBytes - total;
      if (chunk.length >= room) {
        if (room > 0) chunks.push(chunk.subarray(0, room));
        total = maxBytes;
        finish();
        return;
      }
      chunks.push(chunk);
      total += chunk.length;
    });
    res.on("end", finish);
    res.on("close", finish);
    res.on("error", finish);
  });
}

// ---- HTML parsing ----

function extractTitle(html: string): string | null {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!match) return null;
  const text = decodeEntities(match[1]).replace(/\s+/g, " ").trim();
  if (text.length === 0) return null;
  return text.slice(0, 120);
}

/**
 * Pull background-color and color out of inline `<style>` blocks plus up
 * to MAX_STYLESHEETS external `<link rel="stylesheet">` files. Looks at
 * `html` / `body` rules only — that's where dev-server defaults live.
 */
async function extractTheme(
  html: string,
  base: URL,
  signal: AbortSignal
): Promise<LocalServerTheme | null> {
  const styleSources: string[] = [];

  for (const m of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
    styleSources.push(m[1] ?? "");
  }

  const stylesheetUrls = collectStylesheetUrls(html, base);
  const fetched = await Promise.all(stylesheetUrls.map((u) => fetchCss(u, signal)));
  for (const css of fetched) {
    if (css) styleSources.push(css);
  }

  // Inline `style="..."` on <html> / <body>.
  for (const tag of ["html", "body"] as const) {
    const inline = extractInlineStyleAttr(html, tag);
    if (inline) styleSources.push(inline);
  }

  let backgroundColor: string | null = null;
  let textColor: string | null = null;
  for (const src of styleSources) {
    backgroundColor ??= readDeclaration(src, ["background-color", "background"], ["html", "body"]);
    textColor ??= readDeclaration(src, ["color"], ["html", "body"]);
    if (backgroundColor && textColor) break;
  }

  if (!backgroundColor && !textColor) return null;
  return {
    backgroundColor: backgroundColor ?? "#ffffff",
    textColor: textColor ?? "#1f2937",
  };
}

function collectStylesheetUrls(html: string, base: URL): string[] {
  const urls: string[] = [];
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    const rel = readAttr(tag, "rel")?.toLowerCase().split(/\s+/) ?? [];
    if (!rel.includes("stylesheet")) continue;
    const href = readAttr(tag, "href");
    if (!href) continue;
    try {
      const abs = new URL(href, base);
      if (abs.protocol !== base.protocol || abs.host !== base.host) continue;
      if (!isLocalHost(abs.hostname)) continue;
      urls.push(abs.toString());
    } catch {
      // skip unparseable hrefs
    }
    if (urls.length >= MAX_STYLESHEETS) break;
  }
  return urls;
}

async function fetchCss(url: string, signal: AbortSignal): Promise<string | null> {
  if (signal.aborted) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  return new Promise<string | null>((resolve) => {
    const requester = parsed.protocol === "https:" ? https.request : http.request;
    const req = requester(
      parsed,
      {
        method: "GET",
        signal, // shared with the parent probe — same time budget
        headers: {
          Accept: "text/css,*/*;q=0.1",
          "User-Agent": "Deus local server discovery",
        },
      },
      async (res) => {
        const status = res.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          res.resume();
          resolve(null);
          return;
        }
        const css = await readBody(res, MAX_CSS_BYTES, signal);
        resolve(css);
      }
    );
    // Covers AbortError on signal abort + connection errors.
    req.on("error", () => resolve(null));
    req.end();
  });
}

function readAttr(tag: string, name: string): string | null {
  const re = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
  const m = re.exec(tag);
  if (!m) return null;
  return m[2] ?? m[3] ?? m[4] ?? null;
}

function extractInlineStyleAttr(html: string, tag: "html" | "body"): string | null {
  const re = new RegExp(`<${tag}\\b[^>]*\\sstyle\\s*=\\s*("([^"]*)"|'([^']*)')`, "i");
  const m = re.exec(html);
  if (!m) return null;
  return m[2] ?? m[3] ?? null;
}

/**
 * Find the *last* declaration matching any of `properties` inside a rule
 * whose selector mentions any of `selectors`. Last-wins matches CSS
 * cascade for rules at the same specificity.
 */
function readDeclaration(
  css: string,
  properties: readonly string[],
  selectors: readonly string[]
): string | null {
  let match: string | null = null;
  // Naive rule splitter — fine for theme extraction since we don't need
  // perfect CSS parsing, just `body { background: #fff; }` style declarations.
  const ruleRe = /([^{}]+)\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = ruleRe.exec(css)) !== null) {
    const selector = (m[1] ?? "").toLowerCase();
    const body = m[2] ?? "";
    if (!selectors.some((s) => new RegExp(`(^|[\\s,])${s}($|[\\s,{:.])`).test(selector))) continue;

    for (const prop of properties) {
      const re = new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*([^;]+?)(?:!important)?\\s*(?:;|$)`, "i");
      const dm = re.exec(body);
      if (dm) match = dm[1].trim();
    }
  }

  // Also scan as if the entire CSS string were a single rule body — that
  // covers inline `style="..."` cases passed through here.
  if (!match) {
    for (const prop of properties) {
      const re = new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*([^;]+?)(?:!important)?\\s*(?:;|$)`, "i");
      const dm = re.exec(css);
      if (dm) match = dm[1].trim();
    }
  }

  return match;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

// ---- SVG preview ----

/**
 * Build a tiny "browser window" SVG using the page's actual colors plus
 * the title and URL. Returns a `data:image/svg+xml;base64,...` URL safe
 * for `<img src=...>`. ~1 KB per preview.
 */
function synthesizePreviewSvg(args: {
  title: string;
  url: string;
  theme: LocalServerTheme | null;
}): string {
  const bg = args.theme?.backgroundColor ?? "#ffffff";
  const fg = args.theme?.textColor ?? "#1f2937";
  const safeTitle = escapeXml(truncate(args.title, 64));
  const safeUrl = escapeXml(truncate(args.url.replace(/^https?:\/\//, ""), 72));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="150" viewBox="0 0 240 150"><rect width="240" height="150" rx="10" fill="#f6f7f7"/><rect x="18" y="18" width="204" height="114" rx="8" fill="${escapeXml(bg)}" stroke="#d7dadc"/><circle cx="36" cy="36" r="4" fill="#ff6b6b"/><circle cx="50" cy="36" r="4" fill="#f6c85f"/><circle cx="64" cy="36" r="4" fill="#4ade80"/><rect x="32" y="58" width="176" height="12" rx="6" fill="${escapeXml(fg)}" opacity="0.16"/><rect x="32" y="82" width="124" height="8" rx="4" fill="${escapeXml(fg)}" opacity="0.24"/><text x="32" y="108" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif" font-size="15" font-weight="600" fill="${escapeXml(fg)}">${safeTitle}</text><text x="32" y="126" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif" font-size="10" fill="${escapeXml(fg)}" opacity="0.68">${safeUrl}</text></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// ---- Helpers ----

function isCacheStale(): boolean {
  const t = cache.snapshot.refreshedAt;
  return t === null || Date.now() - t >= READ_FRESHNESS_MS;
}

function range(start: number, endInclusive: number): number[] {
  const out: number[] = [];
  for (let i = start; i <= endInclusive; i++) out.push(i);
  return out;
}
