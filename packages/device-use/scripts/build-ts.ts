#!/usr/bin/env bun
// Bundles the engine into dist/engine.js, which the backend imports and
// `bun build --compile` folds into deus-runtime.
import { existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = join(root, "dist");

if (existsSync(distDir)) rmSync(distDir, { recursive: true });

const result = await Bun.build({
  entrypoints: [join(root, "src/engine/index.ts")],
  outdir: distDir,
  naming: "engine.js",
  target: "bun",
  format: "esm",
  splitting: false,
  sourcemap: "external",
});

if (!result.success) {
  console.error("Build failed for src/engine/index.ts:");
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

console.log("  ✓ dist/engine.js");
