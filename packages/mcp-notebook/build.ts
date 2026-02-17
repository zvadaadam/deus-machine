// packages/mcp-notebook/build.ts
// esbuild script to bundle the notebook MCP server into a single CJS file.
// Output: src-tauri/resources/bin/notebook-server.bundled.cjs
// Run: bunx tsx packages/mcp-notebook/build.ts

import { build } from "esbuild";
import * as path from "path";

const pkgDir = path.dirname(new URL(import.meta.url).pathname);

build({
  entryPoints: [path.join(pkgDir, "src", "server.ts")],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  // Resolve modules from the package directory (not CWD) so deps are found
  // even when build is invoked from a parent directory or root repo
  absWorkingDir: pkgDir,
  nodePaths: [path.join(pkgDir, "node_modules")],
  outfile: path.join(pkgDir, "..", "..", "src-tauri", "resources", "bin", "notebook-server.bundled.cjs"),
  external: [
    "net",
    "fs",
    "path",
    "os",
    "util",
    "child_process",
    "string_decoder",
    "crypto",
    "events",
    "stream",
    "buffer",
    "tty",
    "url",
    "http",
    "https",
    "vm",
    "module",
  ],
  minify: false,
  sourcemap: false,
  logLevel: "info",
})
  .then(() => {
    console.log("Notebook MCP server build complete!");
  })
  .catch((error) => {
    console.error("Build failed:", error);
    process.exit(1);
  });
