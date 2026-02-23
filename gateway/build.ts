// gateway/build.ts
// esbuild script to bundle the gateway into a single CJS file.
// Run: bunx tsx gateway/build.ts
// Mirrors sidecar/build.ts — see that file for pattern reference.

import { build } from "esbuild";
import * as path from "path";

const gatewayDir = path.dirname(new URL(import.meta.url).pathname);

build({
  entryPoints: [path.join(gatewayDir, "index.ts")],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outfile: path.join(gatewayDir, "..", "src-tauri", "resources", "bin", "gateway.bundled.cjs"),
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
    // Baileys uses platform-specific crypto binaries for WhatsApp encryption
    "@whiskeysockets/baileys",
    "@hapi/boom",
  ],
  minify: false,
  sourcemap: false,
  logLevel: "info",
})
  .then(() => {
    console.log("Gateway build complete!");
  })
  .catch((error) => {
    console.error("Build failed:", error);
    process.exit(1);
  });
