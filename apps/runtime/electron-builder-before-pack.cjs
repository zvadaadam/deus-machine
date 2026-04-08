const { execFileSync } = require("node:child_process");
const path = require("node:path");

module.exports = function beforePack() {
  try {
    execFileSync("bun", ["run", "validate:runtime"], {
      cwd: path.resolve(__dirname, "../.."),
      stdio: "inherit",
    });
  } catch {
    throw new Error("Staged runtime validation failed. Run `bun run build:runtime` before packaging.");
  }
};
