import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  startManagedAgentServer,
  stopManagedAgentServer,
} from "../../../src/runtime/agent-process";

const tempRoots: string[] = [];
const originalEnv = { ...process.env };

function createTempRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "deus-agent-process-"));
  tempRoots.push(root);
  return root;
}

function writeExecutable(filePath: string, contents: string): void {
  writeFileSync(filePath, contents);
  chmodSync(filePath, 0o755);
}

afterEach(async () => {
  await stopManagedAgentServer();
  process.env = { ...originalEnv };
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("managed agent-server process", () => {
  it("starts an agent-server child and resolves its LISTEN_URL", async () => {
    const root = createTempRoot();
    const entry = path.join(root, "agent.cjs");
    writeExecutable(
      entry,
      ["console.log('LISTEN_URL=ws://127.0.0.1:4567');", "setInterval(() => {}, 1000);"].join("\n")
    );

    process.env.AGENT_SERVER_ENTRY = entry;
    process.env.AGENT_SERVER_CWD = root;

    await expect(startManagedAgentServer()).resolves.toBe("ws://127.0.0.1:4567");
  });

  it("fails loudly when the configured agent-server entry is missing", async () => {
    process.env.AGENT_SERVER_ENTRY = path.join(createTempRoot(), "missing.cjs");

    await expect(startManagedAgentServer()).rejects.toThrow(/Agent-server entry not found/);
  });
});
