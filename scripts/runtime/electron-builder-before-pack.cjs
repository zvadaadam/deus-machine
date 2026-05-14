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
  assertBundledCli(projectRoot, arch, "gh", "GitHub CLI", "prepare:gh-cli");
  assertBundledCli(projectRoot, arch, "codex", "Codex CLI", "prepare:agent-clis");
  assertBundledCli(projectRoot, arch, "claude", "Claude Code CLI", "prepare:agent-clis");
};

function assertBundledCli(projectRoot, arch, binaryName, displayName, prepareScript) {
  const cliPath = path.join(
    projectRoot,
    "dist",
    "runtime",
    "electron",
    "bin",
    `darwin-${arch}`,
    binaryName
  );
  if (!existsSync(cliPath)) {
    throw new Error(
      `Missing bundled ${displayName} for darwin-${arch}: ${cliPath}. Run \`bun run ${prepareScript}\` before packaging.`
    );
  }
}
