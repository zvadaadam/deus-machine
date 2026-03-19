/**
 * Browser Server Service — Backend
 *
 * Manages the dev-browser HTTP server child process for agent browser automation.
 */

import { spawn, type ChildProcess } from "child_process";
import { randomBytes } from "crypto";
import { resolve as resolvePath } from "path";
import { existsSync } from "fs";

let browserProcess: ChildProcess | null = null;
let browserPort: number | null = null;
let browserAuthToken: string | null = null;

export async function startBrowserServer(
  browserPath: string
): Promise<{ port: number; authToken: string }> {
  if (browserProcess) {
    return { port: browserPort!, authToken: browserAuthToken! };
  }

  // Security: validate browserPath before executing it as a Node.js script.
  const resolvedPath = browserPath.startsWith(".")
    ? resolvePath(process.cwd(), browserPath)
    : resolvePath(browserPath);

  // Must be a JavaScript file
  if (
    !resolvedPath.endsWith(".js") &&
    !resolvedPath.endsWith(".cjs") &&
    !resolvedPath.endsWith(".mjs")
  ) {
    throw new Error("Browser server path must be a JavaScript file (.js, .cjs, or .mjs)");
  }

  // Must not contain null bytes (path traversal defense)
  if (resolvedPath.includes("\0")) {
    throw new Error("Browser server path contains null bytes");
  }

  // Must exist on disk
  if (!existsSync(resolvedPath)) {
    throw new Error(`Browser server script not found: ${resolvedPath}`);
  }

  browserAuthToken = randomBytes(16).toString("hex");

  return new Promise<{ port: number; authToken: string }>((resolve, reject) => {
    browserProcess = spawn(process.execPath, [resolvedPath], {
      env: {
        ...process.env,
        AUTH_TOKEN: browserAuthToken!,
        PORT: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let resolved = false;
    let stdoutBuffer = "";

    browserProcess.stdout?.on("data", (data: Buffer) => {
      stdoutBuffer += data.toString();
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() ?? ""; // Keep incomplete last line in buffer
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("PORT=")) {
          const port = parseInt(trimmed.slice("PORT=".length), 10);
          if (!isNaN(port)) {
            browserPort = port;
            if (!resolved) {
              resolved = true;
              resolve({ port, authToken: browserAuthToken! });
            }
          }
        }
      }
    });

    browserProcess.stderr?.on("data", (data: Buffer) => {
      console.error("[browser-server:stderr]", data.toString().trim());
    });

    browserProcess.on("exit", (code) => {
      console.log(`[browser-server] Exited with code=${code}`);
      browserProcess = null;
      browserPort = null;
      browserAuthToken = null;
      if (!resolved) {
        resolved = true;
        reject(new Error(`Browser server exited before ready (code=${code})`));
      }
    });

    browserProcess.on("error", (err) => {
      console.error("[browser-server] Spawn error:", err);
      browserProcess = null;
      browserPort = null;
      browserAuthToken = null;
      if (!resolved) {
        resolved = true;
        reject(err);
      }
    });

    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        browserProcess = null;
        browserPort = null;
        browserAuthToken = null;
        reject(new Error("Browser server did not emit PORT within 10s"));
      }
    }, 10_000);
  });
}

export function stopBrowserServer(): void {
  if (browserProcess) {
    browserProcess.kill("SIGTERM");
    const proc = browserProcess;
    const forceTimer = setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
    }, 3_000);
    proc.once("exit", () => clearTimeout(forceTimer));
    browserProcess = null;
    browserPort = null;
    browserAuthToken = null;
  }
}

export function getBrowserServerStatus(): {
  running: boolean;
  port: number | null;
  authToken: string | null;
} {
  return {
    running: browserProcess !== null && !browserProcess.killed,
    port: browserPort,
    authToken: browserAuthToken,
  };
}
