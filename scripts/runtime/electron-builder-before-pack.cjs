const { execFileSync } = require("node:child_process");
const { existsSync, readdirSync, statSync } = require("node:fs");
const path = require("node:path");
const { Arch } = require("builder-util");
const ARCH_BY_BUILDER_VALUE = new Map([
  [Arch.x64, "x64"],
  [Arch.arm64, "arm64"],
  ["x64", "x64"],
  ["arm64", "arm64"],
]);

const SOURCE_EXTENSIONS = new Set([
  ".cjs",
  ".css",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".mjs",
  ".svg",
  ".ts",
  ".tsx",
]);

function relativeFromProjectRoot(projectRoot, targetPath) {
  return path.relative(projectRoot, targetPath).split(path.sep).join("/");
}

function latestSourceMtime(projectRoot, sourceRelatives) {
  let latest = { mtimeMs: 0, path: null };

  function visit(sourcePath) {
    if (!existsSync(sourcePath)) return;
    const stat = statSync(sourcePath);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(sourcePath, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "out") {
          continue;
        }
        visit(path.join(sourcePath, entry.name));
      }
      return;
    }

    if (!SOURCE_EXTENSIONS.has(path.extname(sourcePath))) return;
    if (stat.mtimeMs > latest.mtimeMs) {
      latest = { mtimeMs: stat.mtimeMs, path: sourcePath };
    }
  }

  for (const sourceRelative of sourceRelatives) {
    visit(path.join(projectRoot, sourceRelative));
  }

  return latest;
}

function assertBuildOutputFresh(projectRoot, label, outputRelative, sourceRelatives) {
  const outputPath = path.join(projectRoot, outputRelative);
  if (!existsSync(outputPath)) {
    throw new Error(
      `Missing Electron ${label} build output: ${outputRelative}. Run \`bun run build\`.`
    );
  }

  const outputStat = statSync(outputPath);
  const latestSource = latestSourceMtime(projectRoot, sourceRelatives);
  if (latestSource.path && outputStat.mtimeMs < latestSource.mtimeMs) {
    throw new Error(
      `Stale Electron ${label} build output: ${outputRelative} is older than ${relativeFromProjectRoot(
        projectRoot,
        latestSource.path
      )}. Run \`bun run build\` before packaging.`
    );
  }
}

function assertElectronBuildFresh(projectRoot) {
  assertBuildOutputFresh(projectRoot, "main", "out/main/index.js", [
    "apps/desktop/main",
    "shared",
    "electron.vite.config.ts",
    "package.json",
  ]);
  assertBuildOutputFresh(projectRoot, "preload", "out/preload/index.mjs", [
    "apps/desktop/preload",
    "shared",
    "electron.vite.config.ts",
    "package.json",
  ]);
  assertBuildOutputFresh(projectRoot, "preload", "out/preload/browser-preload.mjs", [
    "apps/desktop/preload",
    "shared",
    "electron.vite.config.ts",
    "package.json",
  ]);
  assertBuildOutputFresh(projectRoot, "renderer", "out/renderer/index.html", [
    "apps/web/index.html",
    "apps/web/src",
    "shared",
    "electron.vite.config.ts",
    "package.json",
  ]);
}

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

  assertElectronBuildFresh(projectRoot);

  if (context?.electronPlatformName !== "darwin") return;

  const arch = ARCH_BY_BUILDER_VALUE.get(context.arch);
  if (!arch) {
    throw new Error(`Unsupported macOS packaging architecture: ${String(context.arch)}`);
  }
  const binDir = path.join(projectRoot, "dist", "runtime", "electron", "bin", `darwin-${arch}`);
  const requiredBins = [
    ["GitHub CLI", "gh", "bun run prepare:gh-cli"],
    ["Deus runtime", "deus-runtime", "bun run build:runtime"],
    ["Codex CLI", "codex", "bun run prepare:agent-clis"],
    ["Claude CLI", "claude", "bun run prepare:agent-clis"],
    ["ripgrep for Codex", "rg", "bun run prepare:agent-clis"],
  ];

  for (const [label, name, command] of requiredBins) {
    const binPath = path.join(binDir, name);
    if (!existsSync(binPath)) {
      throw new Error(
        `Missing bundled ${label} for darwin-${arch}: ${binPath}. Run \`${command}\` before packaging.`
      );
    }
  }
};
