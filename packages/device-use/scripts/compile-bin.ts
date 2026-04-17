#!/usr/bin/env bun
/**
 * Compile device-use into a single-file executable using `bun build --compile`.
 *
 * Note: the simbridge Swift binary is a separate executable that must ship
 * alongside the compiled device-use binary. We copy it into bin/ here.
 */
import { existsSync, copyFileSync, mkdirSync, readFileSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { $ } from "bun";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const binDir = join(root, "bin");

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
const version = pkg.version as string;

mkdirSync(binDir, { recursive: true });

const target = process.argv[2] ?? "bun-darwin-arm64";
const outPath = join(binDir, "device-use");

console.log(`[compile] target=${target}`);
console.log(`[compile] building ${outPath}...`);

const versionDefine = `__VERSION__=${JSON.stringify(version)}`;
await $`bun build --compile --target=${target} --define ${versionDefine} --outfile ${outPath} ${join(root, "src/cli/index.ts")}`;

const bridgeSrc = join(root, "native/.build/release/simbridge");
const bridgeDest = join(binDir, "simbridge");

if (!existsSync(bridgeSrc)) {
  console.warn(`[compile] simbridge not built yet at ${bridgeSrc}`);
  console.warn("[compile] run: bun run build:native");
  process.exit(1);
}

copyFileSync(bridgeSrc, bridgeDest);
chmodSync(bridgeDest, 0o755);
chmodSync(outPath, 0o755);

console.log(`[compile] done`);
console.log(`  device-use: ${outPath}`);
console.log(`  simbridge:  ${bridgeDest}`);
console.log(`\nTest: ${outPath} list`);
