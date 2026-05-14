// agent-server/build.ts
// Bundle the agent-server into a single CJS file with Bun's native bundler.

import * as path from "path";
import { fileURLToPath } from "url";

const agentServerDir = path.dirname(fileURLToPath(import.meta.url));

const external = [
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
  // Runtime packages with native/platform-specific loading.
  "@openai/codex",
  "@openai/codex-sdk",
  "@napi-rs/canvas",
  "@napi-rs/canvas-darwin-arm64",
  "@napi-rs/canvas-darwin-x64",
  "ws",
  "@sentry/node",
  "device-use",
];

const result = Bun.spawnSync({
  cmd: [
    "bun",
    "build",
    path.join(agentServerDir, "index.ts"),
    "--target=node",
    "--format=cjs",
    "--sourcemap=none",
    `--outfile=${path.join(agentServerDir, "dist", "index.bundled.cjs")}`,
    ...external.flatMap((dependency) => ["--external", dependency]),
  ],
  stdout: "inherit",
  stderr: "inherit",
});

if (result.exitCode !== 0) {
  console.error("Build failed");
  process.exit(1);
}

console.log("Agent-server build complete!");
