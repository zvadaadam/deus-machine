import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockExecFile } = vi.hoisted(() => ({
  mockExecFile: vi.fn(),
}));

vi.mock("child_process", () => ({
  execFile: mockExecFile,
}));

import { killChildProcesses } from "../process-cleanup";

describe("killChildProcesses", () => {
  let killSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses pgrep without a shell and treats exit code 1 as no children", async () => {
    const noMatch = Object.assign(new Error("no processes found"), { code: 1 });
    mockExecFile.mockImplementation((_file, _args, callback) => {
      callback(noMatch, "");
    });

    await killChildProcesses(123);

    expect(mockExecFile).toHaveBeenCalledWith(
      "/usr/bin/pgrep",
      ["-P", "123"],
      expect.any(Function)
    );
    expect(killSpy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith("[CLEANUP] No child processes found");
  });

  it("logs real pgrep failures and does not attempt to kill unknown children", async () => {
    const failure = Object.assign(new Error("bad pgrep invocation"), { code: 2 });
    mockExecFile.mockImplementation((_file, _args, callback) => {
      callback(failure, "");
    });

    await killChildProcesses(123);

    expect(killSpy).not.toHaveBeenCalled();
    expect(
      logSpy.mock.calls.some((call: unknown[]) => String(call[0]).includes("Failed to enumerate"))
    ).toBe(true);
  });

  it("waits until a signalled child process is gone before resolving", async () => {
    mockExecFile.mockImplementation((_file, _args, callback) => {
      callback(null, "456\n");
    });
    killSpy.mockImplementation((_pid: unknown, signal?: unknown) => {
      if (signal === 0) {
        throw Object.assign(new Error("gone"), { code: "ESRCH" });
      }
      return true;
    });

    await killChildProcesses(123);

    expect(killSpy).toHaveBeenCalledWith(456, "SIGTERM");
    expect(killSpy).toHaveBeenCalledWith(456, 0);
    expect(logSpy).toHaveBeenCalledWith("[CLEANUP] Child PID 456 exited after SIGTERM");
  });
});
