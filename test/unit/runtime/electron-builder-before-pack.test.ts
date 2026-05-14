import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { assertPackagedMainRuntimeContract, assertPackagedRuntimePlatform } = require(
  "../../../scripts/runtime/electron-builder-before-pack.cjs"
) as {
  assertPackagedMainRuntimeContract: (projectRoot: string) => void;
  assertPackagedRuntimePlatform: (context?: { electronPlatformName?: string }) => void;
};

const tempRoots: string[] = [];

function createProjectWithMainOutput(contents: string): string {
  const projectRoot = mkdtempSync(path.join(os.tmpdir(), "deus-before-pack-"));
  tempRoots.push(projectRoot);
  const mainOutput = path.join(projectRoot, "out", "main", "index.js");
  mkdirSync(path.dirname(mainOutput), { recursive: true });
  writeFileSync(mainOutput, contents);
  return projectRoot;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("electron-builder beforePack runtime guard", () => {
  it("allows macOS packaging where native runtime binaries are staged", () => {
    expect(() => assertPackagedRuntimePlatform({ electronPlatformName: "darwin" })).not.toThrow();
  });

  it("rejects non-macOS packaging until native runtime binaries are staged", () => {
    expect(() => assertPackagedRuntimePlatform({ electronPlatformName: "linux" })).toThrow(
      /native runtime is currently staged only for macOS/
    );
  });

  it("accepts Electron main output with the packaged deus-runtime contract", () => {
    const projectRoot = createProjectWithMainOutput(
      [
        "const runtimeExecutable = join(process.resourcesPath, 'bin', 'deus-runtime');",
        "const env = { DEUS_RUNTIME_EXECUTABLE: runtimeExecutable };",
      ].join("\n")
    );

    expect(() => assertPackagedMainRuntimeContract(projectRoot)).not.toThrow();
  });

  it("rejects Electron main output missing the packaged deus-runtime contract", () => {
    const projectRoot = createProjectWithMainOutput("console.log('backend');");

    expect(() => assertPackagedMainRuntimeContract(projectRoot)).toThrow(
      /does not contain the packaged deus-runtime launch contract/
    );
  });

  it("rejects obsolete packaged backend bundle paths", () => {
    const projectRoot = createProjectWithMainOutput(
      [
        "const runtimeExecutable = join(process.resourcesPath, 'bin', 'deus-runtime');",
        "const env = { DEUS_RUNTIME_EXECUTABLE: runtimeExecutable };",
        'const backendEntry = join(process.resourcesPath, "backend", "server.bundled.cjs");',
      ].join("\n")
    );

    expect(() => assertPackagedMainRuntimeContract(projectRoot)).toThrow(
      /obsolete packaged backend bundle path/
    );
  });

  it("rejects obsolete packaged NODE_PATH plumbing", () => {
    const projectRoot = createProjectWithMainOutput(
      [
        "const runtimeExecutable = join(process.resourcesPath, 'bin', 'deus-runtime');",
        "const env = { DEUS_RUNTIME_EXECUTABLE: runtimeExecutable, NODE_PATH: runtime.nodePath };",
      ].join("\n")
    );

    expect(() => assertPackagedMainRuntimeContract(projectRoot)).toThrow(
      /obsolete packaged NODE_PATH plumbing/
    );
  });
});
