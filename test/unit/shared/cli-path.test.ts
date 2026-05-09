import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  extendCliPath,
  getBundledCliDirectory,
  resolveBundledCliPath,
  resolveCliExecutable,
} from "@shared/lib/cli-path";

const originalBundledBinDir = process.env.DEUS_BUNDLED_BIN_DIR;
const originalCwd = process.cwd();

afterEach(() => {
  if (originalBundledBinDir === undefined) delete process.env.DEUS_BUNDLED_BIN_DIR;
  else process.env.DEUS_BUNDLED_BIN_DIR = originalBundledBinDir;
  process.chdir(originalCwd);
});

describe("cli path helpers", () => {
  it("prepends the bundled CLI directory before system fallbacks", () => {
    process.env.DEUS_BUNDLED_BIN_DIR = "/Applications/Deus.app/Contents/Resources/bin";
    const basePath = ["/usr/bin", "/bin"].join(path.delimiter);

    expect(extendCliPath(basePath).split(path.delimiter).slice(0, 3)).toEqual([
      "/Applications/Deus.app/Contents/Resources/bin",
      "/usr/bin",
      "/bin",
    ]);
  });

  it("resolves a bundled executable when it exists", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "deus-cli-path-"));
    const executablePath = path.join(dir, process.platform === "win32" ? "gh.exe" : "gh");
    process.env.DEUS_BUNDLED_BIN_DIR = dir;

    try {
      writeFileSync(executablePath, "");
      chmodSync(executablePath, 0o755);

      expect(getBundledCliDirectory()).toBe(dir);
      expect(resolveBundledCliPath("gh")).toBe(executablePath);
      expect(resolveCliExecutable("gh")).toBe(executablePath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to the command name when no bundled executable exists", () => {
    process.env.DEUS_BUNDLED_BIN_DIR = "/missing";

    expect(resolveBundledCliPath("gh")).toBeNull();
    expect(resolveCliExecutable("gh")).toBe("gh");
  });

  it.runIf(process.platform === "darwin" && (process.arch === "arm64" || process.arch === "x64"))(
    "resolves the staged dev binary when the packaged resources path is unavailable",
    () => {
      delete process.env.DEUS_BUNDLED_BIN_DIR;
      const root = mkdtempSync(path.join(tmpdir(), "deus-cli-path-dev-"));
      const dir = path.join(root, "dist", "runtime", "electron", "bin", `darwin-${process.arch}`);
      const executablePath = path.join(dir, "gh");

      try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(executablePath, "");
        chmodSync(executablePath, 0o755);
        process.chdir(root);
        const expectedPath = path.join(
          process.cwd(),
          "dist",
          "runtime",
          "electron",
          "bin",
          `darwin-${process.arch}`,
          "gh"
        );

        expect(resolveBundledCliPath("gh")).toBe(expectedPath);
        expect(resolveCliExecutable("gh")).toBe(expectedPath);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  );

  it("rejects unsafe command names for bundled path resolution", () => {
    process.env.DEUS_BUNDLED_BIN_DIR = "/Applications/Deus.app/Contents/Resources/bin";

    expect(resolveBundledCliPath("../gh")).toBeNull();
  });
});
