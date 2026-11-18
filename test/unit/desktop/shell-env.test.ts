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
});

describe("desktop shell environment sync", () => {
  it("does not read login shell PATH when packaged (Electron main or deus-runtime)", async () => {
    setPlatform("darwin");
    process.env.DEUS_PACKAGED = "1";

    await syncShellEnvironment();

    expect(mockExecFile).not.toHaveBeenCalled();
  });
});
