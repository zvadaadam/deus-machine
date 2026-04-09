/**
 * Build script for @deus/cli
 *
 * 1. Bundle the CLI TypeScript → dist/cli.js (esbuild)
 * 2. Stage the shared runtime artifact (backend + agent-server bundles)
 * 3. Copy the staged runtime bundles into bundles/ for npm distribution
 */

import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { resolve, join, dirname } from "path";
import { fileURLToPath } from "url";
import { stageRuntime } from "../runtime/stage";
import { resolveRuntimeStagePaths } from "../../shared/runtime";

const __filename = fileURLToPath(import.meta.url);
const cliDir = dirname(__filename);
const monorepoRoot = resolve(cliDir, "../..");

async function main() {
  console.log("Building deus-machine CLI...\n");

  // Step 1: Bundle CLI TypeScript
  console.log("1. Bundling CLI...");
  await build({
    entryPoints: [join(cliDir, "src/cli.ts")],
    bundle: true,
    platform: "node",
    target: "node20",
    format: "esm",
    outfile: join(cliDir, "dist/cli.js"),
    external: [
      "better-sqlite3",
      "node-pty",
      "ws",
      "@sentry/node",
      "@openai/codex",
      "@openai/codex-sdk",
      "@napi-rs/canvas",
      "agent-browser",
    ],
    packages: "external",
    minify: false,
    sourcemap: false,
    logLevel: "info",
  });

  // Step 2: Create bin/ entry point
  console.log("\n2. Creating bin/deus.js...");
  mkdirSync(join(cliDir, "bin"), { recursive: true });
  writeFileSync(join(cliDir, "bin/deus.js"), `#!/usr/bin/env node\nimport "../dist/cli.js";\n`, {
    mode: 0o755,
  });

  // Step 3: Stage shared runtime
  console.log("\n3. Staging shared runtime...");
  stageRuntime({ log: (line) => console.log(`   ${line}`) });
  const runtimePaths = resolveRuntimeStagePaths(monorepoRoot);

  // Step 4: Copy staged bundles for distribution
  console.log("\n4. Copying runtime bundles...");
  const bundlesDir = join(cliDir, "bundles");
  rmSync(bundlesDir, { recursive: true, force: true });
  mkdirSync(bundlesDir, { recursive: true });

  const copies = [
    {
      src: runtimePaths.common.agentServerBundle,
      dest: join(bundlesDir, "agent-server.bundled.cjs"),
      name: "agent-server bundle",
    },
    {
      src: runtimePaths.common.backendBundle,
      dest: join(bundlesDir, "server.bundled.cjs"),
      name: "backend bundle",
    },
  ];

  for (const copy of copies) {
    if (!existsSync(copy.src)) {
      console.error(`   ✗ ${copy.name} not found: ${copy.src}`);
      process.exit(1);
    }
    cpSync(copy.src, copy.dest, { recursive: true });
    console.log(`   ✓ ${copy.name}`);
  }

  console.log("\n✓ Build complete!");
  console.log(`  CLI: ${join(cliDir, "dist/cli.js")}`);
  console.log(`  Bin: ${join(cliDir, "bin/deus.js")}`);
  console.log(`  Bundles: ${bundlesDir}`);
  console.log("\nTo test locally:");
  console.log("  node apps/cli/bin/deus.js start");
  console.log("\nTo publish:");
  console.log("  cd apps/cli && bun publish");
}

main().catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});
