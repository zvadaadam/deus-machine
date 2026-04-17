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
  usage: "serve [--port 3100] [--host 127.0.0.1] [--open]",
  examples: ["serve", "serve --port 4000", "serve --open"],
  schema,
  async handler(params): Promise<CommandResult> {
    const port = params.port ?? params.p ?? 3100;
    const host = params.host ?? "127.0.0.1";

    const here = path.dirname(fileURLToPath(import.meta.url));
    // When compiled (dist/cli.js), the server module lives in src/server/index.ts
    // relative to the package root. Locate by walking up from __dirname.
    const moduleCandidates = [
      path.resolve(here, "../../server/index.ts"), // dev: src/cli/commands/ → src/server/index.ts
      path.resolve(here, "../../../src/server/index.ts"), // dist/cli.js → package root → src/server/index.ts
      path.resolve(here, "../server/index.js"), // future compiled layout (dist/cli + dist/server)
    ];
    const { existsSync } = await import("node:fs");
    const serverModule = moduleCandidates.find((p) => existsSync(p));
    if (!serverModule) {
      return {
        success: false,
        message: `Could not locate server module. Checked: ${moduleCandidates.join(", ")}`,
      };
    }

    const url = `http://${host}:${port}/`;
    // Hand off to bun to run the server. We exec rather than import because
    // the server module takes over the process lifecycle (Bun.serve).
    const child = spawn(process.argv0, [serverModule], {
      env: { ...process.env, PORT: String(port), HOST: host },
      stdio: "inherit",
    });

    if (params.open) {
      // Defer opening the browser until the server says it's listening.
      setTimeout(() => {
        const opener = process.platform === "darwin" ? "open" : "xdg-open";
        spawn(opener, [url], { detached: true, stdio: "ignore" }).unref();
      }, 1500);
    }

    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    return {
      success: true,
      message: `Server stopped.`,
    };
  },
};
