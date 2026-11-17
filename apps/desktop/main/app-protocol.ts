/**
 * The packaged window's own origin, `app://deus`.
 *
 * Loaded from `file://`, the window had no origin the backend could tell from
 * any local file's (its WebSocket said `Origin: file://`, its fetches
 * `Origin: null`, which a sandboxed frame on any site also sends). Served from
 * a privileged scheme it is `app://deus`, the origin the backend is told to
 * trust (`DEUS_WEB_ORIGINS`, shared/web-origins.ts), as Electron's security
 * guide recommends. Only the built renderer is served; dev keeps Vite's URL.
 */

import { net, protocol } from "electron";
import { statSync } from "fs";
import path from "path";
import { pathToFileURL } from "url";
import { APP_HOST, APP_ORIGIN, APP_SCHEME } from "../../../shared/web-origins";

export const APP_URL = `${APP_ORIGIN}/`;

/** Before `ready`: the scheme behaves as https does (origin, storage, fetch). */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ]);
}

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * The file an `app://deus/…` URL names in the renderer folder; `index.html`
 * for a path in it that is not a file; null for another host or a path that
 * leaves the folder (an encoded `..`, which URL parsing does not resolve).
 */
export function rendererFileFor(
  rendererRoot: string,
  url: string,
  fileExists: (file: string) => boolean = isFile
): string | null {
  let parsed: URL;
  let pathname: string;
  try {
    parsed = new URL(url);
    pathname = decodeURIComponent(parsed.pathname);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${APP_SCHEME}:` || parsed.host !== APP_HOST) return null;
  if (pathname.includes("\0")) return null;

  const root = path.resolve(rendererRoot);
  const file = path.resolve(root, `.${pathname}`);
  const relative = path.relative(root, file);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return null;
  }
  if (relative && fileExists(file)) return file;
  return path.join(root, "index.html");
}

/** Serve the built renderer at `app://deus` (after `ready`). */
export function serveRenderer(rendererRoot: string): void {
  protocol.handle(APP_SCHEME, (request) => {
    const file = rendererFileFor(rendererRoot, request.url);
    if (!file) return new Response("Not found", { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });
}

/** `scheme://host[:port]` of a URL, the custom scheme included (Node's URL calls its origin "null"). */
export function originOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.host ? `${parsed.protocol}//${parsed.host}` : null;
  } catch {
    return null;
  }
}

/**
 * The origin the window loads from: Vite's in dev, `app://deus` otherwise. The
 * backend is told to trust it, and the window may navigate only within it.
 */
export function rendererOrigin(options: { isDev: boolean; rendererUrl?: string }): string {
  const dev = options.isDev && options.rendererUrl ? originOf(options.rendererUrl) : null;
  return dev ?? APP_ORIGIN;
}
