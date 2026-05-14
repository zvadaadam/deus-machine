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
];

const result = Bun.spawnSync({
  cmd: [
    "bun",
    "build",
    path.join(backendDir, "src/server.ts"),
    "--target=node",
    "--format=cjs",
    "--sourcemap=none",
    `--outfile=${path.join(backendDir, "dist/server.bundled.cjs")}`,
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
