#!/usr/bin/env bun
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const distDir = join(root, "dist");

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
const version = pkg.version as string;

if (existsSync(distDir)) rmSync(distDir, { recursive: true });

const entries = [
  { entry: "src/cli/index.ts", out: "dist/cli.js", executable: true },
  { entry: "src/cli/index.ts", out: "dist/cli-runtime.js", executable: false },
  { entry: "src/engine/index.ts", out: "dist/engine.js", executable: false },
  { entry: "src/server/index.ts", out: "dist/server/index.js", executable: false },
];

function makeExecutableCli(filePath: string): void {
  const source = readFileSync(filePath, "utf-8")
    .replace(/^\uFEFF/, "")
    .replace(/^#!.*\r?\n/, "");
  writeFileSync(filePath, `#!/usr/bin/env bun\n${source}`);
  chmodSync(filePath, 0o755);
}

for (const { entry, out, executable } of entries) {
  const result = await Bun.build({
    entrypoints: [join(root, entry)],
    outdir: join(root, dirname(out)),
    naming: out.split("/").pop()!,
    target: "bun",
    format: "esm",
    splitting: false,
    sourcemap: "external",
    define: { __VERSION__: JSON.stringify(version) },
  });

  if (!result.success) {
    console.error(`Build failed for ${entry}:`);
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }

  if (executable) {
    makeExecutableCli(join(root, out));
  }

  console.log(`  ✓ ${out}`);
}

console.log("\nTS build complete.");
