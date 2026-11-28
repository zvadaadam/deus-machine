// Readies the native modules a backend running from source loads on the
// system Node (`bun run dev`, `dev:web`, the backend tests and e2e runners).
// better-sqlite3 (13+) ships Node-API prebuilds across platforms and node-pty
// ships prebuilds on macOS and Windows (Linux builds node-pty itself once).
// Both are ABI-stable across Node majors once built, so nothing here compiles.
const fs = require("node:fs");
const path = require("node:path");

const PROJECT_ROOT = path.resolve(__dirname, "../..");

// node-pty 1.1's published prebuilds ship spawn-helper without its executable
// bit, so every terminal fails with "posix_spawnp failed" until it is set.
const ptyPrebuilds = path.join(PROJECT_ROOT, "node_modules", "node-pty", "prebuilds");
for (const target of fs.existsSync(ptyPrebuilds) ? fs.readdirSync(ptyPrebuilds) : []) {
  const helper = path.join(ptyPrebuilds, target, "spawn-helper");
  if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755);
}

const REQUIRED_NAPI = 10;
const napi = Number(process.versions.napi);
if (!Number.isFinite(napi) || napi < REQUIRED_NAPI) {
  console.error(
    `[native:node] better-sqlite3 requires Node-API ${REQUIRED_NAPI} (Node 22.14+ or 23.6+), ` +
      `but this process is Node ${process.version} (Node-API ${process.versions.napi ?? "unknown"}).\n` +
      "  Upgrade Node (brew install node, or fnm/mise); `bun run doctor` checks the rest."
  );
  process.exit(1);
}

try {
  require("better-sqlite3")(":memory:").close();
} catch (error) {
  console.error(
    `[native:node] better-sqlite3 cannot open a database under Node ${process.version} ` +
      `(${process.platform}-${process.arch}): ${error.message}\n` +
      "  Run `bun run setup` again; `bun run doctor` checks the rest."
  );
  process.exit(1);
}
