// packages/pencil/src/lib/ipc-host.ts
//
// Implements the Pencil editor's host-side IPC.
//
// Wire format (from @ha/shared/src/ipc-host.ts):
//   { id, type, method, payload?, error? }
//   type: "request" | "response" | "notification"
//
// For our embed, the iframe parent forwards browser-side postMessage events
// to /ipc as HTTP. Notifications from us → editor go via the SSE event bus
// as the "ipc-notify" event.

import * as fs from "node:fs";
import { dirname, isAbsolute, join, relative, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

import {
  authState,
  resolveCliKey,
  readEditorSession,
  writeEditorSession,
  clearEditorSession,
} from "./auth.ts";
import * as designs from "./designs.ts";
import { broadcastEvent } from "./ops.ts";
import type { Context } from "./types.ts";

/** Convert an absolute filesystem path to a `file://` URI. The editor's
 *  document manager stores docs by URI; load-file payloads must use this.
 *  We use Node's `pathToFileURL` so filenames containing `#`, `?`, or
 *  other URI‑significant characters round‑trip correctly (a plain
 *  `encodeURI` would leave them unescaped). */
export function pathToFileURI(p: string): string {
  return pathToFileURL(p).href;
}

/** Push a fresh document into the editor. The editor's `file-update`
 *  handler is registered in a React useEffect that fires AFTER the
 *  `initialized` notify completes — so a single push right after init
 *  often races the listener. We send the same notification at three
 *  spaced intervals; once any of them lands the editor opens the doc.
 *  Subsequent pushes are idempotent (same uri+content → no-op).
 *
 *  Also broadcasts a side-channel `active-file` event the iframe wrapper
 *  uses to show the filename in the topbar — gives the user visual
 *  confirmation that something was pushed even if the editor missed it. */
// Cancel‑safe state for `pushFileUpdate`:
//   • `pendingFilePushes` — timers from the most recent push, so a new
//     switch can clear them. Without this, switching A → B briefly
//     re‑showed A when A's +400ms / +1500ms retries fired after B.
//   • `lastPushedPath` — guard inside scheduled callbacks; if a newer
//     push has happened, the older retry no‑ops instead of clobbering.
//   • `hasPushedOnce` — the +400ms / +1500ms retries exist only to beat
//     the editor's React mount race on first load; after the first
//     push lands, the listener is registered and one push is enough.
let pendingFilePushes: ReturnType<typeof setTimeout>[] = [];
let lastPushedPath: string | null = null;
let hasPushedOnce = false;

export function pushFileUpdate(filePath: string, opts: { zoomToFit?: boolean } = {}): void {
  for (const t of pendingFilePushes) clearTimeout(t);
  pendingFilePushes = [];

  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    console.warn(`[pencil-aap] failed to read ${filePath} for push: ${(err as Error).message}`);
    return;
  }
  const payload = {
    fileURI: pathToFileURI(filePath),
    content,
    isDirty: false,
    zoomToFit: opts.zoomToFit ?? true,
  };
  // Side-channel to the iframe wrapper for the active-file label.
  broadcastEvent("active-file", { path: filePath, name: filePath.split("/").pop() ?? filePath });

  lastPushedPath = filePath;
  const push = (label: string): void => {
    if (lastPushedPath !== filePath) return;
    notifyEditor("file-update", payload);
    console.log(
      `[pencil-aap] pushed file-update [${label}] → ${filePath} (${content.length} bytes)`
    );
  };
  push("0");
  if (!hasPushedOnce) {
    pendingFilePushes.push(setTimeout(() => push("400ms"), 400));
    pendingFilePushes.push(setTimeout(() => push("1500ms"), 1500));
    hasPushedOnce = true;
  }
}

// ---- types ----------------------------------------------------------------

export interface IpcMessage {
  id: string;
  type: "request" | "response" | "notification";
  method: string;
  payload?: unknown;
  error?: { code: string; message: string; stack?: string };
}

interface IpcHandler {
  (payload: unknown, ctx: Context): Promise<unknown> | unknown;
}

// ---- handlers -------------------------------------------------------------
//
// Key principle: keep the surface narrow. The editor will call lots of
// IPC methods but most can return undefined / [] and the editor degrades
// gracefully. Implement what's actually needed for the canvas to work.

const DEVICE_ID = randomUUID();

function isInside(child: string, parent: string): boolean {
  const rel = relative(resolvePath(parent), resolvePath(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function allowedRoots(ctx: Context): string[] {
  const roots = [ctx.workspace, ctx.storage];
  return Array.from(
    new Set(
      roots.flatMap((root) => {
        const resolved = resolvePath(root);
        try {
          return [resolved, fs.realpathSync(resolved)];
        } catch {
          return [resolved];
        }
      })
    )
  );
}

function isAllowedPath(path: string, ctx: Context): boolean {
  return allowedRoots(ctx).some((root) => isInside(path, root));
}

function assertAllowedFsPath(path: unknown, ctx: Context): string {
  if (typeof path !== "string" || path.length === 0) {
    throw new Error("path must be a non-empty string");
  }
  const abs = resolvePath(path);
  if (!isAllowedPath(abs, ctx)) {
    throw new Error("path must be inside the workspace or AAP storage dir");
  }
  return abs;
}

function assertAllowedRealPath(path: string, ctx: Context): void {
  if (!isAllowedPath(fs.realpathSync(path), ctx)) {
    throw new Error("path must be inside the workspace or AAP storage dir");
  }
}

function assertAllowedExistingAncestor(path: string, ctx: Context): void {
  let current = path;
  while (!fs.existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  assertAllowedRealPath(current, ctx);
}

const handlers: Record<string, IpcHandler> = {
  // Identity / lifecycle
  "get-device-id": () => DEVICE_ID,
  "get-last-online-at": () => Date.now(),
  "set-last-online-at": () => undefined,

  // Auth — editor calls this before any api.pencil.dev request. We try
  // sources in order:
  //   1. The Deus-managed editor session (saved via set-session below)
  //   2. The CLI's own pencil login session (~/.pencil/session-cli.json)
  //   3. Any verified Deus CLI key. Deus uses the CLI key as the integration
  //      credential, so the embedded editor should not ask for a second web
  //      sign-in after the user has already connected Pencil.
  // None available → return undefined and the editor will show its own sign-in card.
  "get-session": () => {
    const persisted = readEditorSession();
    if (persisted) return { email: persisted.email, token: persisted.token };

    const a = authState();
    if (a.sessionValid) {
      try {
        const raw = fs.readFileSync(a.sessionFile, "utf8");
        const data = JSON.parse(raw) as { email?: string; token?: string };
        if (data.token && data.email) return { email: data.email, token: data.token };
      } catch {
        /* fall through */
      }
    }
    const resolved = resolveCliKey();
    if (resolved) {
      return { email: a.sessionEmail ?? "Pencil CLI", token: resolved.key };
    }
    return undefined;
  },

  // Editor pushes this AFTER the user signs in via its own card.
  // Payload: { email: string, token: string }. We persist with mode 0600
  // so subsequent launches' get-session returns it directly.
  "set-session": (payload) => {
    const data = payload as { email?: string; token?: string };
    if (typeof data?.email !== "string" || typeof data?.token !== "string") {
      console.warn("[pencil-aap] set-session called with invalid payload");
      return undefined;
    }
    try {
      writeEditorSession({ email: data.email, token: data.token });
      console.log(`[pencil-aap] persisted editor session for ${data.email}`);
    } catch (err) {
      console.warn(`[pencil-aap] failed to persist editor session: ${(err as Error).message}`);
    }
    return undefined;
  },
  "sign-out": () => {
    clearEditorSession();
    return undefined;
  },
  "did-sign-out": () => {
    clearEditorSession();
    return undefined;
  },

  // Theme / chrome
  "get-active-theme-kind": () => "dark",
  "toggle-design-mode": () => undefined,
  "set-left-sidebar-visible": () => undefined,
  "get-fullscreen": () => false,

  // Document / file system — passthrough to the active design.
  "get-resource-path": (_payload, ctx) => {
    const active = designs.getActivePreview(ctx.storage);
    if (!active) return null;
    // active is the .preview.png; the .pen file is the sibling.
    return active.replace(/\.preview\.png$/, ".pen");
  },
  "get-resource-folder-path": (_payload, ctx) => join(ctx.storage, "designs"),
  "get-is-dirty": () => false,
  "is-temporary": () => false,
  "get-workspace-folder-path": (_payload, ctx) => ctx.workspace,
  "set-workspace-folder-path": () => undefined,

  // File ops — used for libraries, imports, temp scratch
  "read-file": async (payload, ctx) => {
    const filePath = assertAllowedFsPath((payload as { path?: unknown }).path, ctx);
    assertAllowedRealPath(filePath, ctx);
    const buf = await fs.promises.readFile(filePath);
    return Array.from(buf);
  },
  "write-file": async (payload, ctx) => {
    const data = payload as { path?: unknown; contents?: unknown };
    const filePath = assertAllowedFsPath(data.path, ctx);
    if (!Array.isArray(data.contents)) {
      throw new Error("contents must be an array");
    }
    if (fs.existsSync(filePath)) assertAllowedRealPath(filePath, ctx);
    else assertAllowedExistingAncestor(dirname(filePath), ctx);
    await fs.promises.mkdir(dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, Buffer.from(data.contents));
    return undefined;
  },
  "ensure-dir": async (payload, ctx) => {
    const dirPath = assertAllowedFsPath((payload as { path?: unknown }).path, ctx);
    assertAllowedExistingAncestor(dirPath, ctx);
    await fs.promises.mkdir(dirPath, { recursive: true });
    return undefined;
  },
  "watch-file": () => undefined,
  "unwatch-file": () => undefined,

  // Save flow — editor sends `notify("save-resource", { content })`.
  // We persist to disk and re-broadcast.
  "save-resource": async (payload, ctx) => {
    const data = payload as { content?: unknown };
    if (typeof data?.content !== "string") {
      throw new Error("save-resource requires payload.content to be a string");
    }
    const active = designs.getActivePreview(ctx.storage);
    if (!active) throw new Error("no active resource to save into");
    const penPath = active.replace(/\.preview\.png$/, ".pen");
    await fs.promises.mkdir(dirname(penPath), { recursive: true });
    await fs.promises.writeFile(penPath, data.content, "utf8");
    return true;
  },

  // Chat — empty stubs. The editor's chat panel won't have history but
  // the canvas itself works fine without it.
  "chat-sessions-load": () => [],
  "chat-session-save": () => true,
  "chat-session-delete": () => true,

  // Agent control — Deus drives via MCP tools, editor's agent panel stays idle.
  "agent-stop": () => undefined,

  // Imports (libraries, asset drops) — stub to non-blocking failures.
  "import-file": () => {
    throw new Error("file import not implemented in this host");
  },
  "import-files": () => {
    throw new Error("file import not implemented in this host");
  },
  "import-uri": () => {
    throw new Error("file import not implemented in this host");
  },
  "save-temp-file": () => {
    throw new Error("temp files not implemented in this host");
  },
  "cleanup-temp-files": () => undefined,
  "find-libraries": () => [],
  "browse-libraries": () => undefined,
  "turn-into-library": () => undefined,

  // External (out-of-band) handoffs
  "open-external-url": () => undefined,
  "change-workspace-folder": () => undefined,

  // Agent provider configuration. Shapes here matter — the editor's
  // export dialog renders integration buttons by iterating
  // `integrations.supported`. Returning a bare array crashes its render
  // tree with `t.supported is not iterable`, which silently unmounts
  // the entire editor. The proper shape is { active, supported }.
  "claude-set": () => true,
  "codex-set": () => true,
  "get-mcp-config": () => JSON.stringify({ mcpServers: {} }),
  "get-active-integrations": () => ({ active: [], supported: [] }),
  "toggle-mcp-integration": () => undefined,
  "agent-include-partial-messages": () => undefined,
  "get-agent-package-path": () => undefined,
  "get-agent-env": () => undefined,
  "get-agent-api-key": () => undefined,

  // Editor announces it's ready. pushFileUpdate handles its own retries.
  initialized: (_payload, ctx) => {
    const active = designs.getActivePreview(ctx.storage);
    if (active) {
      const penPath = active.replace(/\.preview\.png$/, ".pen");
      if (fs.existsSync(penPath)) {
        pushFileUpdate(penPath, { zoomToFit: true });
      }
    }
    return undefined;
  },
  "request-save": () => undefined,
};

// ---- public surface -------------------------------------------------------

export async function handleEditorMessage(
  msg: IpcMessage,
  ctx: Context
): Promise<IpcMessage | null> {
  if (msg.type === "notification") {
    // Notifications from the editor → host. We dispatch to the same
    // handler map, but no response is sent.
    const handler = handlers[msg.method];
    if (handler) {
      try {
        await handler(msg.payload, ctx);
      } catch (err) {
        console.warn(`[ipc] notification ${msg.method} handler threw: ${(err as Error).message}`);
      }
    }
    return null;
  }
  if (msg.type === "response") {
    // Editor responding to a request we sent — no-op for now.
    return null;
  }
  if (msg.type === "request") {
    const handler = handlers[msg.method];
    if (!handler) {
      return {
        id: msg.id,
        type: "response",
        method: msg.method,
        error: {
          code: "METHOD_NOT_FOUND",
          message: `host has no handler for '${msg.method}'`,
        },
      };
    }
    try {
      const result = await handler(msg.payload, ctx);
      return { id: msg.id, type: "response", method: msg.method, payload: result };
    } catch (err) {
      const error = err as Error;
      return {
        id: msg.id,
        type: "response",
        method: msg.method,
        error: { code: "HANDLER_ERROR", message: error.message, stack: error.stack },
      };
    }
  }
  return null;
}

/** Push a notification from host to editor. The iframe's bridge listens
 *  on the SSE `ipc-notify` event and re-emits via window.postMessage. */
export function notifyEditor(method: string, payload?: unknown): void {
  const msg: IpcMessage = {
    id: `host-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    type: "notification",
    method,
    payload,
  };
  broadcastEvent("ipc-notify", msg as unknown as Record<string, unknown>);
}
