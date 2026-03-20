// packages/mcp-notebook/build.ts
// esbuild script to bundle the notebook MCP server into a single CJS file.
// Output: packages/mcp-notebook/dist/notebook-server.bundled.cjs
// Run: bunx tsx packages/mcp-notebook/build.ts

import { build } from "esbuild";
import * as path from "path";
import { fileURLToPath } from "node:url";

const pkgDir = path.dirname(fileURLToPath(import.meta.url));

(async () => {
  try {
    await build({
      entryPoints: [path.join(pkgDir, "src", "server.ts")],
      bundle: true,
      platform: "node",
      target: "node20",
      format: "cjs",
      // Resolve modules from the package directory (not CWD) so deps are found
      // even when build is invoked from a parent directory or root repo
      absWorkingDir: pkgDir,
      nodePaths: [path.join(pkgDir, "node_modules")],
      outfile: path.join(pkgDir, "dist", "notebook-server.bundled.cjs"),
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
    });
    console.log("Notebook MCP server build complete!");
  } catch (error) {
    console.error("Build failed:", error);
    process.exit(1);
  }
})();
