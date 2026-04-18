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

    // Hand off to bun to run the server. We exec rather than import because
    // the server module takes over the process lifecycle (Bun.serve).
    const child = spawn(process.argv0, [serverModule], {
      env: { ...process.env, PORT: String(port), HOST: host },
      stdio: "inherit",
    });

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

    const exitCode = await new Promise<number | null>((resolve) =>
      child.once("exit", (code) => resolve(code))
    );

    if (exitCode !== 0 && exitCode !== null) {
      return {
        success: false,
        message: `Server exited with code ${exitCode}.`,
      };
    }
    return {
      success: true,
      message: "Server stopped.",
    };
  },
};
