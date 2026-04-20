import { z } from "zod";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CommandDefinition, CommandResult } from "../../engine/types.js";

const schema = z.object({
  port: z.coerce.number().optional(),
  p: z.coerce.number().optional(),
  host: z.string().optional(),
  open: z.boolean().optional(),
});

type Params = z.infer<typeof schema>;

export const serveCommand: CommandDefinition<Params> = {
  name: "serve",
  description: "Start the device-use server (viewer + MCP + WebSocket) on the given port.",
  usage: "serve [--port 3100] [--host 0.0.0.0] [--open]",
  examples: ["serve", "serve --port 4000", "serve --open"],
  schema,
  async handler(params): Promise<CommandResult> {
    const port = params.port ?? params.p ?? 3100;
    // Bind to 0.0.0.0 by default — matches the server's own default and
    // avoids being shadowed by an IPv6 listener on the same port. Browser
    // localhost-via-v6 then falls back to v4 cleanly.
    const host = params.host ?? "0.0.0.0";

    const here = path.dirname(fileURLToPath(import.meta.url));
    // Locate the server entrypoint across dev + bundled layouts.
    // From <pkg>/src/cli/commands/serve.{ts,js}: ../../server/index.ts (dev)
    // From <pkg>/dist/cli.js (bundled): ../src/server/index.ts
    // From <pkg>/dist/cli/<…>/serve.js (future split build): ../../../server/index.js
    const moduleCandidates = [
      path.resolve(here, "../../server/index.ts"),
      path.resolve(here, "../src/server/index.ts"),
      path.resolve(here, "../../../server/index.js"),
    ];
    const { existsSync } = await import("node:fs");
    const serverModule = moduleCandidates.find((p) => existsSync(p));
    if (!serverModule) {
      return {
        success: false,
        message: `Could not locate server module. Checked: ${moduleCandidates.join(", ")}`,
      };
    }

    // For the URL we surface to the user (and probe), prefer 127.0.0.1
    // when bound to 0.0.0.0 — wildcard isn't a fetchable host on its own.
    const probeHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
    const url = `http://${probeHost}:${port}/`;

    // In-process serve: import the server module, then Bun.serve its default
    // export. We used to spawn a child bun process for this, but that left
    // an orphaned server grandchild whenever our parent (the AAP host's
    // backend or a human's Ctrl-C'd cli.js) sent us SIGKILL or SIGHUP —
    // SIGKILL can't be caught to forward, and even SIGTERM forwarding
    // raced against the parent exiting first and reparenting the
    // grandchild to init (PPID=1). Running in-process means one PID
    // serves both the CLI and HTTP — kill it and the HTTP goes with it.
    process.env.PORT = String(port);
    process.env.HOST = host;

    // Await the auto-boot side effects (state load, pinned-sim start) that
    // run at module init. The default export is a Bun.serve spec.
    const mod = (await import(serverModule)) as { default: Bun.ServeOptions };
    const bunRuntime = (globalThis as { Bun?: { serve(spec: Bun.ServeOptions): Bun.Server } }).Bun;
    if (!bunRuntime) {
      return {
        success: false,
        message: "device-use `serve` requires the Bun runtime (Node is not supported).",
      };
    }
    const server = bunRuntime.serve(mod.default);

    if (params.open) {
      // Only open the browser if /health actually responds. On startup
      // failure (port in use, missing simbridge, etc.) we silently skip
      // the open instead of pointing the user at a dead tab.
      (async () => {
        for (let i = 0; i < 30; i++) {
          try {
            const res = await fetch(`${url}health`);
            if (res.ok) {
              const opener = process.platform === "darwin" ? "open" : "xdg-open";
              spawn(opener, [url], { detached: true, stdio: "ignore" }).unref();
              return;
            }
          } catch {
            // server not up yet — keep waiting
          }
          await new Promise((r) => setTimeout(r, 200));
        }
      })();
    }

    // Park until a signal fires. Bun.serve keeps the event loop alive on its
    // own, but we still need a promise to await so handler() doesn't return
    // (and unwind CLI dispatch to exit 0 while the server is still running).
    await new Promise<void>((resolve) => {
      const shutdown = (sig: NodeJS.Signals) => {
        // Graceful: stop accepting new requests, let in-flight ones finish.
        // `true` = close existing connections too (matches what SIGTERM would
        // imply — we're going away, clients should reconnect).
        try {
          server.stop(true);
        } catch {
          // already stopping
        }
        // Exit with conventional 128 + signum so the parent can tell the
        // server was signalled vs. crashed. 143=SIGTERM, 130=SIGINT.
        const code = sig === "SIGINT" ? 130 : 143;
        resolve();
        // Give microtasks a tick to flush; then hard-exit so any lingering
        // timers (heartbeat, mjpeg poll) don't keep us up past the signal.
        setTimeout(() => process.exit(code), 50);
      };
      process.once("SIGTERM", () => shutdown("SIGTERM"));
      process.once("SIGINT", () => shutdown("SIGINT"));
    });

    return {
      success: true,
      message: "Server stopped.",
    };
  },
};
