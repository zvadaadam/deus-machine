// Owns the long-lived `simbridge --stream` subprocess. Exposes an async
// MJPEG passthrough for /stream.mjpeg, and a WebSocket for simulator
// input (touch/key events) routed back to simbridge.
//
// For Phase 3, we proxy the upstream simbridge stream via a second HTTP
// port allocated inside simbridge (that's how perth-v2 shaped it — simbridge
// owns its own mini HTTP server for /stream.mjpeg + /config + /ws). We
// start that subprocess when a simulator is booted and stop it when the
// server shuts down or the sim changes.

import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { findBridgePath } from "../engine/simbridge.js";

export interface StreamInfo {
  udid: string;
  port: number;
  url: string;
  /** Raw pixel + logical point dimensions of the simulator screen. */
  size?: { pxW: number; pxH: number; ptW: number; ptH: number };
}

/**
 * Heuristic pixel-to-point scale. Every shipping iPhone since ~2014 is 3x;
 * older/SE devices and iPads vary. We default to 3 and fall back to
 * dividing the pixel width by common point widths if needed.
 * A future refinement would query `xcrun simctl` for the device type.
 */
const DEFAULT_SCALE = 3;

async function pickFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (typeof addr === "object" && addr) {
        const port = addr.port;
        server.close(() => resolve(port));
      } else {
        reject(new Error("failed to allocate port"));
      }
    });
  });
}

export class StreamManager {
  private child: ChildProcess | undefined;
  private info: StreamInfo | undefined;
  private readonly bridgePath: string;

  constructor(bridgePath = findBridgePath()) {
    this.bridgePath = bridgePath;
  }

  getInfo(): StreamInfo | undefined {
    return this.info;
  }

  /** Starts streaming the given simulator. Stops any previous stream. */
  async start(udid: string): Promise<StreamInfo> {
    if (this.info?.udid === udid && this.child && !this.child.killed) {
      return this.info;
    }
    await this.stop();

    const port = await pickFreePort();
    const child = spawn(this.bridgePath, ["--stream", "--udid", udid, "--port", String(port)], {
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });

    // Wait for the upstream to begin listening — a very short readiness probe.
    let size: StreamInfo["size"];
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`simbridge stream timed out on port ${port}`));
      }, 5000);
      const tryProbe = async () => {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/config`);
          if (res.ok) {
            clearTimeout(timer);
            try {
              const cfg = (await res.json()) as { width: number; height: number };
              size = {
                pxW: cfg.width,
                pxH: cfg.height,
                ptW: Math.round(cfg.width / DEFAULT_SCALE),
                ptH: Math.round(cfg.height / DEFAULT_SCALE),
              };
            } catch {
              // /config didn't return expected shape — leave size undefined
            }
            resolve();
            return;
          }
        } catch {
          // not up yet
        }
        setTimeout(tryProbe, 100);
      };
      tryProbe();
    });

    child.stderr?.on("data", (buf: Buffer) => {
      // Drop stderr — simbridge is noisy about private-framework warnings.
      void buf;
    });

    child.once("exit", () => {
      if (this.child === child) {
        this.child = undefined;
        this.info = undefined;
      }
    });

    this.child = child;
    this.info = { udid, port, url: `http://127.0.0.1:${port}`, ...(size && { size }) };
    return this.info;
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child || child.killed) {
      this.child = undefined;
      this.info = undefined;
      return;
    }
    this.child = undefined;
    this.info = undefined;
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 2000);
    });
  }

  /** Returns an HTTP Response piping the upstream MJPEG stream. */
  async proxyStream(): Promise<Response> {
    if (!this.info) {
      return new Response("stream not started", { status: 404 });
    }
    const upstream = await fetch(`${this.info.url}/stream.mjpeg`);
    return new Response(upstream.body, {
      status: upstream.status,
      headers: upstream.headers,
    });
  }
}
