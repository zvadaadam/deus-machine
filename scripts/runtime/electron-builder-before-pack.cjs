const { existsSync } = require("node:fs");
const path = require("node:path");
const { DEVICE_USE_ENGINE_BUNDLE, deviceUsePackageRoot } = require("./lib/device-use-payloads.cjs");

// `bun build --compile` folds the device-use engine into deus-runtime; the
// simulator helpers are checked in the packaged app (afterPack).
module.exports = function beforePack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const projectRoot = path.resolve(__dirname, "../..");
  const engine = path.join(deviceUsePackageRoot(projectRoot), DEVICE_USE_ENGINE_BUNDLE);
  if (!existsSync(engine)) {
    throw new Error(
      `Missing device-use engine bundle: ${engine}. Run \`bun run prepare:device-use\`.`
    );
  }
};
