// build-inject.ts
// Compiles browser inject scripts from TypeScript to self-contained IIFE strings.
// Run: bunx tsx src/features/browser/automation/build-inject.ts
//
// These scripts run inside WKWebView page context (not the React app).
// esbuild compiles each into a browser-ready IIFE that can be eval'd.
// The compiled output is imported via Vite's ?raw import.
//
// Follows the same pattern as sidecar/build.ts.

import { build } from "esbuild";
import * as path from "path";
import * as fs from "fs";

const automationDir = path.dirname(new URL(import.meta.url).pathname);
const injectDir = path.join(automationDir, "inject");
const outDir = path.join(automationDir, "dist-inject");

// Ensure output directory exists
fs.mkdirSync(outDir, { recursive: true });

// Find all .ts files in inject/ directory
const entryPoints = fs
  .readdirSync(injectDir)
  .filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts") && f !== "tsconfig.json")
  .map((f) => path.join(injectDir, f));

if (entryPoints.length === 0) {
  console.warn("No inject scripts found in", injectDir);
  process.exit(0);
}

console.log(`Building ${entryPoints.length} inject script(s)...`);

build({
  entryPoints,
  bundle: true,
  format: "iife",
  target: "es2020",
  platform: "browser",
  minify: false, // Keep readable for WebView DevTools debugging
  outdir: outDir,
  logLevel: "info",
})
  .then(() => {
    console.log(`Inject scripts built to ${outDir}`);

    // Touch the re-exporter files that import dist-inject/*.js via ?raw.
    // dist-inject/ is gitignored, so Vite's file watcher doesn't detect
    // changes there. Touching the re-exporters forces Vite HMR to
    // invalidate the ?raw imports and serve the fresh compiled output.
    const reExporters = fs
      .readdirSync(automationDir)
      .filter((f) => f.endsWith(".ts") && f !== "build-inject.ts")
      .map((f) => path.join(automationDir, f));

    for (const file of reExporters) {
      const content = fs.readFileSync(file, "utf-8");
      if (content.includes("dist-inject/")) {
        const now = new Date();
        fs.utimesSync(file, now, now);
        console.log(`  Touched ${path.basename(file)} (Vite HMR trigger)`);
      }
    }
  })
  .catch((error) => {
    console.error("Inject build failed:", error);
    process.exit(1);
  });
