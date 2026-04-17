// agent-server/build.ts
// esbuild script to bundle the agent-server into a single CJS file.
// Run: bunx tsx agent-server/build.ts

import { build } from "esbuild";
import * as path from "path";
import { fileURLToPath } from "url";

const agentServerDir = path.dirname(fileURLToPath(import.meta.url));

build({
  entryPoints: [path.join(agentServerDir, "index.ts")],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outfile: path.join(agentServerDir, "dist", "index.bundled.cjs"),
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
    // Codex SDK and native binary — externalized because:
    // - @openai/codex contains platform-specific native Rust binaries
    // - @openai/codex-sdk is ESM-only and uses import.meta.url at module init,
    //   which esbuild can't shim in CJS output. Our handler uses dynamic import()
    //   to load it at runtime (CJS can dynamic-import ESM in modern Node.js).
    "@openai/codex",
    "@openai/codex-sdk",
    // @napi-rs/canvas — native Skia binary for canvas rendering.
    // Must be external since it contains platform-specific .node files.
    "@napi-rs/canvas",
    "@napi-rs/canvas-darwin-arm64",
    // ws — WebSocket library with optional native extensions (bufferutil,
    // utf-8-validate). Externalized so the runtime can resolve the correct
    // platform-specific binaries.
    "ws",
    // Sentry — optional dependency, loaded at runtime if DSN is configured
    "@sentry/node",
    // device-use — ESM-only package with native Swift binary (simbridge).
    // Uses import.meta.url internally which fails in CJS. Loaded via dynamic
    // import() in sim-ops.ts at runtime.
    "device-use",
  ],
  minify: false,
  sourcemap: false,
  logLevel: "info",
})
  .then(() => {
    console.log("Agent-server build complete!");
  })
  .catch((error) => {
    console.error("Build failed:", error);
    process.exit(1);
  });
