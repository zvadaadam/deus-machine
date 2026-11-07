import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { readManifest } from "../src/bundle/bundle.js";
import { startRecording } from "../src/recorder.js";
import { groupAlive, isAlive } from "../src/util/process.js";
import { tempDir } from "./helpers.js";

const exec = promisify(execFile);
const CLI = resolve(__dirname, "../src/cli/index.ts");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const HELP_COMMANDS = [
  "doctor",
  "sources",
  "start",
  "record",
  "status",
  "action",
  "chapter",
  "hold",
  "focus",
  "note",
  "stop",
  "render",
  "inspect",
  "import",
  "presets",
  "skill",
];

/** Each call is its own process, the way an agent uses the CLI. */
async function cli(...args: string[]): Promise<{ code: number; json: Record<string, any> }> {
  try {
    const { stdout } = await exec("bun", [CLI, ...args], { timeout: 60_000 });
    return { code: 0, json: JSON.parse(stdout.trim().split("\n").pop()!) };
  } catch (err) {
    const e = err as { code?: number; stdout?: string };
    return {
      code: e.code ?? 1,
      json: JSON.parse((e.stdout ?? "{}").trim().split("\n").pop() || "{}"),
    };
  }
}

describe("CLI", () => {
  it("start, annotate and stop from separate processes", async () => {
    const dir = join(tempDir(), "take");
    const started = await cli(
      "start",
      "--source",
      "test-pattern:320x240",
      "--out",
      dir,
      "--max-duration",
      "1m"
    );
    expect(started.code).toBe(0);
    expect(started.json).toMatchObject({ ok: true, status: "recording" });
    expect(started.json.next).toHaveLength(3);

    await sleep(500);
    expect((await cli("chapter", dir, "Sign", "in")).json.event).toMatchObject({
      kind: "chapter",
      title: "Sign in",
    });
    expect(
      (await cli("action", dir, "--type", "click", "--rect", "10,10,40,20", "--label", "Go")).json
        .ok
    ).toBe(true);
    expect(
      (await cli("focus", dir, "--rect", "100,100,80,60", "--for", "2s")).json.event.durationMs
    ).toBe(2000);
    expect((await cli("action", dir, "--type", "wave")).json.error.code).toBe("invalid_argument");
    expect((await cli("status", dir)).json.status).toBe("recording");

    const stopped = await cli("stop", dir);
    expect(stopped.json).toMatchObject({
      ok: true,
      status: "complete",
      stopReason: "requested",
      alreadyStopped: false,
    });
    expect(stopped.json.media.frames).toBeGreaterThan(10);
    expect((await cli("stop", dir)).json).toMatchObject({
      status: "complete",
      alreadyStopped: true,
    });
    expect((await cli("chapter", dir, "Late")).json.error.code).toBe("not_recording");

    const plan = await cli("render", dir, "--plan");
    expect(plan.json).toMatchObject({ ok: true, planned: true });
    // --render takes a value here, not a boolean.
    expect(
      (await cli("inspect", dir, "--contact-sheet", "--render", "nope")).json.error.message
    ).toBe('No render named "nope"');
  }, 120_000);

  it("recovers the media when the recorder is killed", async () => {
    const dir = join(tempDir(), "take");
    await cli("start", "--source", "test-pattern:320x240", "--out", dir);
    await sleep(2500);
    const owner = (await readManifest(dir)).capture.owner!;
    process.kill(owner.pid, "SIGKILL");
    await sleep(300);
    const stopped = await cli("stop", dir);
    expect(stopped.json).toMatchObject({
      status: "complete",
      recovered: true,
      stopReason: "owner-lost",
    });
    expect(stopped.json.media.durationMs).toBeGreaterThan(1000);
  }, 60_000);

  it("stops cleanly while the source is still starting", async () => {
    // A DevTools endpoint that takes 4 s to answer: start is mid-resolve when stop arrives.
    const server = createServer((_req, res) => setTimeout(() => res.end("[]"), 4000));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    const dir = join(tempDir(), "take");
    const starting = cli("start", "--source", `browser:http://127.0.0.1:${port}`, "--out", dir);
    await sleep(1500);
    const owner = (await readManifest(dir)).capture.owner!;
    expect(owner.kind).toBe("worker");
    const stopped = await cli("stop", dir);
    expect(stopped.json).toMatchObject({ status: "failed", error: { code: "aborted" } });
    expect((await starting).json.ok).toBe(false);
    await sleep(500);
    expect(isAlive(owner.pid)).toBe(false);
    expect(groupAlive(owner.pid)).toBe(false);
    server.close();
  }, 60_000);

  it("finalizes a foreground record stopped while its source is starting", async () => {
    const server = createServer((_req, res) => setTimeout(() => res.end("[]"), 4000));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    const dir = join(tempDir(), "take");
    const child = spawn(
      "bun",
      [CLI, "record", "--source", `browser:http://127.0.0.1:${port}`, "--out", dir],
      {
        stdio: ["ignore", "pipe", "ignore"],
      }
    );
    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    await sleep(1500);
    child.kill("SIGTERM"); // as a supervisor would
    await new Promise((r) => child.once("close", r));
    expect(JSON.parse(stdout.trim().split("\n").pop()!)).toMatchObject({
      ok: false,
      error: { code: "aborted" },
    });
    expect((await readManifest(dir)).status).toBe("failed");
    server.close();
  }, 60_000);

  it("refuses to signal an app that records in-process", async () => {
    const dir = join(tempDir(), "take");
    const recording = await startRecording({ source: "test-pattern:320x240", out: dir });
    const stopped = await cli("stop", dir);
    expect(stopped.json.error).toMatchObject({ code: "invalid_argument" });
    expect(recording.isRecording).toBe(true);
    expect((await recording.stop()).status).toBe("complete");
  }, 60_000);

  it("prints the agent skill", async () => {
    const { stdout } = await exec("bun", [CLI, "skill"], { timeout: 60_000 });
    expect(stdout).toMatch(/^---\nname: screen-studio\ndescription: /);
    // Every command the skill teaches exists.
    for (const command of stdout.matchAll(/^screen-studio (\w+)/gm)) {
      expect(HELP_COMMANDS).toContain(command[1]);
    }
  });

  it("reports bad input as structured errors", async () => {
    const bad = await cli("start", "--source", "webcam", "--out", join(tempDir(), "x"));
    expect(bad.code).not.toBe(0);
    expect(bad.json).toMatchObject({
      ok: false,
      error: { code: "invalid_argument", hint: expect.stringContaining("sources") },
    });
    expect((await cli("status", join(tempDir(), "missing"))).json.error.code).toBe(
      "bundle_not_found"
    );
  });
});
