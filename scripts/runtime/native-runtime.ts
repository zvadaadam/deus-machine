import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRuntimeStagePaths } from "../../shared/runtime";

const runtimeDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(runtimeDir, "../..");

const DEUS_RUNTIME_TARGETS = [
  { runtimeKey: "darwin-arm64", bunTarget: "bun-darwin-arm64" },
  { runtimeKey: "darwin-x64", bunTarget: "bun-darwin-x64" },
  { runtimeKey: "linux-x64", bunTarget: "bun-linux-x64" },
] as const;

// Final distribution signing is electron-builder's job; staged runtime builds
// stay ad-hoc so local keychains cannot silently produce unnotarized Developer ID binaries.
function signMacExecutable(filePath: string): void {
  const result = spawnSync(
    "codesign",
    [
      "--force",
      "--options",
      "runtime",
      "--pagesize",
      "4096",
      "--identifier",
      "deus-runtime",
      "--entitlements",
      path.join(projectRoot, "resources", "entitlements.runtime.plist"),
      "--sign",
      process.env.DEUS_RUNTIME_CODESIGN_IDENTITY || process.env.CSC_NAME || "-",
      filePath,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  );
  if (result.status !== 0) {
    throw new Error(`Failed to sign ${filePath}: ${result.stderr || result.stdout}`);
  }
}

/** Compiles apps/runtime into dist/runtime/electron/bin/<target>/deus-runtime for every target. */
export function buildDeusRuntime(): void {
  const entry = path.join(projectRoot, "apps", "runtime", "index.ts");
  for (const target of DEUS_RUNTIME_TARGETS) {
    const output = path.join(
      resolveRuntimeStagePaths(projectRoot).electron.root,
      "bin",
      target.runtimeKey,
      "deus-runtime"
    );
    mkdirSync(path.dirname(output), { recursive: true });
    rmSync(output, { force: true });

    const result = spawnSync(
      "bun",
      [
        "build",
        entry,
        "--compile",
        `--target=${target.bunTarget}`,
        "--sourcemap=none",
        `--outfile=${output}`,
        // Without it a compiled Bun reads no package.json, so no package loads from disk.
        "--compile-autoload-package-json",
        "--external",
        "better-sqlite3",
        "--external",
        "@napi-rs/canvas",
        "--external",
        "@napi-rs/canvas-darwin-arm64",
        "--external",
        "@napi-rs/canvas-darwin-x64",
        "--external",
        "@napi-rs/canvas-linux-x64-gnu",
      ],
      {
        cwd: projectRoot,
        env: { ...process.env, NODE_ENV: "production" },
        stdio: "inherit",
      }
    );
    if (result.status !== 0) {
      throw new Error(`Failed to build ${target.runtimeKey}/deus-runtime`);
    }

    chmodSync(output, 0o755);
    if (process.platform === "darwin" && target.runtimeKey.startsWith("darwin-")) {
      signMacExecutable(output);
    }
    console.log(`✓ ${target.runtimeKey}/deus-runtime built`);
  }
}
