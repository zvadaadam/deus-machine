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
    const envPath = path.join(root, "env.txt");
    const envFormat =
      [
        "AUTH_TOKEN=%s",
        "DATABASE_PATH=%s",
        "DEUS_AUTH_TOKEN=%s",
        "DEUS_BUNDLED_BIN_DIR=%s",
        "DEUS_BACKEND_PORT=%s",
        "DEUS_DATA_DIR=%s",
        "DEUS_PACKAGED=%s",
        "DEUS_RESOURCES_PATH=%s",
        "ELECTRON_RUN_AS_NODE=%s",
        "AGENT_SERVER_CWD=%s",
        "DEUS_RUNTIME=%s",
        "DEUS_RUNTIME_COMMAND=%s",
        "DEUS_RUNTIME_EXECUTABLE=%s",
        "NODE_PATH=%s",
        "PORT=%s",
        "",
      ].join("\\n") + "\\n";
    const envArgs = [
      "$AUTH_TOKEN",
      "$DATABASE_PATH",
      "$DEUS_AUTH_TOKEN",
      "$DEUS_BUNDLED_BIN_DIR",
      "$DEUS_BACKEND_PORT",
      "$DEUS_DATA_DIR",
      "$DEUS_PACKAGED",
      "$DEUS_RESOURCES_PATH",
      "$ELECTRON_RUN_AS_NODE",
      "$AGENT_SERVER_CWD",
      "$DEUS_RUNTIME",
      "$DEUS_RUNTIME_COMMAND",
      "$DEUS_RUNTIME_EXECUTABLE",
      "$NODE_PATH",
      "$PORT",
    ]
      .map(JSON.stringify)
      .join(" ");
    mkdirSync(path.dirname(runtimePath), { recursive: true });
    writeExecutable(
      runtimePath,
      [
        "#!/bin/sh",
        `printf '%s\\n' "$1" > ${JSON.stringify(argsPath)}`,
        `pwd > ${JSON.stringify(cwdPath)}`,
        `printf ${JSON.stringify(envFormat)} ${envArgs} > ${JSON.stringify(envPath)}`,
        "echo 'LISTEN_URL=ws://127.0.0.1:7890'",
        "while true; do sleep 1; done",
      ].join("\n")
    );

    process.chdir(root);
    process.env.DEUS_RUNTIME_EXECUTABLE = runtimePath;
    process.env.AGENT_SERVER_CWD = path.join(root, "leaked-dev-agent-server-cwd");
    process.env.ELECTRON_RUN_AS_NODE = "1";
    process.env.DEUS_RUNTIME = "1";
    process.env.DEUS_RUNTIME_COMMAND = "backend";
    process.env.NODE_PATH = "/tmp/stale-node-modules";
    process.env.AUTH_TOKEN = "backend-auth-token";
    process.env.DATABASE_PATH = path.join(root, "backend.db");
    process.env.DEUS_AUTH_TOKEN = "desktop-main-auth-token";
    process.env.DEUS_BUNDLED_BIN_DIR = path.join(root, "stale-bin");
    process.env.DEUS_BACKEND_PORT = "45678";
    process.env.DEUS_DATA_DIR = path.join(root, "data");
    process.env.DEUS_PACKAGED = "1";
    process.env.DEUS_RESOURCES_PATH = path.join(root, "stale-resources");
    process.env.PORT = "45678";

    await expect(startManagedAgentServer()).resolves.toBe("ws://127.0.0.1:7890");
    expect(readFileSync(argsPath, "utf8").trim()).toBe("agent-server");
    expect(readFileSync(cwdPath, "utf8").trim()).toBe(root);
    expect(readFileSync(envPath, "utf8")).toBe(
      [
        "AUTH_TOKEN=",
        "DATABASE_PATH=",
        "DEUS_AUTH_TOKEN=",
        "DEUS_BUNDLED_BIN_DIR=",
        "DEUS_BACKEND_PORT=",
        "DEUS_DATA_DIR=",
        "DEUS_PACKAGED=",
        "DEUS_RESOURCES_PATH=",
        "ELECTRON_RUN_AS_NODE=",
        "AGENT_SERVER_CWD=",
        "DEUS_RUNTIME=",
        "DEUS_RUNTIME_COMMAND=",
        "DEUS_RUNTIME_EXECUTABLE=",
        "NODE_PATH=",
        "PORT=",
        "",
      ].join("\n")
    );
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
