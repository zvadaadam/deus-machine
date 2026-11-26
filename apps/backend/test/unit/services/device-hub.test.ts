import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hubVersion } from "../../../src/services/device-hub/support";
import { DeviceHub } from "../../../src/services/device-hub/manager";
import type { HubStatus } from "@shared/types/device-hub";

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

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "deus-hub-test-"));
    phases = [];
    const runtime = join(directory, "runtime");
    await writeFile(
      runtime,
      `#!/usr/bin/env node
const fs = require("node:fs");
if (process.env.BUN_BE_BUN !== "1") process.exit(20);
if (process.argv[2] === "install") {
  if (!process.argv.includes("--frozen-lockfile") || !fs.existsSync("bun.lock")) process.exit(21);
  fs.mkdirSync("node_modules/expo-device-hub/dist/server", { recursive: true });
  fs.writeFileSync("node_modules/expo-device-hub/package.json", JSON.stringify({version: "${hubVersion}"}));
  fs.writeFileSync("node_modules/expo-device-hub/dist/server/cli.mjs", "");
  if (process.env.FIXTURE_OFFLINE) console.error("Could not download package\\nregistry connection timed out");
  process.exit(process.env.FIXTURE_OFFLINE ? 1 : 0);
}
const directory = process.env.EXPO_DEVICE_HUB_STATE_DIR;
if (!process.argv.includes("--require-token") || process.argv[process.argv.indexOf("--host") + 1] !== "127.0.0.1") process.exit(22);
if ((fs.statSync(directory).mode & 0o777) !== 0o700 || (fs.statSync(process.env.SERVE_SIM_STATE_DIR).mode & 0o777) !== 0o700 || fs.readdirSync(directory).length) process.exit(23);
process.on("SIGTERM", () => { if (!process.env.FIXTURE_STUCK) process.exit(0); });
fs.writeFileSync("pid", String(process.pid));
if (process.env.FIXTURE_MONITOR) require("node:child_process").spawn(process.execPath, ["-e",
  'process.on("SIGTERM", () => {}); require("node:fs").writeFileSync("monitor", String(process.pid)); setInterval(()=>{}, 1000);'
], {stdio:"ignore"});
function publish(port, pid) {
  fs.writeFileSync(directory + "/server-" + port + ".json", JSON.stringify({pid, port, url:"http://127.0.0.1:" + port, token: "x".repeat(43)}), {mode:0o600});
}
publish(19820, process.pid + 1);
if (!process.env.FIXTURE_NO_DISCOVERY) publish(19821, process.pid);
setInterval(() => {}, 1000);
`
    );
    await chmod(runtime, 0o755);
    vi.stubEnv("DEUS_RUNTIME_EXECUTABLE", runtime);
    hub = new DeviceHub({
      directory: join(directory, "hub"),
      idleMs: 80,
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
  const view = { workspaceId: "w", deviceId: null, platform: null };
  const installed = () => join(directory, "hub", hubVersion);

  it("installs once, shares one process, and reuses it across a brief disconnect", async () => {
    const leave = hub.follow(view);
    const leaveSecond = hub.follow(view);
    await wait("ready");
    const pid = await readFile(join(installed(), "pid"), "utf8");
    expect(phases.filter((s) => s.phase === "installing")).toHaveLength(1);
    expect(JSON.stringify(phases)).not.toContain("token");
    expect(hub.endpoint?.origin).toBe("http://127.0.0.1:19821");
    expect((await stat(join(directory, "hub/state/server-19821.json"))).mode & 0o777).toBe(0o600);
    leave();
    leaveSecond();
    const reopen = hub.follow(view);
    expect(await readFile(join(installed(), "pid"), "utf8")).toBe(pid);
    reopen();
    await wait("idle");
    expect(hub.endpoint).toBeNull();
    hub.follow(view);
    await wait("ready");
    expect(phases.filter((s) => s.phase === "installing")).toHaveLength(1);
    expect(await readFile(join(installed(), "pid"), "utf8")).not.toBe(pid);
  });

  it("names the most recently shown device and releases it when the viewer disconnects", async () => {
    const leaveiOS = hub.follow({ workspaceId: "w", platform: "ios", deviceId: "A0-B0" });
    await wait("ready");
    const leaveAndroid = hub.follow({
      workspaceId: "w",
      platform: "android",
      deviceId: "emulator-5556",
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
    expect(await readdir(join(directory, "hub"))).toEqual([]);
    expect(hub.status).toEqual({
      phase: "error",
      message: "Devices could not be set up.",
      detail: "Could not download package\nregistry connection timed out",
    });
    const wrongPackage = join(installed(), "node_modules/expo-device-hub");
    await mkdir(wrongPackage, { recursive: true });
    await writeFile(join(wrongPackage, "package.json"), JSON.stringify({ version: "0.25.0" }));
    await mkdir(join(directory, "hub/state"), { recursive: true });
    await writeFile(join(directory, "hub/state/stale-file"), "stale");

    vi.stubEnv("FIXTURE_OFFLINE", "");
    hub.retry();
    await wait("ready");
  });

  it("keeps a different process's discovery private and cancels a start still waiting for its child", async () => {
    vi.stubEnv("FIXTURE_NO_DISCOVERY", "1");
    hub.follow(view);
    await vi.waitFor(
      async () => {
        await stat(join(directory, "hub/state/server-19820.json"));
      },
      { timeout: 5000 }
    );
    expect(hub.endpoint).toBeNull();
    await hub.shutdown();
    expect(hub.status.phase).toBe("idle");
  });

  it("reconnects the shown device after a new boot", async () => {
    bootIdentity.mockResolvedValueOnce(123).mockResolvedValue(456);
    const scope = { workspaceId: "w", platform: "ios", deviceId: "A0-B0" } as const;
    hub.follow(scope);
    await wait("ready");
    const first = hub.status;
    await vi.waitFor(
      () => {
        expect(hub.status.phase).toBe("ready");
        expect(hub.status).not.toEqual(first);
      },
      { timeout: 7000 }
    );
    expect(hub.displayedDevice("w")).toEqual({ platform: "ios", id: "A0-B0" });
  }, 10000);

  it("stops a stubborn monitor after the hub's group leader exits", async () => {
    vi.stubEnv("FIXTURE_MONITOR", "1");
    hub.follow(view);
    await wait("ready");
    const pid = Number(await vi.waitFor(() => readFile(join(installed(), "monitor"), "utf8")));
    const leader = Number(await readFile(join(installed(), "pid"), "utf8"));
    process.kill(leader, "SIGTERM");
    await wait("error");
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
  });

  it("reaps a hub that ignores SIGTERM before shutdown returns", async () => {
    vi.stubEnv("FIXTURE_STUCK", "1");
    hub.follow(view);
    await wait("ready");
    const pid = Number(await readFile(join(installed(), "pid"), "utf8"));
    await hub.shutdown();
    expect(() => process.kill(pid, 0)).toThrow();
    expect(hub.endpoint).toBeNull();
  });
});
