const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { assertPackagedMainRuntimeContract } = require("./electron-builder-before-pack.cjs");

const PROJECT_ROOT = path.resolve(__dirname, "../..");
const EXTERNALS = [
  "electron",
  "better-sqlite3",
  "node-pty",
  "ws",
  "device-use",
  "device-use/engine",
];

function buildCurrentMainToTemp(outputPath) {
  execFileSync(
    "bun",
    [
      "build",
      "apps/desktop/main/index.ts",
      "--target=node",
      "--format=esm",
      `--outfile=${outputPath}`,
      ...EXTERNALS.flatMap((name) => ["--external", name]),
    ],
    {
      cwd: PROJECT_ROOT,
      stdio: "inherit",
    }
  );
}

function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "deus-desktop-main-runtime-"));
  try {
    const outputPath = path.join(tempRoot, "out", "main", "index.js");
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    buildCurrentMainToTemp(outputPath);
    assertPackagedMainRuntimeContract(tempRoot);
    console.log("[runtime-smoke] current desktop main source has packaged runtime contract");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main();
