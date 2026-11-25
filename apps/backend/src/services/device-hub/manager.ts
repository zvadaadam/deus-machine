import { spawn, type ChildProcess } from "node:child_process";
import { cp, mkdir, mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { subscriptionKey } from "@deus/runtime-client";
import type { HubView } from "@shared/api/device-hub";
import { createBackendChildEnv } from "@shared/lib/child-env";
import { HUB_STREAM_MODE, type HubStatus } from "@shared/types/device-hub";
import { AppError } from "../../lib/errors";
import { prepareHub } from "./prepare";
import manifest from "../../../../../resources/device-hub/package.json";

export const hubVersion = manifest.dependencies["expo-device-hub"];
const packagePath = "node_modules/expo-device-hub";
// Bump this marker when the in-memory credential handoff changes. A stock CLI at the
// same version would publish its token before the parent could refuse its handshake.
const preparedMarker = ".deus-private-hub-v1";
const cliPath = packagePath + "/dist/server/cli.mjs";

export interface HubEndpoint {
  origin: string;
  token: string;
}

function launch(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  installing = false
) {
  signal.throwIfAborted();
  const runtime = process.env.DEUS_RUNTIME_EXECUTABLE;
  const child = spawn(runtime || "bun", args, {
    cwd,
    env: runtime ? { ...env, BUN_BE_BUN: "1" } : env,
    stdio: ["ignore", "ignore", installing ? "pipe" : "ignore", "pipe"],
  });
  let installIssue: string | undefined;
  child.stderr?.on("data", (chunk: Buffer) => {
    const line = chunk.toString();
    if (/ENOSPC|no space left/i.test(line))
      installIssue = "There is not enough disk space to install Device Hub.";
    else if (
      /ENOTFOUND|EAI_AGAIN|ConnectionRefused|ECONNRESET|FailedToResolve|connect.*failed|fetch.*failed|connection.*timed out/i.test(
        line
      )
    )
      installIssue = "Could not download Device Hub. Check your network connection and retry.";
  });
  const stop = () => {
    child.kill("SIGTERM");
    kill = setTimeout(() => child.kill("SIGKILL"), 1500);
  };
  let kill: NodeJS.Timeout | undefined;
  signal.addEventListener("abort", stop, { once: true });
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0 && installIssue) reject(new AppError(503, installIssue));
      else resolve(code);
    });
  }).finally(() => {
    signal.removeEventListener("abort", stop);
    clearTimeout(kill);
  });
  return { child, closed };
}

async function handshake(child: ChildProcess): Promise<HubEndpoint> {
  const pipe = child.stdio[3];
  if (!pipe || !("readable" in pipe)) throw new Error("Missing Device Hub readiness pipe.");
  let message = "";
  for await (const chunk of pipe) {
    message += chunk.toString();
    if (message.length > 256) break;
    if (!message.includes("\n")) continue;
    const { port, token } = JSON.parse(message);
    if (
      Number.isInteger(port) &&
      port > 0 &&
      port <= 65535 &&
      typeof token === "string" &&
      /^[\w-]{43}$/.test(token)
    ) {
      return { origin: `http://127.0.0.1:${port}`, token };
    }
    break;
  }
  throw new Error("Device Hub closed its readiness pipe.");
}

interface HubOptions {
  directory: string;
  changed: (status: HubStatus, view: HubView) => void;
  idleMs?: number;
}

export class DeviceHub {
  status: HubStatus = { phase: "idle" };
  endpoint: HubEndpoint | null = null;
  private readonly views = new Set<HubView>();
  private idle?: NodeJS.Timeout;
  private controller?: AbortController;
  private running?: Promise<void>;
  private disposed = false;

  constructor(private readonly options: HubOptions) {}

  follow(scope: HubView) {
    // Two connections can follow the same workspace and device.
    const view = { ...scope };
    this.views.add(view);
    clearTimeout(this.idle);
    if (this.status.phase === "idle" || this.status.phase === "error") this.start();
    return () => {
      this.views.delete(view);
      if (!this.views.size && !this.disposed) {
        this.idle = setTimeout(() => this.controller?.abort(), this.options.idleMs ?? 180_000);
      }
    };
  }

  displayedDevice(workspaceId: string) {
    if (this.status.phase !== "ready") return null;
    // A viewer can disappear without sending a final write. Its subscription is the lease.
    const view = [...this.views]
      .reverse()
      .find((v) => v.workspaceId === workspaceId && v.platform && v.deviceId);
    if (!view?.platform || !view.deviceId || !/^[a-zA-Z0-9_:.[\]-]+$/.test(view.deviceId))
      return null;
    return { platform: view.platform, id: view.deviceId };
  }

  retry() {
    if (this.views.size && this.status.phase === "error") this.start();
  }

  async shutdown() {
    this.disposed = true;
    clearTimeout(this.idle);
    this.controller?.abort();
    await this.running;
  }

  private set(status: HubStatus) {
    this.status = status;
    const scopes = new Map([...this.views].map((view) => [subscriptionKey(view), view]));
    for (const view of scopes.values()) this.options.changed(status, view);
  }

  private start() {
    if (this.running || this.disposed) return;
    const controller = new AbortController();
    this.controller = controller;
    this.running = this.run(controller.signal)
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        let message = "Device Hub could not start its local server.";
        if (error instanceof AppError) message = error.message;
        else if (this.status.phase === "installing")
          message =
            "Device Hub could not install. Check the network connection and available disk space.";
        else if (this.status.phase === "ready")
          message = "Device Hub stopped while the panel was open.";
        this.set({ phase: "error", message });
      })
      .finally(() => {
        this.endpoint = null;
        this.running = undefined;
        this.controller = undefined;
        if (controller.signal.aborted) {
          this.set({ phase: "idle" });
          if (this.views.size) this.start();
        }
      });
  }

  private async run(signal: AbortSignal) {
    const base = this.options.directory;
    const installed = join(base, hubVersion);
    const env = createBackendChildEnv();
    this.set({ phase: "starting" });
    if (!(await stat(join(installed, preparedMarker)).catch(() => null))?.isFile()) {
      this.set({ phase: "installing" });
      await mkdir(base, { recursive: true, mode: 0o700 });
      const staging = await mkdtemp(join(base, ".install-"));
      try {
        const resources = process.env.DEUS_RESOURCES_PATH;
        const source = resources
          ? join(resources, "app.asar.unpacked/resources/device-hub")
          : fileURLToPath(new URL("../../../../../resources/device-hub/", import.meta.url));
        for (const file of ["package.json", "bun.lock"])
          await cp(join(source, file), join(staging, file));
        const install = launch(
          ["install", "--frozen-lockfile", "--ignore-scripts"],
          staging,
          env,
          AbortSignal.any([signal, AbortSignal.timeout(180_000)]),
          true
        );
        if ((await install.closed) !== 0) throw new Error("Device Hub install failed.");
        await prepareHub(join(staging, packagePath));
        await writeFile(join(staging, preparedMarker), "");
        signal.throwIfAborted();
        await rm(installed, { recursive: true, force: true });
        await rename(staging, installed);
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
      this.set({ phase: "starting" });
    }
    const { simulatorEnv } = await import("device-use/engine");
    const childEnv = simulatorEnv(env);
    // Each backend sees only its own serve-sim capture sessions.
    childEnv.SERVE_SIM_STATE_DIR = join(base, "serve-sim");
    const stop = new AbortController();
    const processSignal = AbortSignal.any([signal, stop.signal]);
    const hub = launch(
      [
        cliPath,
        "--host",
        "127.0.0.1",
        "--port",
        "0",
        "--require-token",
        "--transport",
        HUB_STREAM_MODE,
      ],
      installed,
      childEnv,
      processSignal
    );
    const timeout = setTimeout(() => stop.abort(), 30_000);
    try {
      this.endpoint = await Promise.race([
        handshake(hub.child),
        hub.closed.then((): never => {
          throw new Error("Device Hub exited before it was ready.");
        }),
      ]);
      clearTimeout(timeout);
      this.set({ phase: "ready", instance: crypto.randomUUID() });
      await hub.closed;
      throw new Error("Device Hub exited.");
    } finally {
      clearTimeout(timeout);
      this.endpoint = null;
      stop.abort();
      await hub.closed;
    }
  }
}
