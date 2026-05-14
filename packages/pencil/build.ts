// packages/pencil/build.ts
//
// Two Bun bundles: the Node launcher (src/serve.ts -> dist/serve.js)
// and the browser-side iframe controller (src/ui/app.ts -> dist/ui/app.js).
// Static assets (parent.html, styles.css) are copied as-is.
//
// Run with: `bun run build` from the package root.

import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

declare const Bun: {
  build(options: {
    entrypoints: string[];
    outdir: string;
    naming: string;
    bundle?: boolean;
    target?: "browser" | "node" | "bun";
    format?: "esm" | "cjs";
    external?: string[];
  }): Promise<{ success: boolean; logs: unknown[] }>;
};

const root = dirname(fileURLToPath(import.meta.url));
const distDir = join(root, "dist");

rmSync(distDir, { recursive: true, force: true });
mkdirSync(join(distDir, "ui"), { recursive: true });

// ---- Node launcher --------------------------------------------------------
//
// Bundle into a single ESM file. Mark @pencil.dev/cli as external so we
// dynamically resolve its package.json at runtime via require.resolve()
// rather than baking a path into the bundle. Bun rewrites that CommonJS
// lookup for the emitted ESM bundle.
const serveBuild = await Bun.build({
  entrypoints: [join(root, "src/serve.ts")],
  bundle: true,
  target: "node",
  format: "esm",
  outdir: distDir,
  naming: "serve.js",
  external: ["@pencil.dev/cli", "@aws-sdk/client-s3", "bufferutil", "utf-8-validate"],
});
if (!serveBuild.success) {
  console.error(serveBuild.logs);
  process.exit(1);
}

// ---- Browser iframe controller -------------------------------------------
//
// Browser target with DOM types. Single-file bundle so the iframe loads
// one script tag.
const uiBuild = await Bun.build({
  entrypoints: [join(root, "src/ui/app.ts")],
  bundle: true,
  target: "browser",
  format: "esm",
  outdir: join(distDir, "ui"),
  naming: "app.js",
});
if (!uiBuild.success) {
  console.error(uiBuild.logs);
  process.exit(1);
}

// ---- Static assets --------------------------------------------------------
copyFileSync(join(root, "src/ui/parent.html"), join(distDir, "ui/parent.html"));
copyFileSync(join(root, "src/ui/styles.css"), join(distDir, "ui/styles.css"));

console.log("[pencil] build complete");
