// packages/pencil/src/serve.ts
//
// AAP launcher entry. Thin: parse args, boot HTTP, hand off to router.

import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:http";

import * as auth from "./lib/auth.ts";
import * as ops from "./lib/ops.ts";
import { createRouter } from "./lib/router.ts";
import { ensureEditorBundle } from "./lib/editor-bundle.ts";
import { notifyEditor } from "./lib/ipc-host.ts";
import * as designs from "./lib/designs.ts";
import { startTransportServer, stopTransportServer } from "./lib/transport-server.ts";
import { startMcpBinary, stopMcpBinary } from "./lib/mcp-binary.ts";

interface CliArgs {
  port: number;
  workspace: string;
  storage: string;
}

function parseArgs(): CliArgs {
  const argv = process.argv.slice(2);
  let port: number | null = null;
  let workspace: string | null = null;
  let storage: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--port" && value !== undefined) port = Number(value);
    else if (flag === "--workspace" && value !== undefined) workspace = value;
    else if (flag === "--storage" && value !== undefined) storage = value;
  }
  if (!Number.isInteger(port) || (port ?? 0) <= 0) {
    console.error("[pencil-aap] missing or invalid --port");
    process.exit(2);
  }
  if (!workspace) {
    console.error("[pencil-aap] missing --workspace");
    process.exit(2);
  }
  if (!storage) {
    console.error("[pencil-aap] missing --storage");
    process.exit(2);
  }
  return { port: port as number, workspace, storage };
}

async function prefetchEditorBundle(): Promise<void> {
  try {
    const dir = await ensureEditorBundle();
    console.log(`[pencil-aap] prefetched editor bundle: ${dir}`);
  } catch (err) {
    console.warn(`[pencil-aap] editor bundle prefetch failed: ${(err as Error).message}`);
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  if (process.argv.includes("--prefetch-editor")) {
    await prefetchEditorBundle();
    return;
  }

  const opts = parseArgs();
  const baseCtx = { workspace: opts.workspace, storage: opts.storage };

  fs.mkdirSync(baseCtx.storage, { recursive: true });
  fs.mkdirSync(join(baseCtx.storage, "designs"), { recursive: true });

  // Resolve the editor bundle BEFORE starting the HTTP server so the iframe
  // never gets a 404 on first load. The fetch is fast on a warm cache and
  // happens once per editor version on cold cache.
  let editorBundleDir: string;
  try {
    editorBundleDir = await ensureEditorBundle();
  } catch (err) {
    console.error(
      `[pencil-aap] could not obtain editor bundle: ${(err as Error).message}\n` +
        "First-run downloads the editor bundle from api.pencil.dev. Install Pencil's VS Code/Cursor extension once if you're offline."
    );
    process.exit(3);
  }
  const ctx = { ...baseCtx, editorBundleDir, panelToken: randomUUID() };

  // Wire a watcher on the active design so the editor sees `file-update`
  // notifications when the CLI rewrites the .pen file.
  watchActiveDesignForUpdates(ctx.storage);

  // Start the Pencil host TransportServer (Unix socket) and spawn the
  // bundled mcp-server binary as a long-lived child connecting to it.
  // The binary's HTTP MCP gives the agent the *full* Pencil tool surface
  // (batch_design, get_editor_state, get_screenshot, …) bridged to the
  // iframe editor's IPC handlers via lib/iframe-rpc.ts.
  await startTransportServer().catch((err) => {
    console.error(`[pencil-aap] transport-server failed: ${err.message}`);
  });
  // Slight delay before spawning so the socket is definitely listening
  // when the binary tries to dial in.
  await new Promise((r) => setTimeout(r, 100));
  const binaryInfo = await startMcpBinary().catch(() => null);
  if (binaryInfo) {
    console.log(
      `[pencil-aap] bundled MCP binary listening on http://127.0.0.1:${binaryInfo.httpPort}/mcp`
    );
  }

  const handler = createRouter(ctx);
  const server = createServer((req, res) => {
    handler(req, res).catch((err: unknown) => {
      console.error("[pencil-aap] handler error:", err);
      try {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("internal error");
      } catch {
        /* connection already closed */
      }
    });
  });

  server.listen(opts.port, "127.0.0.1", () => {
    console.log(
      `[pencil-aap] listening on http://127.0.0.1:${opts.port}/  ·  ` +
        `workspace=${ctx.workspace}  storage=${ctx.storage}`
    );
    console.log(`[pencil-aap] editor bundle: ${editorBundleDir}`);
    const a = auth.authState();
    if (a.authed) {
      const src = a.cliKeySource ?? (a.sessionValid ? "session" : "?");
      console.log(
        `[pencil-aap] authenticated via ${src}${a.sessionEmail ? ` (${a.sessionEmail})` : ""}`
      );
    } else {
      console.log("[pencil-aap] NOT authenticated — open the panel to paste a CLI key");
    }
  });

  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.on(sig, () => {
      console.log(`[pencil-aap] received ${sig}, shutting down`);
      ops.endAllSubscribers();
      const cur = ops.getCurrentOp();
      if (cur && cur.child) {
        try {
          cur.child.kill("SIGTERM");
        } catch {
          /* already gone */
        }
      }
      // Best-effort transport + binary teardown — async, but we exit
      // shortly anyway.
      void stopMcpBinary();
      void stopTransportServer();
      server.close();
      setTimeout(() => process.exit(0), 500);
    });
  }
}

/** Watch <storage>/designs/ for .pen rewrites. When the CLI writes a new
 *  version of the active .pen file, push `file-update` to the editor so it
 *  reloads the canvas. Coalesced to one event per 200 ms per file (fs.watch
 *  fires multiple times for one logical write). */
function watchActiveDesignForUpdates(storage: string): void {
  const dir = join(storage, "designs");
  fs.mkdirSync(dir, { recursive: true });
  const lastFiredByName = new Map<string, number>();
  try {
    fs.watch(dir, (_event, filename) => {
      if (!filename || !filename.endsWith(".pen")) return;
      const last = lastFiredByName.get(filename) ?? 0;
      if (Date.now() - last < 200) return;
      lastFiredByName.set(filename, Date.now());

      const penPath = join(dir, filename);
      // Tell the iframe editor only when this file is what's currently open.
      const active = designs.getActivePreview(storage);
      if (!active) return;
      const activePen = active.replace(/\.preview\.png$/, ".pen");
      if (activePen !== penPath) return;

      try {
        const content = fs.readFileSync(penPath, "utf8");
        notifyEditor("file-update", {
          fileURI: pathToFileURL(penPath).href,
          content,
          isDirty: false,
        });
      } catch {
        /* file might be mid-write; we'll catch the next coalesced event */
      }
    });
  } catch {
    /* watch failed — agent will still work; editor just won't auto-reload */
  }
}

main().catch((err: unknown) => {
  console.error("[pencil-aap] fatal:", err);
  process.exit(1);
});
