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
const originalResourcesPathEnv = process.env.DEUS_RESOURCES_PATH;
const originalDeusPackaged = process.env.DEUS_PACKAGED;
const originalDeusRuntime = process.env.DEUS_RUNTIME;
const originalCwd = process.cwd();

afterEach(() => {
  if (originalBundledBinDir === undefined) delete process.env.DEUS_BUNDLED_BIN_DIR;
  else process.env.DEUS_BUNDLED_BIN_DIR = originalBundledBinDir;
  if (originalResourcesPathEnv === undefined) delete process.env.DEUS_RESOURCES_PATH;
  else process.env.DEUS_RESOURCES_PATH = originalResourcesPathEnv;
  if (originalDeusPackaged === undefined) delete process.env.DEUS_PACKAGED;
  else process.env.DEUS_PACKAGED = originalDeusPackaged;
  if (originalDeusRuntime === undefined) delete process.env.DEUS_RUNTIME;
  else process.env.DEUS_RUNTIME = originalDeusRuntime;
  process.chdir(originalCwd);
});

describe("cli path helpers", () => {
  it("prepends the bundled CLI directory before the inherited PATH", () => {
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

  it("does not fall back to PATH in packaged runtime mode", () => {
    process.env.DEUS_PACKAGED = "1";
    process.env.DEUS_BUNDLED_BIN_DIR = "/Applications/Deus.app/Contents/Resources/bin";

    expect(resolveBundledCliPath("gh")).toBeNull();
    expect(resolveCliExecutable("gh")).toBe("/Applications/Deus.app/Contents/Resources/bin/gh");
  });

  it("uses DEUS_RESOURCES_PATH as the packaged runtime resources root", () => {
    const root = mkdtempSync(path.join(tmpdir(), "deus-cli-resources-"));
    const binDir = path.join(root, "bin");
    const executablePath = path.join(binDir, process.platform === "win32" ? "gh.exe" : "gh");
    delete process.env.DEUS_BUNDLED_BIN_DIR;
    process.env.DEUS_RESOURCES_PATH = root;

    try {
      mkdirSync(binDir, { recursive: true });
      writeFileSync(executablePath, "");
      chmodSync(executablePath, 0o755);

      expect(getBundledCliDirectory()).toBe(binDir);
      expect(resolveBundledCliPath("gh")).toBe(executablePath);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses a non-global sentinel path when packaged runtime has no bundled bin directory", () => {
    process.env.DEUS_PACKAGED = "1";
    delete process.env.DEUS_BUNDLED_BIN_DIR;

    expect(resolveCliExecutable("gh")).toBe("/__deus_missing_bundled_bin__/gh");
  });

  it("ignores inherited user PATH entries in packaged runtime mode", () => {
    process.env.DEUS_PACKAGED = "1";
    process.env.DEUS_BUNDLED_BIN_DIR = "/Applications/Deus.app/Contents/Resources/bin";

    expect(extendCliPath("/opt/homebrew/bin:/usr/local/bin:/usr/bin")).toBe(
      [
        "/Applications/Deus.app/Contents/Resources/bin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
      ].join(path.delimiter)
    );
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
