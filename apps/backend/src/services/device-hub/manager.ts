import { spawn } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, rename, rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { subscriptionKey } from "@deus/runtime-client";
import type { HubView } from "@shared/api/device-hub";
import { createBackendChildEnv } from "@shared/lib/child-env";
import { HUB_STREAM_MODE, type HubStatus } from "@shared/types/device-hub";
import { getErrorMessage } from "@shared/lib/errors";
import manifest from "../../../../../resources/device-hub/package.json";

export const hubVersion = manifest.dependencies["expo-device-hub"];
const packagePath = "node_modules/expo-device-hub";
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
    stdio: ["ignore", "ignore", installing ? "pipe" : "ignore"],
  });
  let stderr = "";
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-4096);
  });
  let kill: NodeJS.Timeout | undefined;
  const stop = () => {
    child.kill("SIGTERM");
    kill = setTimeout(() => child.kill("SIGKILL"), 1500);
  };
  signal.addEventListener("abort", stop, { once: true });
  const closed = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, reason) => {
      if (code === 0) return resolve();
      const detail = stderr.trim().split("\n").slice(-8).join("\n");
      reject(new Error(detail || `Process exited with ${reason ?? "code " + code}.`));
    });
  }).finally(() => {
    signal.removeEventListener("abort", stop);
    clearTimeout(kill);
  });
  return { child, closed };
}

async function discover(
  directory: string,
  pid: number | undefined,
  signal: AbortSignal
): Promise<HubEndpoint> {
  for (;;) {
    signal.throwIfAborted();
    for (const file of await readdir(directory)) {
      const match = /^server-(\d+)\.json$/.exec(file);
      if (!match) continue;
      // Expo publishes this 0600 file by rename after listen(). Never return its URL or contents to a client.
      const text = await readFile(join(directory, file), "utf8");
      let state;
      try {
        state = JSON.parse(text);
      } catch {
        throw new Error("The device service wrote an unreadable discovery file.");
      }
      const port = Number(match[1]);
      const origin = `http://127.0.0.1:${port}`;
      if (
        pid &&
        state?.pid === pid &&
        state.port === port &&
        port > 0 &&
        port <= 65535 &&
        state.url === origin &&
        typeof state.token === "string" &&
        state.token.length > 0
      )
        return { origin, token: state.token };
    }
    await delay(50, undefined, { signal });
  }
}

async function installedVersion(directory: string) {
  try {
    const pkg = JSON.parse(await readFile(join(directory, packagePath, "package.json"), "utf8"));
    return pkg.version;
  } catch {
    return null;
  }
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
        let message = "Devices could not start.";
        if (this.status.phase === "installing") message = "Devices could not be set up.";
        if (this.status.phase === "ready") message = "The device connection stopped.";
        this.set({ phase: "error", message, detail: getErrorMessage(error) });
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
    const versionDirectory = join(base, hubVersion);
    // Older prototypes installed edited files at the version root under the same package version.
    const installed = join(versionDirectory, "runtime");
    const env = createBackendChildEnv();
    this.set({ phase: "starting" });
    await mkdir(base, { recursive: true, mode: 0o700 });
    await chmod(base, 0o700);
    if ((await installedVersion(installed)) !== hubVersion) {
      this.set({ phase: "installing" });
      const staging = await mkdtemp(join(base, ".install-"));
      try {
        const staged = join(staging, "runtime");
        await mkdir(staged);
        const resources = process.env.DEUS_RESOURCES_PATH;
        const source = resources
          ? join(resources, "app.asar.unpacked/resources/device-hub")
          : fileURLToPath(new URL("../../../../../resources/device-hub/", import.meta.url));
        for (const file of ["package.json", "bun.lock"])
          await cp(join(source, file), join(staged, file));
        await launch(
          ["install", "--frozen-lockfile", "--ignore-scripts"],
          staged,
          env,
          AbortSignal.any([signal, AbortSignal.timeout(180_000)]),
          true
        ).closed;
        if ((await installedVersion(staged)) !== hubVersion)
          throw new Error("Bun did not install the pinned device package.");
        signal.throwIfAborted();
        await rm(versionDirectory, { recursive: true, force: true });
        await rename(staging, versionDirectory);
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
      this.set({ phase: "starting" });
    }
    const { simulatorEnv } = await import("device-use/engine");
    const stateDirectory = join(base, "state");
    const simDirectory = join(base, "serve-sim");
    await rm(stateDirectory, { recursive: true, force: true });
    await mkdir(stateDirectory, { mode: 0o700 });
    await mkdir(simDirectory, { recursive: true, mode: 0o700 });
    await chmod(simDirectory, 0o700);
    const childEnv = {
      ...simulatorEnv(env),
      EXPO_DEVICE_HUB_STATE_DIR: stateDirectory,
      SERVE_SIM_STATE_DIR: simDirectory,
    };
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
    const timeout = setTimeout(
      () =>
        stop.abort(new Error("The device service did not report its address within 30 seconds.")),
      30_000
    );
    try {
      this.endpoint = await Promise.race([
        discover(stateDirectory, hub.child.pid, processSignal),
        hub.closed.then((): never => {
          throw new Error("The device service exited before it was ready.");
        }),
      ]);
      clearTimeout(timeout);
      this.set({ phase: "ready", instance: crypto.randomUUID() });
      await hub.closed;
      throw new Error("The device service exited.");
    } catch (error) {
      stop.signal.throwIfAborted();
      throw error;
    } finally {
      clearTimeout(timeout);
      this.endpoint = null;
      stop.abort();
      await hub.closed.catch(() => {});
      await rm(stateDirectory, { recursive: true, force: true });
    }
  }
}
