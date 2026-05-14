import { EventEmitter } from "node:events";
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
    (process as { resourcesPath?: string }).resourcesPath =
      "/Applications/Deus.app/Contents/Resources";
    process.env.PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin";
    process.env.ELECTRON_RUN_AS_NODE = "1";
    process.env.AGENT_SERVER_ENTRY = "/tmp/dev-agent-server.cjs";
    process.env.AGENT_SERVER_CWD = "/tmp/dev-agent-server";

    const child = createFakeChild();
    mockSpawn.mockReturnValue(child);

    const resultPromise = spawnBackend();
    child.stdout.write("[BACKEND_PORT]45678\n");
    const result = await resultPromise;

    expect(result.port).toBe(45678);
    expect(mockSpawn).toHaveBeenCalledOnce();
    const [command, args, options] = mockSpawn.mock.calls[0];
    expect(command).toBe("/Applications/Deus.app/Contents/Resources/bin/deus-runtime");
    expect(args).toEqual(["backend"]);
    expect(options.cwd).toBe("/Users/test/Library/Application Support/Deus");
    expect(options.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(options.env.AGENT_SERVER_ENTRY).toBeUndefined();
    expect(options.env.AGENT_SERVER_CWD).toBeUndefined();
    expect(options.env.DEUS_PACKAGED).toBe("1");
    expect(options.env.DEUS_RESOURCES_PATH).toBe("/Applications/Deus.app/Contents/Resources");
    expect(options.env.DEUS_RUNTIME_EXECUTABLE).toBe(
      "/Applications/Deus.app/Contents/Resources/bin/deus-runtime"
    );
    expect(options.env.DEUS_BUNDLED_BIN_DIR).toBe(
      "/Applications/Deus.app/Contents/Resources/bin"
    );
    expect(options.env.DATABASE_PATH).toBe(
      "/Users/test/Library/Application Support/Deus/deus.db"
    );
    expect(options.env.PATH).toBe(
      "/Applications/Deus.app/Contents/Resources/bin:/usr/bin:/bin:/usr/sbin:/sbin"
    );
    expect(options.env.PORT).toBe("0");
    expect(options.env.CDP_PORT).toBe(CDP_PORT);
  });
});
