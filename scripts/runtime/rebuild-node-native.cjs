const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");

const PROJECT_ROOT = path.resolve(__dirname, "../..");
const SQLITE_ROOT = path.join(PROJECT_ROOT, "node_modules", "better-sqlite3");
const NODE_GYP = path.join(PROJECT_ROOT, "node_modules", "node-gyp", "bin", "node-gyp.js");

function commandCandidates(name) {
  const result = spawnSync("which", ["-a", name], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) return [];
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function unique(items) {
  return [...new Set(items.filter(Boolean))];
}

function pythonCandidates() {
  return unique([
    process.env.PYTHON,
    "/usr/bin/python3",
    ...commandCandidates("python3"),
    ...commandCandidates("python"),
  ]);
}

function isUsablePython(candidate) {
  try {
    execFileSync(candidate, ["-c", "import plistlib; import xml.parsers.expat"], {
      stdio: "ignore",
      timeout: 5_000,
    });
    return true;
  } catch {
    return false;
  }
}

const selectedPython = pythonCandidates().find(isUsablePython);
const env = { ...process.env };
if (selectedPython) {
  env.PYTHON = selectedPython;
  console.log(`[native:node] using Python: ${selectedPython}`);
} else {
  delete env.PYTHON;
  console.log("[native:node] no validated Python found; falling back to node-gyp discovery");
}

execFileSync(process.execPath, [NODE_GYP, "rebuild"], {
  cwd: SQLITE_ROOT,
  env,
  stdio: "inherit",
});
