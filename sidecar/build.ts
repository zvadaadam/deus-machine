// sidecar/build.ts
// esbuild script to bundle the sidecar into a single CJS file.
// Run: bunx tsx sidecar/build.ts

import { build } from "esbuild";
import * as path from "path";

const sidecarDir = path.dirname(new URL(import.meta.url).pathname);

build({
  entryPoints: [path.join(sidecarDir, "index.ts")],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outfile: path.join(sidecarDir, "..", "src-tauri", "resources", "bin", "index.bundled.cjs"),
  external: [
    // Node.js built-ins
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
    // Heavy native dependencies — loaded at runtime
    "better-sqlite3",
    // Codex SDK and native binary — externalized because:
    // - @openai/codex contains platform-specific native Rust binaries
    // - @openai/codex-sdk is ESM-only and uses import.meta.url at module init,
    //   which esbuild can't shim in CJS output. Our handler uses dynamic import()
    //   to load it at runtime (CJS can dynamic-import ESM in modern Node.js).
    "@openai/codex",
    "@openai/codex-sdk",
    // ws — WebSocket library with optional native extensions (bufferutil,
    // utf-8-validate). Externalized so the runtime can resolve the correct
    // platform-specific binaries.
    "ws",
    // Sentry — optional dependency, loaded at runtime if DSN is configured
    "@sentry/node",
  ],
  minify: false,
  sourcemap: false,
  logLevel: "info",
})
  .then(() => {
    console.log("Sidecar-v2 build complete!");
  })
  .catch((error) => {
    console.error("Build failed:", error);
    process.exit(1);
  });
