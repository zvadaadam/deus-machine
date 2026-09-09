const { verifyPackagedAgentClis } = require("./runtime/electron-builder-after-pack.cjs");

module.exports = async function afterSign(context) {
  await verifyPackagedAgentClis(context, {
    verifyManifestHashes: false,
    runVersionChecks: process.env.DEUS_VERIFY_PACKAGED_BIN_RUNNABLE === "1",
  });
};
