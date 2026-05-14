import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const { mockApp, mockBrowserWindow, mockSpawn } = vi.hoisted(() => ({
  mockApp: {
    isPackaged: true,
    getPath: vi.fn((name: string) =>
      name === "userData" ? "/Users/test/Library/Application Support/Deus" : "/tmp"
    ),
  },
  mockBrowserWindow: {
    getAllWindows: vi.fn(() => []),
  },
  mockSpawn: vi.fn(),
}));

vi.mock("electron", () => ({
  app: mockApp,
  BrowserWindow: mockBrowserWindow,
}));

vi.mock("child_process", () => ({
  spawn: mockSpawn,
}));

import { CDP_PORT, spawnBackend, stopBackend } from "../../../apps/desktop/main/backend-process";

const originalEnv = { ...process.env };
const originalPlatform = process.platform;
const originalResourcesPath = (process as { resourcesPath?: string }).resourcesPath;
const tempRoots: string[] = [];

function createTempResourcesRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "deus-desktop-backend-"));
  tempRoots.push(root);
  const resourcesPath = path.join(root, "Resources");
  mkdirSync(path.join(resourcesPath, "bin"), { recursive: true });
  return resourcesPath;
}

function createRuntimeExecutable(resourcesPath: string): string {
  const runtimePath = path.join(resourcesPath, "bin", "deus-runtime");
  writeFileSync(runtimePath, "#!/bin/sh\n");
  chmodSync(runtimePath, 0o755);
  return runtimePath;
}

function createFakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = vi.fn((signal: NodeJS.Signals = "SIGTERM") => {
    child.signalCode = signal;
    child.emit("exit", null, signal);
    return true;
  });
  return child;
}

afterEach(() => {
  stopBackend();
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
  mockSpawn.mockReset();
  mockApp.isPackaged = true;
  mockApp.getPath.mockClear();
  mockBrowserWindow.getAllWindows.mockClear();
  process.env = { ...originalEnv };
  Object.defineProperty(process, "platform", {
    configurable: true,
    enumerable: true,
    value: originalPlatform,
  });
  if (originalResourcesPath === undefined) {
    delete (process as { resourcesPath?: string }).resourcesPath;
  } else {
    (process as { resourcesPath?: string }).resourcesPath = originalResourcesPath;
  }
});

describe("desktop backend process", () => {
  it("starts packaged backend through bundled deus-runtime without Electron-as-Node", async () => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      enumerable: true,
      value: "darwin",
    });
    const resourcesPath = createTempResourcesRoot();
    const runtimePath = createRuntimeExecutable(resourcesPath);
    (process as { resourcesPath?: string }).resourcesPath = resourcesPath;
    process.env.PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin";
    process.env.ELECTRON_RUN_AS_NODE = "1";
    process.env.AGENT_SERVER_ENTRY = "/tmp/dev-agent-server.cjs";
    process.env.AGENT_SERVER_CWD = "/tmp/dev-agent-server";
    process.env.AUTH_TOKEN = "stale-auth-token";
    process.env.DATABASE_PATH = "/tmp/stale.db";
    process.env.DEUS_AUTH_TOKEN = "stale-main-auth-token";
    process.env.DEUS_BUNDLED_BIN_DIR = "/tmp/stale-bin";
    process.env.DEUS_BACKEND_PORT = "45678";
    process.env.DEUS_DATA_DIR = "/tmp/stale-data";
    process.env.DEUS_RUNTIME = "1";
    process.env.DEUS_RUNTIME_COMMAND = "agent-server";
    process.env.DEUS_RUNTIME_EXECUTABLE = "/tmp/stale-runtime";
    process.env.NODE_PATH = "/tmp/stale-node-modules";
    process.env.NODE_ENV = "development";
    process.env.PORT = "45678";

    const child = createFakeChild();
    mockSpawn.mockReturnValue(child);

    const resultPromise = spawnBackend();
    child.stdout.write("[BACKEND_PORT]45678\n");
    const result = await resultPromise;

    expect(result.port).toBe(45678);
    expect(mockSpawn).toHaveBeenCalledOnce();
    const [command, args, options] = mockSpawn.mock.calls[0];
    expect(command).toBe(runtimePath);
    expect(args).toEqual(["backend"]);
    expect(options.cwd).toBe("/Users/test/Library/Application Support/Deus");
    expect(options.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(options.env.AGENT_SERVER_ENTRY).toBeUndefined();
    expect(options.env.AGENT_SERVER_CWD).toBeUndefined();
    expect(options.env.DEUS_AUTH_TOKEN).toBeUndefined();
    expect(options.env.DEUS_BACKEND_PORT).toBeUndefined();
    expect(options.env.DEUS_DATA_DIR).toBeUndefined();
    expect(options.env.DEUS_RUNTIME).toBeUndefined();
    expect(options.env.DEUS_RUNTIME_COMMAND).toBeUndefined();
    expect(options.env.NODE_PATH).toBeUndefined();
    expect(options.env.DEUS_PACKAGED).toBe("1");
    expect(options.env.NODE_ENV).toBe("production");
    expect(options.env.DEUS_RESOURCES_PATH).toBe(resourcesPath);
    expect(options.env.DEUS_RUNTIME_EXECUTABLE).toBe(runtimePath);
    expect(options.env.DEUS_BUNDLED_BIN_DIR).toBe(path.join(resourcesPath, "bin"));
    expect(options.env.DATABASE_PATH).toBe(
      "/Users/test/Library/Application Support/Deus/deus.db"
    );
    expect(options.env.AUTH_TOKEN).toBe(result.authToken);
    expect(options.env.AUTH_TOKEN).not.toBe("stale-auth-token");
    expect(options.env.PATH).toBe(
      `${path.join(resourcesPath, "bin")}:/usr/bin:/bin:/usr/sbin:/sbin`
    );
    expect(options.env.PORT).toBe("0");
    expect(options.env.CDP_PORT).toBe(CDP_PORT);
  });

  it("fails before spawning when packaged deus-runtime is missing", async () => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      enumerable: true,
      value: "darwin",
    });
    const resourcesPath = createTempResourcesRoot();
    (process as { resourcesPath?: string }).resourcesPath = resourcesPath;

    await expect(spawnBackend()).rejects.toThrow(
      /deus-runtime executable is missing or not executable/
    );
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("fails before spawning when packaged deus-runtime is not executable", async () => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      enumerable: true,
      value: "darwin",
    });
    const resourcesPath = createTempResourcesRoot();
    const runtimePath = path.join(resourcesPath, "bin", "deus-runtime");
    writeFileSync(runtimePath, "#!/bin/sh\n");
    chmodSync(runtimePath, 0o644);
    (process as { resourcesPath?: string }).resourcesPath = resourcesPath;

    await expect(spawnBackend()).rejects.toThrow(
      /deus-runtime executable is missing or not executable/
    );
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("fails before spawning when packaged deus-runtime points at a directory", async () => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      enumerable: true,
      value: "darwin",
    });
    const resourcesPath = createTempResourcesRoot();
    mkdirSync(path.join(resourcesPath, "bin", "deus-runtime"));
    (process as { resourcesPath?: string }).resourcesPath = resourcesPath;

    await expect(spawnBackend()).rejects.toThrow(
      /deus-runtime executable is missing or not executable/
    );
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});
