import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { StreamManager } from "../src/server/stream.js";

function buildStub(ignoreSigterm: boolean): string {
  const handler = ignoreSigterm ? '\nprocess.on("SIGTERM", () => {});' : "";
  return `#!/usr/bin/env node
const http = require("node:http");
let port = 0;
for (let i = 0; i < process.argv.length; i++) {
  if (process.argv[i] === "--port") port = parseInt(process.argv[i + 1], 10);
}
const server = http.createServer((req, res) => {
  const u = req.url || "";
  if (u.startsWith("/config")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ width: 1170, height: 2532 }));
  } else {
    res.writeHead(404);
    res.end();
  }
});${handler}
server.listen(port, "127.0.0.1");
`;
}

const CLEANUP: string[] = [];
let ignoringStubPath: string;
let cooperativeStubPath: string;

async function writeStub(dir: string, name: string, content: string): Promise<string> {
  const file = path.join(dir, name);
  await writeFile(file, content, { mode: 0o755 });
  await chmod(file, 0o755);
  return file;
}

beforeAll(async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "device-use-stream-test-"));
  CLEANUP.push(dir);
  ignoringStubPath = await writeStub(dir, "ignoring-simbridge.js", buildStub(true));
  cooperativeStubPath = await writeStub(dir, "cooperative-simbridge.js", buildStub(false));
});

afterAll(async () => {
  for (const dir of CLEANUP) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

const UPPER_BOUND_MS = 4000;
const LOWER_BOUND_MS = 1700;

describe("StreamManager.stop() SIGKILL escalation", () => {
  test("kills a SIGTERM-ignoring child within the 2s watchdog (regression for dead guard)", async () => {
    const stream = new StreamManager(ignoringStubPath);
    await stream.start("SIM-A");

    const t0 = Date.now();
    await stream.stop();
    const elapsed = Date.now() - t0;

    expect(elapsed).toBeGreaterThanOrEqual(LOWER_BOUND_MS);
    expect(elapsed).toBeLessThan(UPPER_BOUND_MS);
    expect(stream.getInfo()).toBeUndefined();
  });

  test("returns promptly when the child honors SIGTERM (no regression)", async () => {
    const stream = new StreamManager(cooperativeStubPath);
    await stream.start("SIM-A");

    const t0 = Date.now();
    await stream.stop();
    const elapsed = Date.now() - t0;

    expect(elapsed).toBeLessThan(1500);
    expect(stream.getInfo()).toBeUndefined();
  });

  test("bounds a cross-simulator switch against a SIGTERM-ignoring child", async () => {
    const stream = new StreamManager(ignoringStubPath);
    await stream.start("SIM-A");

    const t0 = Date.now();
    const info = await stream.start("SIM-B");
    const elapsed = Date.now() - t0;

    expect(info.udid).toBe("SIM-B");
    expect(typeof info.port).toBe("number");
    expect(info.port).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(UPPER_BOUND_MS + 1000);

    await stream.stop();
  });
});
