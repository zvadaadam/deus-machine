import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockExecFile, mockSpawn } = vi.hoisted(() => ({
  mockExecFile: vi.fn(),
  mockSpawn: vi.fn(),
}));

vi.mock("child_process", () => ({
  execFile: mockExecFile,
  spawn: mockSpawn,
}));

vi.mock("@shared/lib/cli-path", () => ({
  resolveBundledCliPath: vi.fn((tool: string) =>
    tool === "agent-browser" ? "/Applications/Deus.app/Contents/Resources/bin/agent-browser" : null
  ),
  resolveCliExecutable: vi.fn((tool: string) => `/__deus_missing_bundled_bin__/${tool}`),
}));

import { execAgentBrowser } from "../agents/deus-tools/agent-browser-client";

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  process.env = { ...originalEnv };
  mockExecFile.mockImplementation((_binary, _args, _options, callback) => {
    callback(null, '{"success":true,"data":{"ok":true}}\n', "");
    return { on: vi.fn() };
  });
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("agent-browser client", () => {
  it("scrubs packaged runtime-only environment from child CLI processes", async () => {
    process.env.DEUS_RUNTIME = "1";
    process.env.DEUS_RUNTIME_COMMAND = "agent-server";
    process.env.DEUS_RUNTIME_EXECUTABLE = "/Applications/Deus.app/Contents/Resources/bin/deus-runtime";
    process.env.DEUS_BUNDLED_BIN_DIR = "/Applications/Deus.app/Contents/Resources/bin";
    process.env.DEUS_RESOURCES_PATH = "/Applications/Deus.app/Contents/Resources";
    process.env.ELECTRON_RUN_AS_NODE = "1";
    process.env.NODE_PATH = "/repo/node_modules";
    process.env.PORT = "1234";

    await expect(execAgentBrowser("session-1", ["snapshot"])).resolves.toMatchObject({
      success: true,
      data: { ok: true },
    });

    const [binary, args, options] = mockExecFile.mock.calls[0];
    expect(binary).toBe("/Applications/Deus.app/Contents/Resources/bin/agent-browser");
    expect(args).toEqual(["snapshot"]);
    expect(options.env.AGENT_BROWSER_SESSION).toBe("session-1");
    expect(options.env.AGENT_BROWSER_HEADED).toBe("1");
    expect(options.env.AGENT_BROWSER_STREAM_PORT).toBe("9223");
    expect(options.env.DEUS_RUNTIME).toBeUndefined();
    expect(options.env.DEUS_RUNTIME_COMMAND).toBeUndefined();
    expect(options.env.DEUS_RUNTIME_EXECUTABLE).toBeUndefined();
    expect(options.env.DEUS_BUNDLED_BIN_DIR).toBeUndefined();
    expect(options.env.DEUS_RESOURCES_PATH).toBeUndefined();
    expect(options.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(options.env.NODE_PATH).toBeUndefined();
    expect(options.env.PORT).toBeUndefined();
  });
});
