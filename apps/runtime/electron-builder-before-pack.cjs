const { execFileSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const path = require("node:path");
const { Arch } = require("builder-util");

module.exports = function beforePack(context) {
  const projectRoot = path.resolve(__dirname, "../..");

  try {
    execFileSync("bun", ["run", "validate:runtime"], {
      cwd: projectRoot,
      stdio: "inherit",
    });
  } catch {
    throw new Error(
      "Staged runtime validation failed. Run `bun run build:runtime` before packaging."
    );
  }

  if (context?.electronPlatformName !== "darwin") return;

  const arch = Arch[context.arch];
  const ghPath = path.join(
    projectRoot,
    "dist",
    "runtime",
    "electron",
    "bin",
    `darwin-${arch}`,
    "gh"
  );
  if (!existsSync(ghPath)) {
    throw new Error(
      `Missing bundled GitHub CLI for darwin-${arch}: ${ghPath}. Run \`bun run prepare:gh-cli\` before packaging.`
    );
  }
};
