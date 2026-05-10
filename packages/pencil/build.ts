// packages/pencil/build.ts
//
// Two esbuild bundles: the Node launcher (src/serve.ts → dist/serve.js)
// and the browser-side iframe controller (src/ui/app.ts → dist/ui/app.js).
// Static assets (parent.html, styles.css) are copied as-is.
//
// Run with: `bun run build` from the package root, or `bunx tsx build.ts`.

import esbuild from "esbuild";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const distDir = join(root, "dist");

rmSync(distDir, { recursive: true, force: true });
mkdirSync(join(distDir, "ui"), { recursive: true });

// ---- Node launcher --------------------------------------------------------
//
// Bundle into a single ESM file. Mark @pencil.dev/cli as external so we
// dynamically resolve its package.json at runtime via require.resolve()
// rather than baking a path into the bundle. The banner injects a CommonJS
// `require` so we can keep using `require.resolve()` from ESM.
await esbuild.build({
  entryPoints: [join(root, "src/serve.ts")],
  bundle: true,
  platform: "node",
  target: "node18",
  format: "esm",
  outfile: join(distDir, "serve.js"),
  external: ["@pencil.dev/cli", "@aws-sdk/client-s3", "bufferutil", "utf-8-validate"],
  banner: {
    js: "import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);\n",
  },
  logLevel: "info",
});

// ---- Browser iframe controller -------------------------------------------
//
// Browser target with DOM types. Single-file bundle so the iframe loads
// one script tag.
await esbuild.build({
  entryPoints: [join(root, "src/ui/app.ts")],
  bundle: true,
  platform: "browser",
  target: "es2022",
  format: "esm",
  outfile: join(distDir, "ui/app.js"),
  logLevel: "info",
});

// ---- Static assets --------------------------------------------------------
copyFileSync(join(root, "src/ui/parent.html"), join(distDir, "ui/parent.html"));
copyFileSync(join(root, "src/ui/styles.css"), join(distDir, "ui/styles.css"));

console.log("[pencil] build complete");
