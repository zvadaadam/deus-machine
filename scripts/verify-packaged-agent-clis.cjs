const { verifyPackagedAgentClis } = require("./prune-pencil-cli-binaries.cjs");

module.exports = async function afterSign(context) {
  verifyPackagedAgentClis(context, { runVersionChecks: false });
};
