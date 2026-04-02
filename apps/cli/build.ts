/**
 * Build script for @deus/cli
 *
 * 1. Bundle the CLI TypeScript → dist/cli.js (esbuild)
 * 2. Copy pre-built bundles into bundles/ for distribution:
 *    - agent-server.bundled.cjs (from apps/agent-server/dist/)
 *    - server.bundled.cjs (from apps/backend/dist/)
 *
 * Prerequisites: run these from the monorepo root before building the CLI:
 *   bun run build:agent-server
 *   bun run build:backend
 */

import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { resolve, join, dirname } from "path";
import { fileURLToPath } from "url";

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
      // Native modules resolved at runtime
      "better-sqlite3",
      "node-pty",
      "ws",
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

  // Step 3: Copy bundles for distribution
  console.log("\n3. Copying bundles...");
  const bundlesDir = join(cliDir, "bundles");
  mkdirSync(bundlesDir, { recursive: true });

  const copies: { src: string; dest: string; name: string; required: boolean }[] = [
    {
      src: join(monorepoRoot, "apps/agent-server/dist/index.bundled.cjs"),
      dest: join(bundlesDir, "agent-server.bundled.cjs"),
      name: "agent-server bundle",
      required: true,
    },
    {
      src: join(monorepoRoot, "apps/backend/dist/server.bundled.cjs"),
      dest: join(bundlesDir, "server.bundled.cjs"),
      name: "backend bundle",
      required: true,
    },
  ];

  let hasErrors = false;
  for (const copy of copies) {
    if (existsSync(copy.src)) {
      cpSync(copy.src, copy.dest, { recursive: true });
      console.log(`   ✓ ${copy.name}`);
    } else if (copy.required) {
      console.error(`   ✗ ${copy.name} not found: ${copy.src}`);
      hasErrors = true;
    } else {
      console.log(`   - ${copy.name} not found (optional, server will work without UI)`);
    }
  }

  if (hasErrors) {
    console.error("\nMissing required bundles. Run these first:");
    console.error("  bun run build:agent-server");
    console.error("  bun run build:backend");
    // No web frontend needed — headless mode uses app.rundeus.com via relay
    process.exit(1);
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
