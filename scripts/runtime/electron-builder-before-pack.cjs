const { execFileSync } = require("node:child_process");
const { existsSync, readFileSync, readdirSync, statSync } = require("node:fs");
const path = require("node:path");
const { Arch } = require("builder-util");
const ARCH_BY_BUILDER_VALUE = new Map([
  [Arch.x64, "x64"],
  [Arch.arm64, "arm64"],
  ["x64", "x64"],
  ["arm64", "arm64"],
]);
const SUPPORTED_PACKAGED_RUNTIME_PLATFORM = "darwin";

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

function outputTreeContains(projectRoot, outputRelative, expectedText) {
  const outputPath = path.join(projectRoot, outputRelative);
  if (!existsSync(outputPath)) return false;

  const stat = statSync(outputPath);
  if (stat.isDirectory()) {
    for (const entry of readdirSync(outputPath, { withFileTypes: true })) {
      const entryRelative = path.join(outputRelative, entry.name);
      if (entry.isDirectory() && outputTreeContains(projectRoot, entryRelative, expectedText)) {
        return true;
      }
      if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
        const contents = readFileSync(path.join(projectRoot, entryRelative), "utf8");
        if (contents.includes(expectedText)) return true;
      }
    }
    return false;
  }

  const contents = readFileSync(outputPath, "utf8");
  return contents.includes(expectedText);
}

function assertOutputTreeContains(projectRoot, label, outputRelative, expectedText) {
  const outputPath = path.join(projectRoot, outputRelative);
  if (!existsSync(outputPath)) {
    throw new Error(
      `Missing Electron ${label} build output: ${outputRelative}. Run \`bun run build\`.`
    );
  }

  if (!outputTreeContains(projectRoot, outputRelative, expectedText)) {
    throw new Error(
      `Electron ${label} build output does not contain ${expectedText}. Run \`bun run build\`.`
    );
  }
}

function assertElectronBuildVersion(projectRoot) {
  const packageJson = JSON.parse(readFileSync(path.join(projectRoot, "package.json"), "utf8"));
  if (!packageJson.version) {
    throw new Error("package.json is missing version");
  }
  assertOutputTreeContains(projectRoot, "renderer", "out/renderer", String(packageJson.version));
}

function assertElectronBuildFresh(projectRoot) {
  assertBuildOutputFresh(projectRoot, "main", "out/main/index.js", [
    "apps/desktop/main",
    "shared",
    "electron.vite.config.ts",
  ]);
  assertBuildOutputFresh(projectRoot, "preload", "out/preload/index.mjs", [
    "apps/desktop/preload",
    "shared",
    "electron.vite.config.ts",
  ]);
  assertBuildOutputFresh(projectRoot, "preload", "out/preload/browser-preload.mjs", [
    "apps/desktop/preload",
    "shared",
    "electron.vite.config.ts",
  ]);
  assertBuildOutputFresh(projectRoot, "renderer", "out/renderer/index.html", [
    "apps/web/index.html",
    "apps/web/src",
    "shared",
    "electron.vite.config.ts",
  ]);
  assertElectronBuildVersion(projectRoot);
}

function assertPackagedMainRuntimeContents(contents, label = "Electron main build output") {
  const requiredSnippets = [
    'process.resourcesPath, "bin", "deus-runtime"',
    "DEUS_RUNTIME_EXECUTABLE",
    "configurePackagedMainRuntimeEnv",
    "PACKAGED_RUNTIME_ENV_DENYLIST",
    '"AUTH_TOKEN"',
    '"DATABASE_PATH"',
    '"DEUS_AUTH_TOKEN"',
    '"DEUS_BUNDLED_BIN_DIR"',
    '"DEUS_BACKEND_PORT"',
    '"DEUS_DATA_DIR"',
    '"PORT"',
    'runtime.runtimeExecutable ? ["backend"]',
    "PACKAGED_BUNDLED_TOOLS",
    "CLI_CHILD_ENV_DENYLIST",
    "PACKAGED_TERMINAL_TOOLS",
  ];

  for (const snippet of requiredSnippets) {
    if (contents.includes(snippet)) continue;
    throw new Error(
      `${label} does not contain packaged runtime contract snippet: ${snippet}. Run \`bun run build\` before packaging.`
    );
  }

  if (
    contents.includes('process.resourcesPath, "backend"') ||
    contents.includes("process.resourcesPath, 'backend'")
  ) {
    throw new Error(
      `${label} still contains the obsolete packaged backend bundle path. Run \`bun run build\` before packaging.`
    );
  }

  if (contents.includes("runtime.nodePath") || contents.includes("NODE_PATH: runtime.nodePath")) {
    throw new Error(
      `${label} still contains obsolete packaged NODE_PATH plumbing. Run \`bun run build\` before packaging.`
    );
  }
}

function assertPackagedMainRuntimeContract(projectRoot) {
  const mainOutput = path.join(projectRoot, "out/main/index.js");
  const contents = readFileSync(mainOutput, "utf8");
  assertPackagedMainRuntimeContents(contents);
}

function assertPackagedRuntimePlatform(context) {
  const platformName = context?.electronPlatformName;
  if (!platformName || platformName === SUPPORTED_PACKAGED_RUNTIME_PLATFORM) return;

  throw new Error(
    `Packaged Deus native runtime is currently staged only for macOS. Refusing to build ${platformName} artifacts until Resources/bin/deus-runtime and bundled native CLIs are staged for that platform.`
  );
}

module.exports = function beforePack(context) {
  const projectRoot = path.resolve(__dirname, "../..");

  assertPackagedRuntimePlatform(context);

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
  assertPackagedMainRuntimeContract(projectRoot);

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

module.exports.assertPackagedMainRuntimeContract = assertPackagedMainRuntimeContract;
module.exports.assertPackagedMainRuntimeContents = assertPackagedMainRuntimeContents;
module.exports.assertPackagedRuntimePlatform = assertPackagedRuntimePlatform;
module.exports.assertElectronBuildVersion = assertElectronBuildVersion;
