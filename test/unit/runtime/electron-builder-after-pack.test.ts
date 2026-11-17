import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { pruneCanvasRuntimeBinaries } =
  require("../../../scripts/runtime/electron-builder-after-pack.cjs") as {
    pruneCanvasRuntimeBinaries: (context: {
      electronPlatformName: string;
      arch: string | number;
      resourcesDir: string;
    }) => { removed: number; kept: number };
  };

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("electron-builder afterPack", () => {
  it("prunes @napi-rs/canvas native packages to the target arch", () => {
    const resourcesDir = path.join(os.tmpdir(), `deus-canvas-prune-${Date.now()}-${Math.random()}`);
    tempRoots.push(resourcesDir);
    const napiRsRoot = path.join(resourcesDir, "app.asar.unpacked", "node_modules", "@napi-rs");
    for (const packageName of [
      "canvas",
      "canvas-darwin-arm64",
      "canvas-darwin-x64",
      "canvas-linux-x64-gnu",
      "canvas-win32-x64-msvc",
    ]) {
      const packageRoot = path.join(napiRsRoot, packageName);
      mkdirSync(packageRoot, { recursive: true });
      writeFileSync(path.join(packageRoot, "package.json"), "{}");
    }

    expect(
      pruneCanvasRuntimeBinaries({
        electronPlatformName: "darwin",
        arch: "arm64",
        resourcesDir,
      })
    ).toEqual({ removed: 3, kept: 1 });

    expect(readdirSync(napiRsRoot).sort()).toEqual(["canvas", "canvas-darwin-arm64"]);
  });
});
