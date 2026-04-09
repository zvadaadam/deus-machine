// apps/backend/build.ts
// esbuild script to bundle the backend into a single CJS file for production.
// Run: bunx tsx apps/backend/build.ts

import { build } from "esbuild";
import * as path from "path";
import { fileURLToPath } from "url";

const backendDir = path.dirname(fileURLToPath(import.meta.url));

build({
  entryPoints: [path.join(backendDir, "src/server.ts")],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  outfile: path.join(backendDir, "dist/server.bundled.cjs"),
  external: [
    // Native modules — must be resolved at runtime (compiled against Electron's ABI)
    "better-sqlite3",
    "node-pty",
    // WebSocket library with optional native extensions
    "ws",
    // Sentry — uses native crash-reporter hooks, must match runtime
    "@sentry/node",
  ],
  minify: false,
  sourcemap: false,
  logLevel: "info",
  // Resolve @shared/* path alias
  alias: {
    "@shared": path.join(backendDir, "../../shared"),
  },
})
  .then(() => {
    console.log("Backend build complete!");
  })
  .catch((error) => {
    console.error("Backend build failed:", error);
    process.exit(1);
  });
