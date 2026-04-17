import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { findBridgePath, SIMBRIDGE_ENV } from "../../engine/simbridge.js";
import { renderViewerHtml } from "./viewer-html.js";

interface StreamState {
  pid: number;
  port: number;
  udid: string;
  startedAt: string;
  viewerFile?: string;
}

const STATE_DIR = join(homedir(), ".device-use");
const STATE_FILE = join(STATE_DIR, "stream.json");

function readState(): StreamState | null {
  if (!existsSync(STATE_FILE)) return null;

  let data: StreamState;
  try {
    data = JSON.parse(readFileSync(STATE_FILE, "utf-8")) as StreamState;
  } catch {
    return null;
  }

  try {
    process.kill(data.pid, 0);
    return data;
  } catch {
    clearState();
    return null;
  }
}

function writeState(state: StreamState): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function clearState(): void {
  try {
    unlinkSync(STATE_FILE);
  } catch {
    /* ignore */
  }
}

export interface StreamEnableResult {
  success: boolean;
  port: number;
  url: string;
  viewerUrl: string;
  viewerFile: string;
  message?: string;
}

async function fetchScreenConfig(port: number): Promise<{ width: number; height: number } | null> {
  try {
    const res = await fetch(`http://localhost:${port}/config`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { width?: number; height?: number };
    if (typeof data.width === "number" && typeof data.height === "number") {
      return { width: data.width, height: data.height };
    }
    return null;
  } catch {
    return null;
  }
}

function writeViewerFile(port: number, width: number, height: number): string {
  const html = renderViewerHtml({ port, width, height });
  const path = join(tmpdir(), `device-use-viewer-${port}.html`);
  writeFileSync(path, html, "utf-8");
  return path;
}

export async function streamEnable(
  udid: string,
  port: number,
  options?: { startupTimeoutMs?: number }
): Promise<StreamEnableResult> {
  const existing = readState();
  if (existing) {
    const viewerFile =
      existing.viewerFile && existsSync(existing.viewerFile)
        ? existing.viewerFile
        : writeViewerFile(existing.port, 0, 0);
    return {
      success: true,
      port: existing.port,
      url: `http://localhost:${existing.port}`,
      viewerUrl: `file://${viewerFile}`,
      viewerFile,
      message: `Stream already running on port ${existing.port} (PID: ${existing.pid})`,
    };
  }

  const bridgePath = findBridgePath();
  if (!existsSync(bridgePath)) {
    throw new Error(
      `simbridge binary not found at ${bridgePath}. Run: cd native && swift build -c release`
    );
  }

  return new Promise((resolve, reject) => {
    const startupTimeoutMs = options?.startupTimeoutMs ?? 10_000;
    const child = spawn(bridgePath, ["--stream", "--udid", udid, "--port", String(port)], {
      stdio: ["ignore", "pipe", "ignore"],
      detached: true,
      env: SIMBRIDGE_ENV,
    });

    let stdout = "";
    let resolved = false;

    const stopChild = () => {
      if (!child.pid) return;
      try {
        process.kill(child.pid, "SIGTERM");
      } catch {
        /* ignore */
      }
    };

    const fail = (message: string, shouldStopChild: boolean = true) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      if (shouldStopChild) stopChild();
      reject(new Error(message));
    };

    const timeout = setTimeout(() => {
      fail(`Stream server failed to start within ${Math.ceil(startupTimeoutMs / 1000)}s`);
    }, startupTimeoutMs);

    child.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
      if (!resolved && stdout.includes('"status"')) {
        try {
          const info = JSON.parse(stdout.trim().split("\n").pop()!) as {
            port: number;
            url: string;
          };

          resolved = true;
          clearTimeout(timeout);

          // Fetch screen dims + write viewer file. The server is up by the time we see
          // its status line, but give /config a brief window to respond.
          const finish = async () => {
            const cfg = (await fetchScreenConfig(info.port)) ?? { width: 0, height: 0 };
            const viewerFile = writeViewerFile(info.port, cfg.width, cfg.height);

            const state: StreamState = {
              pid: child.pid!,
              port: info.port,
              udid,
              startedAt: new Date().toISOString(),
              viewerFile,
            };
            writeState(state);

            child.stdout?.destroy();
            child.unref();

            resolve({
              success: true,
              port: info.port,
              url: info.url,
              viewerUrl: `file://${viewerFile}`,
              viewerFile,
            });
          };

          void finish().catch((err) =>
            fail(
              `Failed to finalize stream setup: ${err instanceof Error ? err.message : String(err)}`
            )
          );
        } catch {
          fail(`Failed to parse stream info: ${stdout}`);
        }
      }
    });

    child.on("error", (err) => {
      fail(`Failed to spawn stream server: ${err.message}`, false);
    });

    child.on("exit", (code) => {
      fail(`Stream server exited with code ${code}`, false);
    });
  });
}

export function streamDisable(): { success: boolean; message: string } {
  const state = readState();
  if (!state) {
    return { success: false, message: "No stream server running" };
  }

  try {
    process.kill(state.pid, "SIGTERM");
  } catch {
    // already dead
  }

  if (state.viewerFile) {
    try {
      unlinkSync(state.viewerFile);
    } catch {
      /* viewer file already gone */
    }
  }

  clearState();
  return { success: true, message: `Stream server stopped (PID: ${state.pid})` };
}

export function streamStatus(): {
  enabled: boolean;
  port?: number;
  udid?: string;
  pid?: number;
  url?: string;
  viewerUrl?: string;
  startedAt?: string;
} {
  const state = readState();
  if (!state) {
    return { enabled: false };
  }

  return {
    enabled: true,
    port: state.port,
    udid: state.udid,
    pid: state.pid,
    url: `http://localhost:${state.port}`,
    viewerUrl: state.viewerFile ? `file://${state.viewerFile}` : undefined,
    startedAt: state.startedAt,
  };
}
