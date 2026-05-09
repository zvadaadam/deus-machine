import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeSupervisor } from "../../../apps/runtime/supervisor";

const tempRoots: string[] = [];

function createTempRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "deus-runtime-supervisor-"));
  tempRoots.push(root);
  return root;
}

function writeExecutable(filePath: string, contents: string): void {
  writeFileSync(filePath, contents);
  chmodSync(filePath, 0o755);
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("RuntimeSupervisor", () => {
  it("starts agent-server then backend and returns connection details", async () => {
    const root = createTempRoot();
    const agentEntry = path.join(root, "agent.cjs");
    const backendEntry = path.join(root, "backend.cjs");

    writeExecutable(
      agentEntry,
      ["console.log('LISTEN_URL=ws://127.0.0.1:4567');", "setInterval(() => {}, 1000);"].join("\n")
    );
    writeExecutable(
      backendEntry,
      [
        "if (process.env.AGENT_SERVER_URL !== 'ws://127.0.0.1:4567') process.exit(2);",
        "console.log('[BACKEND_PORT]3456');",
        "setInterval(() => {}, 1000);",
      ].join("\n")
    );

    const supervisor = new RuntimeSupervisor({
      command: process.execPath,
      entries: {
        agentServerEntry: agentEntry,
        backendEntry,
        agentServerCwd: root,
        backendCwd: root,
      },
    });

    await expect(supervisor.start()).resolves.toEqual({
      agentServerUrl: "ws://127.0.0.1:4567",
      backendPort: 3456,
    });
    await supervisor.stop();
  });

  it("reports unexpected exits after startup", async () => {
    const root = createTempRoot();
    const agentEntry = path.join(root, "agent.cjs");
    const backendEntry = path.join(root, "backend.cjs");
    const onUnexpectedExit = vi.fn();

    writeExecutable(
      agentEntry,
      ["console.log('LISTEN_URL=ws://127.0.0.1:4567');", "setInterval(() => {}, 1000);"].join("\n")
    );
    writeExecutable(
      backendEntry,
      ["console.log('[BACKEND_PORT]3456');", "setTimeout(() => process.exit(7), 10);"].join("\n")
    );

    const supervisor = new RuntimeSupervisor({
      command: process.execPath,
      entries: {
        agentServerEntry: agentEntry,
        backendEntry,
        agentServerCwd: root,
        backendCwd: root,
      },
      hooks: { onUnexpectedExit },
    });

    await supervisor.start();
    await vi.waitFor(() => expect(onUnexpectedExit).toHaveBeenCalledWith("backend", 7, null));
    await supervisor.stop();
  });
});
