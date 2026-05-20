const path = require("node:path");
const { execFileSync } = require("node:child_process");

const DEVICE_USE_PACKAGE_FILES = Object.freeze([
  ["device-use manifest", "agentic-app.json"],
  ["device-use package metadata", "package.json"],
  ["device-use CLI bundle", "dist/cli.js"],
  ["device-use engine bundle", "dist/engine.js"],
  ["device-use server bundle", "dist/server/index.js"],
  ["device-use frontend bundle", "dist/frontend/index.html"],
  ["device-use skill", "skills/device-use/SKILL.md"],
]);

const DEVICE_USE_HELPER_NAMES = Object.freeze({
  simbridge: "simbridge",
  siminspector: "siminspector.dylib",
});

function deviceUsePackageRoot(projectRoot) {
  return path.join(projectRoot, "packages", "device-use");
}

function packagedDeviceUseRoot(resourcesDir) {
  return path.join(resourcesDir, "agentic-apps", "device-use");
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
  DEVICE_USE_HELPER_NAMES,
  DEVICE_USE_PACKAGE_FILES,
  assertNoBuildLocalInstallName,
  deviceUsePackageRoot,
  packagedDeviceUseRoot,
  packagedSimulatorDir,
};
