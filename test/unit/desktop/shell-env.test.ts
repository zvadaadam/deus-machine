import { afterEach, describe, expect, it, vi } from "vitest";

const { mockExecFile } = vi.hoisted(() => ({
  mockExecFile: vi.fn(),
}));

vi.mock("child_process", () => ({
  execFile: mockExecFile,
}));

import { syncShellEnvironment } from "../../../apps/desktop/main/shell-env";

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
const originalDeusPackaged = process.env.DEUS_PACKAGED;
const originalDeusRuntime = process.env.DEUS_RUNTIME;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform,
  });
}

afterEach(() => {
  mockExecFile.mockReset();
  if (originalPlatform) {
    Object.defineProperty(process, "platform", originalPlatform);
  }
  if (originalDeusPackaged === undefined) delete process.env.DEUS_PACKAGED;
  else process.env.DEUS_PACKAGED = originalDeusPackaged;
  if (originalDeusRuntime === undefined) delete process.env.DEUS_RUNTIME;
  else process.env.DEUS_RUNTIME = originalDeusRuntime;
});

describe("desktop shell environment sync", () => {
  it("does not read login shell PATH in packaged Electron main", async () => {
    setPlatform("darwin");
    process.env.DEUS_PACKAGED = "1";

    await syncShellEnvironment();

    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("does not read login shell PATH inside deus-runtime", async () => {
    setPlatform("darwin");
    process.env.DEUS_RUNTIME = "1";

    await syncShellEnvironment();

    expect(mockExecFile).not.toHaveBeenCalled();
  });
});
