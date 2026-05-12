// packages/pencil/src/lib/router.ts
//
// HTTP routing. Wires every feature module to a method+path. Single
// dispatch table so the surface is visible at a glance.

import * as fs from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import { spawnSync } from "node:child_process";

import { findPencilCli, getCliVersion, buildCliEnv, verifyCliKey } from "./cli.ts";
import * as auth from "./auth.ts";
import * as designs from "./designs.ts";
import * as ops from "./ops.ts";
import * as mcp from "./mcp.ts";
import * as ipcHost from "./ipc-host.ts";
import { completeIframeRequest, type IframeReply } from "./iframe-rpc.ts";
import {
  activeClientCount,
  isTransportServerRunning,
  transportServerPort,
} from "./transport-server.ts";
import { getBinaryStatus } from "./mcp-binary.ts";
import { rewriteEditorIndex } from "./editor-bundle.ts";
import type { Context } from "./types.ts";

/** True when `child` is `parent` or a descendant directory thereof. Uses
 *  resolve + relative so sibling-prefix attacks (`/foo-other` against
 *  `/foo`) and `..` traversal both fail closed. */
function isInside(child: string, parent: string): boolean {
  const rel = relative(resolvePath(parent), resolvePath(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function findUiDir(here: string): string {
  const bundled = join(here, "ui");
  if (fs.existsSync(join(bundled, "parent.html"))) return bundled;
  return join(here, "..", "ui");
}

function tokenMatches(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

export function isAuthorizedRequest(
  req: IncomingMessage,
  url: URL,
  authToken: string | undefined
): boolean {
  if (!authToken) return true;
  const header = req.headers["x-deus-app-token"];
  const headerToken = Array.isArray(header) ? header[0] : header;
  return (
    tokenMatches(headerToken, authToken) ||
    tokenMatches(url.searchParams.get("token") ?? undefined, authToken)
  );
}

// MIME map for static editor asset serving.
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

/** Serve a file from the editor bundle dir, with safety check + MIME. The
 *  editor's index.html gets the webappapi shim injected. */
function serveEditorFile(res: ServerResponse, bundleDir: string, subPath: string): void {
  const cleanPath = subPath.split("?")[0]?.split("#")[0] ?? "";
  const safe = cleanPath.replace(/^([/\\]+)/, "").replace(/^(\.\.[/\\])+/g, "");
  const filePath = join(bundleDir, safe);
  if (!filePath.startsWith(bundleDir + "/") && filePath !== bundleDir) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("forbidden");
    return;
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
    return;
  }
  let target = filePath;
  if (stat.isDirectory()) {
    target = join(filePath, "index.html");
    try {
      stat = fs.statSync(target);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
      return;
    }
  }
  const ext = (target.match(/\.[a-z0-9]+$/i)?.[0] ?? "").toLowerCase();
  const type = MIME[ext] ?? "application/octet-stream";
  if (ext === ".html") {
    let body = fs.readFileSync(target, "utf8");
    body = rewriteEditorIndex(body);
    const buf = Buffer.from(body, "utf8");
    res.writeHead(200, { "Content-Type": type, "Content-Length": buf.length });
    res.end(buf);
    return;
  }
  res.writeHead(200, {
    "Content-Type": type,
    "Content-Length": stat.size,
    "Cache-Control": "no-cache",
  });
  fs.createReadStream(target).pipe(res);
}

// ---- HTTP helpers ---------------------------------------------------------

function send(
  res: ServerResponse,
  status: number,
  contentType: string,
  body: string | Buffer,
  extraHeaders: Record<string, string> = {}
): void {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), "utf8");
  res.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": buf.length,
    ...extraHeaders,
  });
  res.end(buf);
}

function sendJson(
  res: ServerResponse,
  status: number,
  payload: unknown,
  extraHeaders: Record<string, string> = {}
): void {
  send(res, status, "application/json", JSON.stringify(payload, null, 2), extraHeaders);
}

async function readJsonBody<T = unknown>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => (body += c));
    req.on("end", () => {
      try {
        resolve(body.length > 0 ? (JSON.parse(body) as T) : ({} as T));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => (body += c));
    req.on("end", () => resolve(body));
    req.on("error", () => resolve(""));
  });
}

// ---- preview watcher (lazy) ----------------------------------------------

interface PreviewWatcher {
  close(): void;
  lastFired?: number;
}
let designsWatcher: (PreviewWatcher & { lastFired?: number }) | null = null;

function ensurePreviewWatcher(storage: string): void {
  if (designsWatcher) return;
  const dir = join(storage, "designs");
  fs.mkdirSync(dir, { recursive: true });
  try {
    const fsWatcher = fs.watch(dir, (_event, filename) => {
      if (filename && filename.endsWith(".preview.png")) {
        // Coalesce — fs.watch fires multiple times per write.
        if (designsWatcher?.lastFired && Date.now() - designsWatcher.lastFired < 200) return;
        if (designsWatcher) designsWatcher.lastFired = Date.now();
        ops.broadcastEvent("preview-changed", { filename });
      }
    });
    designsWatcher = { close: () => fsWatcher.close() };
  } catch {
    /* watch failed — iframe falls back to its slow timer */
  }
}

// ---- router ---------------------------------------------------------------

export interface RouterContext extends Context {
  /** Path to the Pencil editor bundle directory (containing index.html). */
  editorBundleDir: string;
}

export function createRouter(
  ctx: RouterContext
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const uiDir = findUiDir(here);
  const parentHtml = fs.readFileSync(join(uiDir, "parent.html"), "utf8");
  const stylesCss = fs.readFileSync(join(uiDir, "styles.css"), "utf8");
  const appJs = fs.readFileSync(join(uiDir, "app.js"), "utf8");

  return async (req, res) => {
    const url = req.url ?? "/";
    const parsedUrl = new URL(url, "http://127.0.0.1");
    const pathname = parsedUrl.pathname;
    const method = req.method ?? "GET";

    // --- system ----------------------------------------------------------
    if (method === "GET" && pathname === "/health") {
      return send(res, 200, "text/plain", "ok");
    }

    if (method === "GET" && (pathname === "/" || pathname === "/index.html")) {
      return send(res, 200, "text/html; charset=utf-8", parentHtml);
    }

    if (method === "GET" && pathname === "/styles.css") {
      return send(res, 200, "text/css; charset=utf-8", stylesCss, {
        "Cache-Control": "no-cache",
      });
    }
    if (method === "GET" && pathname === "/app.js") {
      return send(res, 200, "application/javascript; charset=utf-8", appJs, {
        "Cache-Control": "no-cache",
      });
    }

    // ----- editor bundle (the actual Pencil editor in iframe) ---------
    if (method === "GET" && (pathname === "/editor" || pathname.startsWith("/editor/"))) {
      const sub = pathname.slice("/editor".length) || "/";
      return serveEditorFile(res, ctx.editorBundleDir, sub);
    }

    // The static shell and editor bundle are public so the iframe can boot.
    // All stateful/local-privileged endpoints below require the per-launch
    // secret passed by the host in the UI URL fragment or MCP query string.
    if (!isAuthorizedRequest(req, parsedUrl, ctx.authToken)) {
      return sendJson(res, 401, { error: "unauthorized" });
    }

    if (method === "GET" && pathname === "/cli-info") {
      try {
        const version = await getCliVersion(ctx);
        return sendJson(res, 200, { version });
      } catch (err) {
        return sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    }

    // ----- editor IPC bridge (POST per request) ----------------------
    if (method === "POST" && pathname === "/ipc") {
      let body: ipcHost.IpcMessage;
      try {
        body = await readJsonBody<ipcHost.IpcMessage>(req);
      } catch {
        return sendJson(res, 400, { error: "invalid JSON" });
      }
      try {
        const reply = await ipcHost.handleEditorMessage(body, ctx);
        if (reply === null) {
          // Notifications get 202 with no body.
          res.writeHead(202);
          res.end();
          return;
        }
        return sendJson(res, 200, reply);
      } catch (err) {
        return sendJson(res, 500, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // ----- iframe RPC reply channel (host → iframe; iframe responds) -----
    //
    // The TransportServer (and any internal caller) sends an "ipc-request"
    // SSE event; parent.html relays to the iframe; the iframe's editor
    // returns; parent.html POSTs the response here so the pending Promise
    // can resolve.
    if (method === "POST" && pathname === "/ipc-response") {
      let body: IframeReply;
      try {
        body = await readJsonBody<IframeReply>(req);
      } catch {
        return sendJson(res, 400, { error: "invalid JSON" });
      }
      const matched = completeIframeRequest(body);
      return sendJson(res, matched ? 200 : 404, { matched });
    }

    // ----- bridge status (debug) -----------------------------------------
    if (method === "GET" && pathname === "/bridge-status") {
      return sendJson(res, 200, {
        transport: {
          running: isTransportServerRunning(),
          port: transportServerPort(),
          activeClients: activeClientCount(),
        },
        binary: getBinaryStatus(),
      });
    }

    // ----- detect what's actually open in the iframe editor --------------
    //
    // Probes `get-editor-state`, parses the documentURI, and syncs our
    // server‑side active pointer. Used by the panel UI to keep the
    // switcher trigger in sync when the agent uses the binary's tools
    // directly (open_document, batch_design …) without going through
    // pencil_open / pencil_new — without this poll, the switcher would
    // say "no design" while the canvas is full of frames.
    if (method === "GET" && pathname === "/detect-active") {
      try {
        const { requestFromIframe } = await import("./iframe-rpc.ts");
        let reply: unknown;
        try {
          reply = await requestFromIframe("get-editor-state", { include_schema: false }, 4_000);
        } catch {
          return sendJson(res, 200, { active: null, source: "iframe-timeout" });
        }
        const r = reply as { result?: { message?: string } } | null;
        const message = r?.result?.message;
        if (typeof message !== "string") {
          return sendJson(res, 200, { active: null, source: "iframe-empty" });
        }
        let parsed: { documentURI?: string };
        try {
          parsed = JSON.parse(message) as { documentURI?: string };
        } catch {
          return sendJson(res, 200, { active: null, source: "iframe-bad-json" });
        }
        const uri = parsed.documentURI;
        if (typeof uri !== "string" || !uri.startsWith("file://")) {
          return sendJson(res, 200, { active: null, source: "iframe-no-uri" });
        }
        const path = decodeURI(uri.replace(/^file:\/\//, ""));
        designs.setActivePen(ctx.storage, path);
        return sendJson(res, 200, { active: path, source: "iframe" });
      } catch (err) {
        return sendJson(res, 500, {
          active: null,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (method === "GET" && pathname === "/diagnostic") {
      const cliInfo = findPencilCli();
      const resolved = auth.resolveCliKey();
      const cliEnv = buildCliEnv();
      // Don't expose ANY of the CLI key — even a prefix can leak via
      // screenshots / support dumps. Source + presence is enough for
      // debugging.
      return sendJson(res, 200, {
        ...auth.authState(),
        cli: cliInfo,
        workspace: ctx.workspace,
        storage: ctx.storage,
        cliKeyPresent: Boolean(resolved),
        cliKeySource: resolved?.source ?? null,
        spawnEnv: {
          PENCIL_API_BASE: cliEnv.PENCIL_API_BASE,
          NODE_ENV: cliEnv.NODE_ENV,
          PENCIL_CLI_KEY: cliEnv.PENCIL_CLI_KEY ? "<redacted>" : null,
        },
        node: process.version,
        platform: `${process.platform}/${process.arch}`,
        pid: process.pid,
        ppid: process.ppid,
        uptimeSec: Math.round(process.uptime()),
      });
    }

    // --- auth -----------------------------------------------------------
    if (method === "GET" && pathname === "/auth-status") {
      return sendJson(res, 200, auth.authState());
    }

    if (method === "POST" && pathname === "/auth-set") {
      let payload: { key?: unknown };
      try {
        payload = await readJsonBody(req);
      } catch {
        return sendJson(res, 400, { ok: false, error: "invalid JSON" });
      }
      if (!auth.validateCliKey(payload.key)) {
        return sendJson(res, 400, {
          ok: false,
          error: "key must start with 'pencil_cli_' and be non-empty",
        });
      }
      const trimmed = payload.key.trim();
      // Round-trip the key against the API before persisting.
      const verify = await verifyCliKey(trimmed, ctx);
      if (!verify.ok) {
        return sendJson(res, 400, {
          ok: false,
          error: verify.error || "Pencil API rejected the key.",
        });
      }
      try {
        auth.persistKey(trimmed);
      } catch (err) {
        return sendJson(res, 500, {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return sendJson(res, 200, {
        ok: true,
        verified: true,
        email: verify.email,
        ...auth.authState(),
      });
    }

    if (method === "POST" && pathname === "/auth-clear") {
      auth.clearKey();
      auth.clearEditorSession();
      return sendJson(res, 200, { ok: true, ...auth.authState() });
    }

    // --- designs --------------------------------------------------------
    if (method === "GET" && pathname.startsWith("/preview")) {
      const previewPath = designs.getActivePreview(ctx.storage);
      if (!previewPath || !fs.existsSync(previewPath)) {
        return send(res, 204, "text/plain", "");
      }
      const stat = fs.statSync(previewPath);
      res.writeHead(200, {
        "Content-Type": "image/png",
        "Content-Length": stat.size,
        "Cache-Control": "no-store",
      });
      fs.createReadStream(previewPath).pipe(res);
      return;
    }

    if (method === "GET" && pathname === "/designs") {
      const list = designs.listAllDesigns(ctx);
      const cur = ops.getCurrentOp();
      const activePen = designs.getActivePen(ctx.storage);
      return sendJson(res, 200, {
        designs: list.map((d) => ({
          name: d.name,
          file: d.file,
          inWorkspace: d.inWorkspace,
          modifiedAt: d.modifiedAt,
          sizeBytes: d.sizeBytes,
        })),
        active: activePen,
        currentOp: cur
          ? {
              id: cur.id,
              kind: cur.kind,
              name: cur.name,
              startedAt: cur.startedAt,
            }
          : null,
      });
    }

    if (method === "POST" && pathname === "/active") {
      let payload: { file?: unknown; name?: unknown };
      try {
        payload = await readJsonBody(req);
      } catch {
        return sendJson(res, 400, { ok: false, error: "invalid JSON" });
      }
      let target: string;
      try {
        const input = typeof payload.file === "string" ? payload.file : (payload.name as string);
        target = designs.resolvePenPath(input, ctx);
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: (err as Error).message });
      }
      if (!fs.existsSync(target)) {
        return sendJson(res, 404, { ok: false, error: `no .pen at ${target}` });
      }
      designs.setActivePen(ctx.storage, target);
      // Push the file content so the editor switches immediately, even
      // before /events SSE catches up.
      ipcHost.pushFileUpdate(target, { zoomToFit: true });
      return sendJson(res, 200, { ok: true, file: target });
    }

    // --- system handoff (reveal/open) -----------------------------------
    if (method === "POST" && (pathname === "/reveal" || pathname === "/open-pen")) {
      let payload: { path?: unknown };
      try {
        payload = await readJsonBody(req);
      } catch {
        return sendJson(res, 400, { ok: false, error: "invalid JSON" });
      }
      const target = payload.path;
      if (typeof target !== "string") {
        return sendJson(res, 403, {
          ok: false,
          error: "path must be a string",
        });
      }
      // Real path-boundary check — `startsWith` alone is bypassable by
      // sibling paths that share a prefix (e.g. `${workspace}-other/...`).
      // Resolve the candidate, then require it's the root or a descendant.
      const abs = resolvePath(target);
      const insideWorkspace = isInside(abs, ctx.workspace);
      const insideStorage = isInside(abs, ctx.storage);
      if (!insideWorkspace && !insideStorage) {
        return sendJson(res, 403, {
          ok: false,
          error: "path must be inside the workspace or AAP storage dir",
        });
      }
      if (process.platform !== "darwin") {
        return sendJson(res, 501, {
          ok: false,
          error: `${pathname.slice(1)} only implemented on macOS`,
        });
      }
      try {
        const args = pathname === "/reveal" ? ["-R", target] : [target];
        spawnSync("open", args, { stdio: "ignore", timeout: 3000 });
        return sendJson(res, 200, { ok: true });
      } catch (err) {
        return sendJson(res, 500, {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // --- ops ------------------------------------------------------------
    if (method === "POST" && pathname === "/cancel") {
      const id = ops.cancelCurrentOp();
      return sendJson(res, 200, { ok: Boolean(id), id });
    }

    if (method === "GET" && pathname === "/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write(":ok\n\n");

      // Catch-up replay so reconnects don't miss op-end events.
      const cur = ops.getCurrentOp();
      if (cur) {
        res.write(
          `event: op-start\ndata: ${JSON.stringify({
            id: cur.id,
            kind: cur.kind,
            name: cur.name,
            startedAt: cur.startedAt,
            pid: cur.pid,
          })}\n\n`
        );
      }

      ops.addSubscriber(res);
      ensurePreviewWatcher(ctx.storage);

      const heartbeat = setInterval(() => {
        try {
          res.write(":hb\n\n");
        } catch {
          /* connection dead */
        }
      }, 25_000);
      req.on("close", () => {
        clearInterval(heartbeat);
        ops.removeSubscriber(res);
      });
      return;
    }

    // --- mcp ------------------------------------------------------------
    if (method === "POST" && pathname === "/mcp") {
      const body = await readBody(req);
      try {
        const result = await mcp.handleMcpRequest(body, ctx);
        if (result === null || (Array.isArray(result) && result.length === 0)) {
          res.writeHead(202);
          res.end();
          return;
        }
        return sendJson(res, 200, result, { "Mcp-Session-Id": mcp.SESSION_ID });
      } catch (err) {
        return send(
          res,
          500,
          "text/plain",
          `mcp error: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    return send(res, 404, "text/plain", "not found");
  };
}
