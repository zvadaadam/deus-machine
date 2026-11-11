const path = require("node:path");
const { execFileSync } = require("node:child_process");

// What a packaged app takes from packages/device-use: the engine, which
// `bun build --compile` folds into deus-runtime, and the two native helpers
// under Resources/simulator.
const DEVICE_USE_ENGINE_BUNDLE = "dist/engine.js";

const DEVICE_USE_HELPER_NAMES = Object.freeze({
  simbridge: "simbridge",
  siminspector: "siminspector.dylib",
});

function deviceUsePackageRoot(projectRoot) {
  return path.join(projectRoot, "packages", "device-use");
}

function packagedSimulatorDir(resourcesDir) {
  return path.join(resourcesDir, "simulator");
}

function parseInstallNames(output) {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.endsWith(":"));
}

function assertNoBuildLocalInstallName(filePath, projectRoot, label) {
  const output = execFileSync("otool", ["-D", filePath], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const installNames = parseInstallNames(output);
  const hasBuildLocalName = installNames.some(
    (line) => line.includes(projectRoot) || line.includes(".build")
  );
  if (hasBuildLocalName) {
    throw new Error(`${label} has a build-local install name: ${output.trim()}`);
  }
}

module.exports = {
  DEVICE_USE_ENGINE_BUNDLE,
  DEVICE_USE_HELPER_NAMES,
  assertNoBuildLocalInstallName,
  deviceUsePackageRoot,
  packagedSimulatorDir,
};
