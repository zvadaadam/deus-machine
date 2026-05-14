import { chmodSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  binaryNamesForTarget,
  pruneNodePtyRuntimeBinaries,
  prunePencilCliBinaries,
  verifyPackagedRuntimeExternalModules,
  verifyPackagedRuntimeManifests,
} =
  require("../../../scripts/prune-pencil-cli-binaries.cjs") as {
    binaryNamesForTarget: (platform: string, arch: string | number) => Set<string>;
    pruneNodePtyRuntimeBinaries: (context: {
      electronPlatformName: string;
      arch: string | number;
      resourcesDir: string;
    }) => { removed: number; kept: number };
    prunePencilCliBinaries: (context: {
      electronPlatformName: string;
      arch: string | number;
      resourcesDir: string;
    }) => { removed: number; kept: number };
    verifyPackagedRuntimeExternalModules: (resourcesDir: string, targetArch: string) => void;
    verifyPackagedRuntimeManifests: (binDir: string, targetArch: string) => void;
  };

const tempRoots: string[] = [];

function createOutDir(
  candidatePath = ["app.asar.unpacked", "node_modules", "@pencil.dev", "cli", "dist", "out"]
): string {
  const root = createTempRoot("deus-pencil-prune");
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

function createTempRoot(prefix: string): string {
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random()}`);
}

function outDirFor(root: string, candidatePath: string[]): string {
  return path.join(root, ...candidatePath);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function writePackagedRuntimeFixture(binDir: string): void {
  mkdirSync(binDir, { recursive: true });
  const files = new Map([
    ["deus-runtime", "runtime"],
    ["codex", "codex"],
    ["claude", "claude"],
    ["rg", "rg"],
    ["gh", "gh"],
  ]);

  for (const [name, contents] of files) {
    const filePath = path.join(binDir, name);
    writeFileSync(filePath, contents);
    chmodSync(filePath, 0o755);
  }

  writeFileSync(
    path.join(binDir, "deus-runtime.json"),
    JSON.stringify(
      {
        version: 1,
        entries: [
          {
            runtimeKey: "darwin-arm64",
            sha256: sha256("runtime"),
            size: "runtime".length,
          },
        ],
      },
      null,
      2
    )
  );
  writeFileSync(
    path.join(binDir, "agent-clis.json"),
    JSON.stringify(
      {
        version: 1,
        targets: ["codex", "claude", "rg"].map((tool) => ({
          runtimeKey: "darwin-arm64",
          tool,
          sha256: sha256(files.get(tool)!),
          size: files.get(tool)!.length,
        })),
      },
      null,
      2
    )
  );
  writeFileSync(
    path.join(binDir, "gh-cli.json"),
    JSON.stringify(
      {
        version: 1,
        targets: [
          {
            runtimeKey: "darwin-arm64",
            tool: "gh",
            sha256: sha256("gh"),
            size: "gh".length,
          },
        ],
      },
      null,
      2
    )
  );
}

function writeRuntimeExternalModuleFixture(resourcesDir: string): void {
  const unpackedNodeModules = path.join(resourcesDir, "app.asar.unpacked", "node_modules");
  for (const packagePath of [
    ["better-sqlite3"],
    ["node-pty"],
    ["@napi-rs", "canvas"],
    ["@napi-rs", "canvas-darwin-arm64"],
  ]) {
    const dir = path.join(unpackedNodeModules, ...packagePath);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "package.json"), "{}");
  }
  mkdirSync(path.join(unpackedNodeModules, "better-sqlite3", "build", "Release"), {
    recursive: true,
  });
  writeFileSync(
    path.join(unpackedNodeModules, "better-sqlite3", "build", "Release", "better_sqlite3.node"),
    "sqlite-native"
  );
  mkdirSync(path.join(unpackedNodeModules, "node-pty", "prebuilds", "darwin-arm64"), {
    recursive: true,
  });
  writeFileSync(
    path.join(unpackedNodeModules, "node-pty", "prebuilds", "darwin-arm64", "pty.node"),
    "pty-native"
  );
  writeFileSync(
    path.join(unpackedNodeModules, "node-pty", "prebuilds", "darwin-arm64", "spawn-helper"),
    "pty-helper"
  );
  writeFileSync(
    path.join(
      unpackedNodeModules,
      "@napi-rs",
      "canvas-darwin-arm64",
      "skia.darwin-arm64.node"
    ),
    "canvas-native"
  );
}

function writeNodePtyPruneFixture(resourcesDir: string): string {
  const nodePtyRoot = path.join(
    resourcesDir,
    "app.asar.unpacked",
    "node_modules",
    "node-pty"
  );
  for (const fileParts of [
    ["build", "Release", "pty.node"],
    ["build", "Release", "spawn-helper"],
    ["prebuilds", "darwin-arm64", "pty.node"],
    ["prebuilds", "darwin-arm64", "spawn-helper"],
    ["prebuilds", "darwin-x64", "pty.node"],
    ["prebuilds", "darwin-x64", "spawn-helper"],
  ]) {
    const filePath = path.join(nodePtyRoot, ...fileParts);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, fileParts.join("/"));
  }
  return nodePtyRoot;
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

  it("verifies packaged runtime manifest hashes against copied Resources/bin files", () => {
    const resourcesDir = createTempRoot("deus-packaged-bin");
    tempRoots.push(resourcesDir);
    const binDir = path.join(resourcesDir, "bin");
    writePackagedRuntimeFixture(binDir);

    expect(() => verifyPackagedRuntimeManifests(binDir, "arm64")).not.toThrow();

    const codexPath = path.join(binDir, "codex");
    writeFileSync(codexPath, "stale-codex");
    chmodSync(codexPath, 0o755);
    expect(() => verifyPackagedRuntimeManifests(binDir, "arm64")).toThrow(
      /codex CLI hash does not match/
    );
  });

  it("verifies native runtime external modules are unpacked outside app.asar", () => {
    const resourcesDir = createTempRoot("deus-runtime-externals");
    tempRoots.push(resourcesDir);
    writeRuntimeExternalModuleFixture(resourcesDir);

    expect(() => verifyPackagedRuntimeExternalModules(resourcesDir, "arm64")).not.toThrow();

    rmSync(
      path.join(
        resourcesDir,
        "app.asar.unpacked",
        "node_modules",
        "@napi-rs",
        "canvas",
        "package.json"
      ),
      { force: true }
    );
    expect(() => verifyPackagedRuntimeExternalModules(resourcesDir, "arm64")).toThrow(
      /@napi-rs\/canvas package/
    );
  });

  it("prunes node-pty build output so packaged runtime resolves target prebuilds", () => {
    const resourcesDir = createTempRoot("deus-node-pty-prune");
    tempRoots.push(resourcesDir);
    const nodePtyRoot = writeNodePtyPruneFixture(resourcesDir);

    expect(
      pruneNodePtyRuntimeBinaries({
        electronPlatformName: "darwin",
        arch: "arm64",
        resourcesDir,
      })
    ).toEqual({ removed: 2, kept: 1 });

    expect(readdirSync(path.join(nodePtyRoot, "prebuilds"))).toEqual(["darwin-arm64"]);
    expect(() => readdirSync(path.join(nodePtyRoot, "build"))).toThrow();
  });

  it("rejects packaged node-pty build output before target prebuilds", () => {
    const resourcesDir = createTempRoot("deus-node-pty-stale-build");
    tempRoots.push(resourcesDir);
    writeRuntimeExternalModuleFixture(resourcesDir);
    const staleBuild = path.join(
      resourcesDir,
      "app.asar.unpacked",
      "node_modules",
      "node-pty",
      "build",
      "Release",
      "pty.node"
    );
    mkdirSync(path.dirname(staleBuild), { recursive: true });
    writeFileSync(staleBuild, "electron-abi-build");

    expect(() => verifyPackagedRuntimeExternalModules(resourcesDir, "arm64")).toThrow(
      /node-pty build output/
    );
  });

  it("requires native runtime external module payloads outside app.asar", () => {
    const resourcesDir = createTempRoot("deus-runtime-native-payloads");
    tempRoots.push(resourcesDir);
    writeRuntimeExternalModuleFixture(resourcesDir);

    rmSync(
      path.join(
        resourcesDir,
        "app.asar.unpacked",
        "node_modules",
        "@napi-rs",
        "canvas-darwin-arm64",
        "skia.darwin-arm64.node"
      ),
      { force: true }
    );

    expect(() => verifyPackagedRuntimeExternalModules(resourcesDir, "arm64")).toThrow(
      /@napi-rs\/canvas native binding/
    );
  });
});
