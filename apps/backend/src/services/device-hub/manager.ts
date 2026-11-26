import { mkdir, readdir, readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import { subscriptionKey } from "@deus/runtime-client";
import type { HubView } from "@shared/api/device-hub";
import { createBackendChildEnv } from "@shared/lib/child-env";
import { HUB_STREAM_MODE, type HubStatus } from "@shared/types/device-hub";
import { getErrorMessage } from "@shared/lib/errors";
import { launch } from "./process";
import { bootIdentity } from "./simctl";
import { deviceToolchains, liveViewSupport } from "./support";
import {
  cliPath,
  installHub,
  installPath,
  prepareDirectories,
  validInstall,
  withOwnedDirectory,
} from "./storage";
import { simulatorEnv } from "./xcode-env";

export interface HubEndpoint {
  origin: string;
  token: string;
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
    const status = this.status;
    if (status.phase !== "ready" || !this.endpoint || this.controller?.signal.aborted) return null;
    // A viewer can disappear without sending a final write. Its subscription is the lease.
    const view = [...this.views]
      .reverse()
      .find(
        (v) =>
          v.workspaceId === workspaceId &&
          v.displayedInstance === status.instance &&
          v.platform &&
          v.deviceId
      );
    if (!view?.platform || !view.deviceId || !/^[a-zA-Z0-9_:.[\]-]+$/.test(view.deviceId))
      return null;
    return { platform: view.platform, id: view.deviceId };
  }

  async setupState() {
    if (this.status.phase === "error") return "failed";
    if (this.status.phase === "ready") return "ready";
    if (this.status.phase !== "idle") return "working";
    return (await validInstall(await installPath(this.options.directory))) ? "ready" : "new";
  }

  retry() {
    if (this.status.phase !== "error") return;
    this.start();
    if (!this.views.size) {
      clearTimeout(this.idle);
      this.idle = setTimeout(() => this.controller?.abort(), this.options.idleMs ?? 180_000);
    }
  }

  private async watchBoots(signal: AbortSignal) {
    const boots = new Map<string, number>();
    while (!signal.aborted) {
      const shown = new Set(
        [...this.views].filter((v) => v.platform === "ios").map((v) => v.deviceId)
      );
      for (const id of shown) {
        if (!id) continue;
        const pid = await bootIdentity(id).catch(() => null);
        if (!pid || signal.aborted) continue;
        if (boots.has(id) && boots.get(id) !== pid) {
          // The old native input channel continues to accept taps after reboot but drops them.
          this.controller?.abort();
          return;
        }
        boots.set(id, pid);
      }
      await delay(2500, undefined, { signal });
    }
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
    const env = createBackendChildEnv();
    this.set({ phase: "starting" });
    const { installer } = await deviceToolchains();
    if (liveViewSupport(process.platform, process.arch, installer) !== "available")
      throw new Error("The Device tab needs the local Apple silicon runtime.");
    signal.throwIfAborted();
    const run = await prepareDirectories(base);
    const installed = await installPath(base);
    if (!(await validInstall(installed))) {
      this.set({ phase: "installing" });
      await installHub(base, installed, env, signal);
      this.set({ phase: "starting" });
    }

    await withOwnedDirectory(run, "", async (directory) => {
      const stateDirectory = join(directory, "state");
      const simDirectory = join(directory, "serve-sim");
      const stop = new AbortController();
      const processSignal = AbortSignal.any([signal, stop.signal]);
      await Promise.all([
        mkdir(stateDirectory, { mode: 0o700 }),
        mkdir(simDirectory, { mode: 0o700 }),
      ]);
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
        {
          ...simulatorEnv(env),
          EXPO_DEVICE_HUB_STATE_DIR: stateDirectory,
          SERVE_SIM_STATE_DIR: simDirectory,
        },
        processSignal,
        { directory }
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
        await Promise.race([hub.closed, this.watchBoots(processSignal)]);
        throw new Error("The device service exited.");
      } catch (error) {
        stop.signal.throwIfAborted();
        throw error;
      } finally {
        clearTimeout(timeout);
        this.endpoint = null;
        stop.abort();
        await hub.closed.catch(() => {});
      }
    });
  }
}
