import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeviceHub, hubVersion } from "../../../src/services/device-hub/manager";
import type { HubStatus } from "@shared/types/device-hub";

vi.mock("../../../src/services/device-hub/prepare", () => ({ prepareHub: vi.fn() }));
vi.mock("device-use/engine", () => ({ simulatorEnv: (env: NodeJS.ProcessEnv) => env }));

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
  fs.writeFileSync("node_modules/expo-device-hub/dist/server/cli.mjs", "");
  process.exit(process.env.FIXTURE_OFFLINE ? 1 : 0);
}
if (!process.argv.includes("--require-token")) process.exit(22);
process.on("SIGTERM", () => { if (!process.env.FIXTURE_STUCK) process.exit(0); });
fs.writeFileSync("pid", String(process.pid));
fs.writeFileSync(3, JSON.stringify({ port: 19821, token: "x".repeat(43) }) + "\\n");
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
    // A stock or interrupted installation at this version cannot perform the private handshake.
    const unprepared = join(installed(), "node_modules/expo-device-hub/dist/server");
    await mkdir(unprepared, { recursive: true });
    await writeFile(join(unprepared, "cli.mjs"), "");
    vi.stubEnv("FIXTURE_OFFLINE", "");
    hub.retry();
    await wait("ready");
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
