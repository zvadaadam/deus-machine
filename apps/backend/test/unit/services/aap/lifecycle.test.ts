import { createServer } from "node:http";
import { describe, expect, it } from "vitest";

import {
  isProcessAlive,
  killByPid,
  spawnApp,
  stopChild,
  waitForReady,
} from "../../../../src/services/aap/lifecycle";
import type { Manifest } from "@shared/aap/manifest";

/** Build a minimal Manifest around a given sh command for spawn tests. */
function shManifest(script: string, env: Record<string, string> = {}): Manifest {
  return {
    protocolVersion: "1",
    id: "test.sh-app",
    name: "Sh App",
    description: "test fixture",
    version: "0.0.0",
    launch: {
      command: "sh",
      args: ["-c", script],
      env,
      ready: { type: "tcp", timeoutMs: 5_000 },
    },
    ui: { url: "http://127.0.0.1" },
    agent: { tools: { type: "mcp-http", url: "http://127.0.0.1/mcp" } },
    storage: {},
    lifecycle: { scope: "workspace", stopTimeoutMs: 2_000 },
    requires: [],
  } as Manifest;
}

/** Start a throwaway HTTP server on an ephemeral port for probe tests. */
async function startProbeServer(options: { healthStatus: number } = { healthStatus: 200 }) {
  const server = createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(options.healthStatus);
      res.end("ok");
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return { server, port, close: () => new Promise<void>((r) => server.close(() => r())) };
}

describe("aap/lifecycle", () => {
  describe("spawnApp", () => {
    it("spawns a child, fires onExit with the exit code", async () => {
      const exit = new Promise<{ code: number | null }>((resolve) => {
        const spawned = spawnApp({
          manifest: shManifest("exit 7"),
          vars: { port: 9999 },
          packageRoot: process.cwd(),
          onExit: (code) => resolve({ code }),
        });
        expect(spawned.pid).toBeGreaterThan(0);
      });
      const { code } = await exit;
      expect(code).toBe(7);
    });

    it("injects DEUS_* env vars", async () => {
      const output: string[] = [];
      const exit = new Promise<void>((resolve) => {
        const spawned = spawnApp({
          manifest: shManifest(
            'echo "id=$DEUS_APP_ID,port=$DEUS_PORT,ws=$DEUS_WORKSPACE_ID" 1>&2; exit 0'
          ),
          vars: { port: 12345, workspace: "/some/workspace" },
          packageRoot: process.cwd(),
          onExit: (_code, _signal, stderrTail) => {
            output.push(stderrTail);
            resolve();
          },
        });
        expect(spawned.pid).toBeGreaterThan(0);
      });
      await exit;
      expect(output[0]).toContain("id=test.sh-app");
      expect(output[0]).toContain("port=12345");
      expect(output[0]).toContain("ws=/some/workspace");
    });

    it("substitutes {port} in args", async () => {
      const manifest = shManifest('echo "got $1" 1>&2; exit 0');
      manifest.launch.args = ["-c", 'echo "got $1" 1>&2; exit 0', "sh", "{port}"];
      const { stderrTail } = await new Promise<{ stderrTail: string }>((resolve) => {
        spawnApp({
          manifest,
          vars: { port: 54321 },
          packageRoot: process.cwd(),
          onExit: (_code, _signal, stderrTail) => resolve({ stderrTail }),
        });
      });
      expect(stderrTail).toContain("got 54321");
    });

    it("anchors a relative launch.cwd to packageRoot, not the backend's process cwd", async () => {
      // Regression: a manifest declaring `cwd: "."` (or any relative path)
      // should resolve under the app's package directory. Without anchoring,
      // Node would resolve it against process.cwd and the app would silently
      // run in the wrong directory.
      const manifest = shManifest("pwd 1>&2; exit 0");
      manifest.launch.cwd = ".";
      const packageRoot = "/tmp";
      const { stderrTail } = await new Promise<{ stderrTail: string }>((resolve) => {
        spawnApp({
          manifest,
          vars: { port: 0 },
          packageRoot,
          onExit: (_code, _signal, stderrTail) => resolve({ stderrTail }),
        });
      });
      // macOS resolves /tmp via the /private/tmp symlink — accept either form.
      expect(stderrTail.trim()).toMatch(/^(\/private)?\/tmp$/);
    });
  });

  describe("waitForReady — http", () => {
    it("resolves when the server returns 2xx on the probe path", async () => {
      const { port, close } = await startProbeServer({ healthStatus: 200 });
      try {
        await waitForReady(
          { type: "http", path: "/health", timeoutMs: 3_000 },
          port,
          new AbortController().signal
        );
      } finally {
        await close();
      }
    });

    it("rejects when the caller's signal aborts (caller-owned timeout)", async () => {
      // Use a port very unlikely to be in use (kernel-allocated would defeat the test).
      // 1 is reserved; the probe's connect will always fail quickly.
      await expect(
        waitForReady({ type: "http", path: "/health", timeoutMs: 500 }, 1, AbortSignal.timeout(300))
      ).rejects.toThrow(/abort/i);
    });

    it("keeps polling when the server returns 5xx, then succeeds when it flips to 2xx", async () => {
      const { server, port, close } = await startProbeServer({ healthStatus: 503 });
      try {
        // After 400ms, flip the server to respond 200.
        setTimeout(() => {
          server.removeAllListeners("request");
          server.on("request", (_req, res) => {
            res.writeHead(200);
            res.end("ok");
          });
        }, 400);
        await waitForReady(
          { type: "http", path: "/health", timeoutMs: 3_000 },
          port,
          new AbortController().signal
        );
      } finally {
        await close();
      }
    });
  });

  describe("waitForReady — tcp", () => {
    it("resolves once the port accepts TCP", async () => {
      const { port, close } = await startProbeServer();
      try {
        await waitForReady({ type: "tcp", timeoutMs: 3_000 }, port, new AbortController().signal);
      } finally {
        await close();
      }
    });

    it("rejects when aborted mid-probe", async () => {
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 200);
      await expect(waitForReady({ type: "tcp", timeoutMs: 5_000 }, 1, ctrl.signal)).rejects.toThrow(
        /abort/i
      );
    });
  });

  describe("stopChild", () => {
    it("SIGTERMs a graceful child and returns its exit code", async () => {
      // A child that exits cleanly on SIGTERM. Shells default to 143 (128+15),
      // but Node reports signal='SIGTERM' and code=null — spec says we return code.
      let exitCodeFromCallback: number | null = -1;
      let exitSignalFromCallback: NodeJS.Signals | null = null;
      const spawned = spawnApp({
        manifest: shManifest("sleep 30"),
        vars: { port: 9999 },
        packageRoot: process.cwd(),
        onExit: (code, signal) => {
          exitCodeFromCallback = code;
          exitSignalFromCallback = signal;
        },
      });
      // Give sleep a beat to start so SIGTERM actually reaches it.
      await new Promise((r) => setTimeout(r, 50));
      await stopChild(spawned.child, 2_000);
      // Either SIGTERM-reported-as-signal or the shell's 143 exit code. Accept both.
      expect(exitSignalFromCallback === "SIGTERM" || exitCodeFromCallback === 143).toBe(true);
    });

    it("SIGKILLs a child that ignores SIGTERM", async () => {
      let exitSignal: NodeJS.Signals | null = null;
      const spawned = spawnApp({
        // trap "" TERM = ignore SIGTERM
        manifest: shManifest('trap "" TERM; while true; do sleep 1; done'),
        vars: { port: 9999 },
        packageRoot: process.cwd(),
        onExit: (_code, signal) => {
          exitSignal = signal;
        },
      });
      await new Promise((r) => setTimeout(r, 100));
      const start = Date.now();
      await stopChild(spawned.child, 300);
      const elapsed = Date.now() - start;
      // Should have waited ~300ms before escalating to SIGKILL.
      expect(elapsed).toBeGreaterThanOrEqual(250);
      // Final kill reason must be SIGKILL.
      expect(exitSignal).toBe("SIGKILL");
    });

    it("is a no-op when the child has already exited", async () => {
      const exit = new Promise<void>((resolve) => {
        const spawned = spawnApp({
          manifest: shManifest("exit 0"),
          vars: { port: 9999 },
          packageRoot: process.cwd(),
          onExit: async () => {
            await new Promise((r) => setTimeout(r, 20));
            // Child already exited — stopChild should return immediately.
            const result = await stopChild(spawned.child, 2_000);
            expect(result).toBe(0);
            resolve();
          },
        });
      });
      await exit;
    });
  });

  describe("isProcessAlive", () => {
    it("returns true for the current process", () => {
      expect(isProcessAlive(process.pid)).toBe(true);
    });

    it("returns false for a pid that has been reaped", async () => {
      const exit = new Promise<number>((resolve) => {
        const spawned = spawnApp({
          manifest: shManifest("exit 0"),
          vars: { port: 9999 },
          packageRoot: process.cwd(),
          onExit: () => resolve(spawned.pid),
        });
      });
      const pid = await exit;
      // Give the OS a beat to reap.
      await new Promise((r) => setTimeout(r, 50));
      expect(isProcessAlive(pid)).toBe(false);
    });
  });

  describe("killByPid", () => {
    it("does not throw when the target pid doesn't exist", () => {
      // A PID far above any plausibly-running process.
      expect(() => killByPid(2_147_483_646)).not.toThrow();
    });
  });
});
