// apps/backend/build.ts
// Bundle the backend into a single CJS file for production with Bun's native bundler.

import * as path from "path";
import { fileURLToPath } from "url";

const backendDir = path.dirname(fileURLToPath(import.meta.url));

const external = [
  // Native modules are resolved at runtime against the active Node/Electron ABI.
  "better-sqlite3",
  "node-pty",
  // WebSocket library with optional native extensions.
  "ws",
  // Sentry uses native crash-reporter hooks.
  "@sentry/node",
  // The Claude SDK resolves its platform package at runtime. Canvas loads native code.
  "@anthropic-ai/claude-agent-sdk",
  "@napi-rs/canvas",
  "@napi-rs/canvas-darwin-arm64",
  "@napi-rs/canvas-darwin-x64",
];

const IMPORT_META_URL = "__deusBundleUrl";

const result = Bun.spawnSync({
  cmd: [
    "bun",
    "build",
    path.join(backendDir, "src/server.ts"),
    "--target=node",
    "--format=cjs",
    "--sourcemap=none",
    `--outfile=${path.join(backendDir, "dist/server.bundled.cjs")}`,
    // `import.meta.url` (createRequire in lib/sqlite.ts and pty.service.ts)
    // has no meaning in CommonJS: Bun 1.2 leaves it as written, which Node
    // cannot parse, and Bun 1.3 writes in the build machine's path, from
    // which the external packages are not found. Give it the bundle's own
    // URL, so they resolve from wherever the bundle is installed.
    "--define",
    `import.meta.url=${IMPORT_META_URL}`,
    "--banner",
    `var ${IMPORT_META_URL} = require("node:url").pathToFileURL(__filename).href;`,
    ...external.flatMap((dependency) => ["--external", dependency]),
  ],
  stdout: "inherit",
  stderr: "inherit",
});

if (result.exitCode !== 0) {
  console.error("Backend build failed");
  process.exit(1);
}

console.log("Backend build complete!");
