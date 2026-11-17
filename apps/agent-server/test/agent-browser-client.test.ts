import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockExecFile, mockSpawn } = vi.hoisted(() => {
  // Before the client loads (imports are hoisted above plain statements), as an
  // older desktop app set it: it must not matter.
  process.env.CDP_PORT = "19222";
  return { mockExecFile: vi.fn(), mockSpawn: vi.fn() };
});

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

import { execAgentBrowser, getRecordingTarget } from "../agents/deus-tools/agent-browser-client";

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
    process.env.DEUS_RUNTIME_EXECUTABLE =
      "/Applications/Deus.app/Contents/Resources/bin/deus-runtime";
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
    // Recording attaches to the session's own DevTools endpoint; no shared stream port.
    expect(options.env.AGENT_BROWSER_STREAM_PORT).toBeUndefined();
    expect(options.env.DEUS_RUNTIME).toBeUndefined();
    expect(options.env.DEUS_RUNTIME_COMMAND).toBeUndefined();
    expect(options.env.DEUS_RUNTIME_EXECUTABLE).toBeUndefined();
    expect(options.env.DEUS_BUNDLED_BIN_DIR).toBeUndefined();
    expect(options.env.DEUS_RESOURCES_PATH).toBeUndefined();
    expect(options.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(options.env.NODE_PATH).toBeUndefined();
    expect(options.env.PORT).toBeUndefined();
  });

  it("never attaches to a DevTools port: every command runs in the session's own browser", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await execAgentBrowser("session-1", ["open", "https://example.com"]);
    expect(mockExecFile.mock.calls[0][1]).toEqual(["open", "https://example.com"]);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("records the tab agent-browser drives for the session, found through agent-browser itself", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    mockExecFile.mockImplementation((_binary, args: string[], _options, callback) => {
      const reply =
        args[1] === "cdp-url"
          ? { success: true, data: { cdpUrl: "ws://127.0.0.1:41000/devtools/page/A" } }
          : { success: true, data: { url: "https://example.com/" } };
      callback(null, `${JSON.stringify(reply)}\n`, "");
      return { on: vi.fn() };
    });

    await expect(getRecordingTarget("session-1")).resolves.toEqual({
      endpoint: "ws://127.0.0.1:41000/devtools/page/A",
      url: "https://example.com/",
    });
    expect(mockExecFile.mock.calls.map((call) => call[1])).toEqual([
      ["get", "cdp-url", "--json"],
      ["get", "url", "--json"],
    ]);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
