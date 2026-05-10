import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { binaryNamesForTarget, prunePencilCliBinaries } =
  require("../../../scripts/prune-pencil-cli-binaries.cjs") as {
    binaryNamesForTarget: (platform: string, arch: string | number) => Set<string>;
    prunePencilCliBinaries: (context: {
      electronPlatformName: string;
      arch: string | number;
      resourcesDir: string;
    }) => { removed: number; kept: number };
  };

const tempRoots: string[] = [];

function createOutDir(
  candidatePath = ["app.asar.unpacked", "node_modules", "@pencil.dev", "cli", "dist", "out"]
): string {
  const root = path.join(os.tmpdir(), `deus-pencil-prune-${Date.now()}-${Math.random()}`);
  tempRoots.push(root);
  const outDir = path.join(root, ...candidatePath);
  mkdirSync(path.join(outDir, "data"), { recursive: true });
  for (const name of [
    "mcp-server-darwin-arm64",
    "mcp-server-darwin-x64",
    "mcp-server-linux-x64",
    "mcp-server-windows-x64.exe",
  ]) {
    writeFileSync(path.join(outDir, name), name);
  }
  writeFileSync(path.join(outDir, "data", "shadcn.lib.pen"), "library");
  return root;
}

function outDirFor(root: string, candidatePath: string[]): string {
  return path.join(root, ...candidatePath);
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("prune-pencil-cli-binaries", () => {
  it("keeps only the target MCP binary and shared data files", () => {
    const resourcesDir = createOutDir();
    const result = prunePencilCliBinaries({
      electronPlatformName: "darwin",
      arch: "arm64",
      resourcesDir,
    });

    const outDir = outDirFor(resourcesDir, [
      "app.asar.unpacked",
      "node_modules",
      "@pencil.dev",
      "cli",
      "dist",
      "out",
    ]);
    expect(result).toEqual({ removed: 3, kept: 1 });
    expect(readdirSync(outDir).sort()).toEqual(["data", "mcp-server-darwin-arm64"]);
    expect(readdirSync(path.join(outDir, "data"))).toEqual(["shadcn.lib.pen"]);
  });

  it("also prunes the packaged Pencil app dependency copy", () => {
    const candidatePath = [
      "agentic-apps",
      "pencil",
      "node_modules",
      "@pencil.dev",
      "cli",
      "dist",
      "out",
    ];
    const resourcesDir = createOutDir(candidatePath);
    const result = prunePencilCliBinaries({
      electronPlatformName: "linux",
      arch: "x64",
      resourcesDir,
    });

    expect(result).toEqual({ removed: 3, kept: 1 });
    expect(readdirSync(outDirFor(resourcesDir, candidatePath)).sort()).toEqual([
      "data",
      "mcp-server-linux-x64",
    ]);
  });

  it("maps electron-builder arch numbers to Pencil binary names", () => {
    expect(binaryNamesForTarget("win32", 1)).toEqual(new Set(["mcp-server-windows-x64.exe"]));
    expect(binaryNamesForTarget("linux", 3)).toEqual(new Set(["mcp-server-linux-arm64"]));
  });
});
