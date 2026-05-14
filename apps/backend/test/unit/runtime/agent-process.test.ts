import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  startManagedAgentServer,
  stopManagedAgentServer,
} from "../../../src/runtime/agent-process";

const tempRoots: string[] = [];
const originalEnv = { ...process.env };
const originalCwd = process.cwd();

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
  process.chdir(originalCwd);
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

  it("starts agent-server through deus-runtime without Electron-as-Node", async () => {
    const root = createTempRoot();
    const runtimePath = path.join(root, "bin", "deus-runtime");
    const argsPath = path.join(root, "args.txt");
    const cwdPath = path.join(root, "cwd.txt");
    const electronRunAsNodePath = path.join(root, "electron-run-as-node.txt");
    mkdirSync(path.dirname(runtimePath), { recursive: true });
    writeExecutable(
      runtimePath,
      [
        "#!/bin/sh",
        `printf '%s\\n' "$1" > ${JSON.stringify(argsPath)}`,
        `pwd > ${JSON.stringify(cwdPath)}`,
        `printf '%s\\n' "$ELECTRON_RUN_AS_NODE" > ${JSON.stringify(electronRunAsNodePath)}`,
        "echo 'LISTEN_URL=ws://127.0.0.1:7890'",
        "while true; do sleep 1; done",
      ].join("\n")
    );

    process.chdir(root);
    process.env.DEUS_RUNTIME_EXECUTABLE = runtimePath;
    process.env.AGENT_SERVER_CWD = path.join(root, "leaked-dev-agent-server-cwd");
    process.env.ELECTRON_RUN_AS_NODE = "1";

    await expect(startManagedAgentServer()).resolves.toBe("ws://127.0.0.1:7890");
    expect(readFileSync(argsPath, "utf8").trim()).toBe("agent-server");
    expect(readFileSync(cwdPath, "utf8").trim()).toBe(root);
    expect(readFileSync(electronRunAsNodePath, "utf8").trim()).toBe("");
  });

  it("fails before spawning when deus-runtime is not executable", async () => {
    const root = createTempRoot();
    const runtimePath = path.join(root, "bin", "deus-runtime");
    mkdirSync(path.dirname(runtimePath), { recursive: true });
    writeFileSync(runtimePath, "");
    if (process.platform !== "win32") chmodSync(runtimePath, 0o644);
    process.env.DEUS_RUNTIME_EXECUTABLE = runtimePath;

    await expect(startManagedAgentServer()).rejects.toThrow(
      /deus-runtime executable is missing or not executable/
    );
  });

  it("fails before spawning when deus-runtime points at a directory", async () => {
    const root = createTempRoot();
    const runtimePath = path.join(root, "bin", "deus-runtime");
    mkdirSync(runtimePath, { recursive: true });
    if (process.platform !== "win32") chmodSync(runtimePath, 0o755);
    process.env.DEUS_RUNTIME_EXECUTABLE = runtimePath;

    await expect(startManagedAgentServer()).rejects.toThrow(
      /deus-runtime executable is missing or not executable/
    );
  });

  it("refuses packaged agent-server fallback without deus-runtime", async () => {
    const root = createTempRoot();
    const entry = path.join(root, "agent.cjs");
    writeExecutable(
      entry,
      ["console.log('LISTEN_URL=ws://127.0.0.1:4567');", "setInterval(() => {}, 1000);"].join("\n")
    );

    process.env.DEUS_PACKAGED = "1";
    process.env.AGENT_SERVER_ENTRY = entry;
    process.env.AGENT_SERVER_CWD = root;
    process.env.ELECTRON_RUN_AS_NODE = "1";

    await expect(startManagedAgentServer()).rejects.toThrow(
      /Packaged backend requires DEUS_RUNTIME_EXECUTABLE/
    );
  });

  it("does not infer the obsolete packaged CJS entry from a bundled bin dir", async () => {
    const root = createTempRoot();
    const binDir = path.join(root, "bin");
    mkdirSync(binDir, { recursive: true });
    writeExecutable(
      path.join(binDir, "index.bundled.cjs"),
      ["console.log('LISTEN_URL=ws://127.0.0.1:4567');", "setInterval(() => {}, 1000);"].join(
        "\n"
      )
    );

    process.chdir(root);
    process.env.DEUS_BUNDLED_BIN_DIR = binDir;

    await expect(startManagedAgentServer()).rejects.toThrow(/Agent-server entry not found/);
  });
});
