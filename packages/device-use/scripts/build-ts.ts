#!/usr/bin/env bun
import { readFileSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const distDir = join(root, "dist");

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
const version = pkg.version as string;

if (existsSync(distDir)) rmSync(distDir, { recursive: true });

const entries = [
  { entry: "src/cli/index.ts", out: "dist/cli.js", shebang: true },
  { entry: "src/engine/index.ts", out: "dist/engine.js", shebang: false },
];

for (const { entry, out, shebang } of entries) {
  const result = await Bun.build({
    entrypoints: [join(root, entry)],
    outdir: join(root, dirname(out)),
    naming: out.split("/").pop()!,
    target: "bun",
    format: "esm",
    splitting: false,
    sourcemap: "external",
    define: { __VERSION__: JSON.stringify(version) },
    banner: shebang ? "#!/usr/bin/env bun" : undefined,
  });

  if (!result.success) {
    console.error(`Build failed for ${entry}:`);
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
  console.log(`  ✓ ${out}`);
}

// Make cli.js executable
try {
  const { chmodSync } = await import("node:fs");
  chmodSync(join(root, "dist/cli.js"), 0o755);
} catch {
  // ignore
}

console.log("\nTS build complete.");
