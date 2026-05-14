import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const { mockExecFileAsync } = vi.hoisted(() => ({
  mockExecFileAsync: vi.fn(() => Promise.resolve({ stdout: "", stderr: "" })),
}));

vi.mock("child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("util", () => ({
  promisify: () => mockExecFileAsync,
}));

import { checkCliTool, getCliLookupEnv } from "../../../../desktop/main/cli-tools";

const originalEnv = {
  DEUS_BUNDLED_BIN_DIR: process.env.DEUS_BUNDLED_BIN_DIR,
  DEUS_PACKAGED: process.env.DEUS_PACKAGED,
  DEUS_RUNTIME: process.env.DEUS_RUNTIME,
  PATH: process.env.PATH,
};

const itOnPosix = process.platform === "win32" ? it.skip : it;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.DEUS_PACKAGED = "1";
  delete process.env.DEUS_RUNTIME;
  process.env.DEUS_BUNDLED_BIN_DIR = "/nonexistent/deus-desktop-cli-tools";
  process.env.PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin";
});

afterAll(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("desktop CLI tool lookup", () => {
  it.each(["codex", "claude", "gh", "rg"])(
    "does not shell/global lookup packaged bundled tool %s when missing",
    async (tool) => {
      const result = await checkCliTool(tool);

      expect(result).toEqual({ installed: false, path: null });
      expect(mockExecFileAsync).not.toHaveBeenCalled();
    }
  );

  itOnPosix.each(["codex", "claude", "gh", "rg"])(
    "resolves packaged %s from Resources/bin and constrains PATH",
    async (tool) => {
      const dir = mkdtempSync(path.join(tmpdir(), "deus-desktop-cli-"));
      const bundledToolPath = path.join(dir, tool);
      process.env.DEUS_BUNDLED_BIN_DIR = dir;

      try {
        writeFileSync(bundledToolPath, "");
        chmodSync(bundledToolPath, 0o755);

        const result = await checkCliTool(tool);

        expect(result).toEqual({ installed: true, path: bundledToolPath });
        expect(mockExecFileAsync).not.toHaveBeenCalled();
        expect(getCliLookupEnv().PATH).toBe(`${dir}:/usr/bin:/bin:/usr/sbin:/sbin`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  );
});
