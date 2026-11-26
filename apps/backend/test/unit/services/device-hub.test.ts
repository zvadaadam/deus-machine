import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hubManifest, hubVersion } from "../../../src/services/device-hub/support";
import { cliPath, installPath } from "../../../src/services/device-hub/storage";
import { DeviceHub } from "../../../src/services/device-hub/manager";
import type { DeviceSetup, HubStatus } from "@shared/types/device-hub";

vi.mock("../../../src/services/device-hub/support", async (original) => ({
  ...(await original<typeof import("../../../src/services/device-hub/support")>()),
  deviceToolchains: async () => ({ installer: true }),
  liveViewSupport: () => "available",
}));
const { bootIdentity } = vi.hoisted(() => ({ bootIdentity: vi.fn(async () => 123) }));
vi.mock("../../../src/services/device-hub/simctl", () => ({ bootIdentity }));

describe("Device Hub lifecycle", () => {
  let directory: string;
  let hub: DeviceHub;
  let phases: HubStatus[];
  let setupChanges: DeviceSetup[];
  let installed: string;
  let base: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "deus-hub-test-"));
    phases = [];
    setupChanges = [];
    base = join(directory, "hub");
    installed = await installPath(base);
    vi.stubEnv(
      "DEUS_RUNTIME_EXECUTABLE",
      join(import.meta.dirname, "../../fixtures/device-hub-runtime.mjs")
    );
    hub = new DeviceHub({
      directory: base,
      idleMs: 80,
      setupChanged: () => setupChanges.push(hub.setupState()),
      changed: (s) => phases.push(s),
    });
  });
  afterEach(async () => {
    await hub.shutdown();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });
  const wait = (phase: HubStatus["phase"]) =>
    vi.waitFor(() => expect(hub.status.phase).toBe(phase), { timeout: 5000 });
  const view = { workspaceId: "w", deviceId: null, platform: null, displayedInstance: null };
  const runDir = async () => join(base, "run", (await readdir(join(base, "run")))[0]!);
  const state = async (file: string) => join(await runDir(), "state", file);
  const instance = () => {
    if (hub.status.phase !== "ready") throw new Error("Hub is not ready");
    return hub.status.instance;
  };

  it("installs once, shares one process, and reuses it across a brief disconnect", async () => {
    await hub.initializeSetup();
    expect(setupChanges).toEqual([{ setup: "new", error: null }]);
    expect(hub.status.phase).toBe("idle");
    const leave = hub.follow(view);
    const leaveSecond = hub.follow(view);
    await wait("ready");
    const pid = await readFile(await state("pid"), "utf8");
    expect([...new Set(setupChanges.map((state) => state.setup))]).toEqual([
      "new",
      "working",
      "ready",
    ]);
    expect(phases.filter((s) => s.phase === "installing")).toHaveLength(1);
    expect(JSON.stringify(phases)).not.toContain("token");
    const { hostname, port } = new URL(hub.endpoint!.origin);
    expect(hostname).toBe("127.0.0.1");
    expect(port).not.toBe("1");
    expect((await stat(await state(`server-${port}.json`))).mode & 0o777).toBe(0o600);
    leave();
    leaveSecond();
    const reopen = hub.follow(view);
    expect(await readFile(await state("pid"), "utf8")).toBe(pid);
    setupChanges.length = 0;
    reopen();
    await wait("idle");
    expect(setupChanges).toEqual([{ setup: "ready", error: null }]);
    expect(hub.endpoint).toBeNull();
    expect(await readdir(join(base, "run"))).toEqual([]);
    hub.follow(view);
    await wait("ready");
    expect(phases.filter((s) => s.phase === "installing")).toHaveLength(1);
    expect(await readFile(await state("pid"), "utf8")).not.toBe(pid);
  });

  it("names the most recently shown device and releases it when the viewer disconnects", async () => {
    hub.follow(view);
    await wait("ready");
    const leaveiOS = hub.follow({
      ...view,
      platform: "ios",
      deviceId: "A0-B0",
      displayedInstance: instance(),
    });
    const leaveAndroid = hub.follow({
      workspaceId: "w",
      platform: "android",
      deviceId: "emulator-5556",
      displayedInstance: instance(),
    });
    expect(hub.displayedDevice("w")).toEqual({ platform: "android", id: "emulator-5556" });
    expect(hub.displayedDevice("other")).toBeNull();
    leaveAndroid();
    expect(hub.displayedDevice("w")).toEqual({ platform: "ios", id: "A0-B0" });
    leaveiOS();
    expect(hub.displayedDevice("w")).toBeNull();
  });

  it("discards a failed staging install and lets a follower retry", async () => {
    vi.stubEnv("FIXTURE_OFFLINE", "1");
    hub.follow(view);
    await wait("error");
    expect((await readdir(base)).sort()).toEqual(["install-count", "run"]);
    expect(hub.status).toEqual({
      phase: "error",
      message: "Devices could not be set up.",
      detail: "Could not download package\nregistry connection timed out",
    });
    expect(setupChanges.at(-1)).toEqual({
      setup: "failed",
      error: "Could not download package\nregistry connection timed out",
    });
    const wrongPackage = join(installed, "node_modules/expo-device-hub");
    await mkdir(wrongPackage, { recursive: true });
    await writeFile(join(wrongPackage, "package.json"), JSON.stringify({ version: "0.25.0" }));

    vi.stubEnv("FIXTURE_OFFLINE", "");
    hub.retry();
    await wait("ready");
  });

  it("reinstalls on Retry when a launch lost its entry point", async () => {
    vi.stubEnv("FIXTURE_BROKEN", "1");
    hub.follow(view);
    await wait("error");
    await expect(stat(join(installed, cliPath))).rejects.toMatchObject({ code: "ENOENT" });
    expect(hub.setupState()).toEqual({ setup: "failed", error: expect.any(String) });
    vi.stubEnv("FIXTURE_BROKEN", "");
    hub.retry();
    await wait("ready");
    expect(await readFile(join(base, "install-count"), "utf8")).toBe("11");
  });

  it("uses the canonical database's installation for aliases and isolates sibling databases", async () => {
    const file = join(directory, "first.db");
    const alias = join(directory, "link.db");
    await writeFile(file, "");
    await symlink(file, alias);
    const cache = await installPath(file + ".device-hub");
    const pkg = join(cache, "node_modules/expo-device-hub");
    await mkdir(join(pkg, "dist/server"), { recursive: true });
    await writeFile(join(pkg, "package.json"), JSON.stringify({ version: hubVersion }));
    await writeFile(join(cache, cliPath), "");
    for (const [path, expected] of [
      [alias, "ready"],
      [join(directory, "second.db"), "new"],
    ] as const) {
      vi.stubEnv("DATABASE_PATH", path);
      vi.resetModules();
      const { initDatabase, closeDatabase } = await import("../../../src/lib/database");
      const { deviceHub } = await import("../../../src/services/device-hub");
      initDatabase();
      try {
        if (path === alias) {
          await unlink(alias);
          await writeFile(alias, "");
        }
        await deviceHub.initializeSetup();
        expect(deviceHub.setupState()).toEqual({ setup: expected, error: null });
      } finally {
        closeDatabase();
      }
    }
  });

  it("keeps both frozen installs when a release changes only its lockfile", async () => {
    const leave = hub.follow(view);
    await wait("ready");
    leave();
    await wait("idle");
    const original = hubManifest();
    vi.stubEnv("DEUS_RESOURCES_PATH", directory);
    const manifest = hubManifest();
    await mkdir(manifest, { recursive: true });
    for (const file of ["package.json", "bun.lock"]) {
      const contents = await readFile(join(original, file), "utf8");
      await writeFile(join(manifest, file), contents + "\n");
    }
    const other = await installPath(base);
    expect(other).not.toBe(installed);
    hub = new DeviceHub({ directory: base, changed: () => {}, setupChanged: () => {} });
    await hub.initializeSetup();
    expect(hub.setupState().setup).toBe("new");
    hub.follow(view);
    await wait("ready");
    for (const path of [installed, other])
      expect((await stat(join(path, cliPath))).isFile()).toBe(true);
  });

  it("removes stale runs and staging while leaving an unrelated process group alive", async () => {
    const runs = join(base, "run");
    const leftover = join(runs, "previous");
    await mkdir(leftover, { recursive: true });
    await mkdir(join(runs, "partial"));
    await mkdir(join(base, ".install-partial"));
    const sleep = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
    const exited = once(sleep, "exit");
    try {
      await once(sleep, "spawn");
      const group = sleep.pid!;
      await writeFile(join(leftover, "group.pid"), String(group));
      const signal = vi.spyOn(process, "kill");
      hub.follow(view);
      await wait("ready");
      const remaining = await readdir(runs);
      expect(remaining).not.toContain("previous");
      expect(remaining).not.toContain("partial");
      expect((await readdir(base)).filter((name) => name.startsWith(".install-"))).toEqual([]);
      expect(sleep.kill(0)).toBe(true);
      expect(signal).not.toHaveBeenCalledWith(-group, expect.anything());
    } finally {
      sleep.kill("SIGKILL");
      await exited;
    }
  });

  it("keeps a different process's discovery private and cancels a start still waiting for its child", async () => {
    vi.stubEnv("FIXTURE_NO_DISCOVERY", "1");
    hub.follow(view);
    await vi.waitFor(
      async () => {
        await stat(await state("server-1.json"));
      },
      { timeout: 5000 }
    );
    expect(hub.endpoint).toBeNull();
    await hub.shutdown();
    expect(hub.status.phase).toBe("idle");
  });

  it("reconnects the shown device after a new boot", async () => {
    bootIdentity.mockResolvedValueOnce(123).mockResolvedValue(456);
    const scope = {
      displayedInstance: null,
      workspaceId: "w",
      platform: "ios",
      deviceId: "A0-B0",
    } as const;
    hub.follow(scope);
    await wait("ready");
    const first = hub.status;
    hub.follow({ ...scope, displayedInstance: instance() });
    await vi.waitFor(
      () => {
        expect(hub.status.phase).toBe("ready");
        expect(hub.status).not.toEqual(first);
      },
      { timeout: 7000 }
    );
    expect(hub.displayedDevice("w")).toBeNull();
    hub.follow({ ...scope, displayedInstance: instance() });
    expect(hub.displayedDevice("w")).toEqual({ platform: "ios", id: "A0-B0" });
  }, 10000);

  it("stops a stubborn monitor after the hub's group leader exits", async () => {
    vi.stubEnv("FIXTURE_MONITOR", "1");
    hub.follow(view);
    await wait("ready");
    const pid = Number(await vi.waitFor(async () => readFile(await state("monitor"), "utf8")));
    const leader = Number(await readFile(await state("pid"), "utf8"));
    process.kill(leader, "SIGTERM");
    await wait("error");
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
  });

  it("keeps running when macOS refuses to signal part of the hub's group", async () => {
    // macOS signals the group members it may and still answers EPERM for the rest.
    const kill = process.kill.bind(process);
    const refused = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      const sent = kill(pid, signal);
      if (pid < 0 && signal !== 0) {
        throw Object.assign(new Error("kill EPERM"), { code: "EPERM", syscall: "kill" });
      }
      return sent;
    });
    try {
      const release = hub.follow(view);
      await wait("ready");
      release();
      await wait("idle");
    } finally {
      refused.mockRestore();
    }
  });

  it("reaps a hub that ignores SIGTERM before shutdown returns", async () => {
    vi.stubEnv("FIXTURE_STUCK", "1");
    hub.follow(view);
    await wait("ready");
    const pid = Number(await readFile(await state("pid"), "utf8"));
    await hub.shutdown();
    expect(() => process.kill(pid, 0)).toThrow();
    expect(hub.endpoint).toBeNull();
  });
});
