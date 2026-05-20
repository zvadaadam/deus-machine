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
const SUPPORTED_PACKAGED_RUNTIME_KEYS = new Map([
  ["darwin", new Set(["arm64", "x64"])],
  ["linux", new Set(["x64"])],
]);
const {
  DEVICE_USE_HELPER_NAMES,
  DEVICE_USE_PACKAGE_FILES,
  assertNoBuildLocalInstallName,
  deviceUsePackageRoot,
} = require("./lib/device-use-payloads.cjs");

const SOURCE_EXTENSIONS = new Set([
  ".cjs",
  ".css",
  ".html",
  ".h",
  ".js",
  ".json",
  ".jsx",
  ".m",
  ".mjs",
  ".mm",
  ".plist",
  ".resolved",
  ".sh",
  ".svg",
  ".swift",
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

function assertBuildOutputFresh(projectRoot, label, outputRelative, sourceRelatives, options = {}) {
  const kind = options.kind ?? "Electron";
  const rebuildCommand = options.rebuildCommand ?? "bun run build";
  const outputPath = path.join(projectRoot, outputRelative);
  if (!existsSync(outputPath)) {
    throw new Error(
      `Missing ${kind} ${label} build output: ${outputRelative}. Run \`${rebuildCommand}\`.`
    );
  }

  const outputStat = statSync(outputPath);
  const latestSource = latestSourceMtime(projectRoot, sourceRelatives);
  if (latestSource.path && outputStat.mtimeMs < latestSource.mtimeMs) {
    throw new Error(
      `Stale ${kind} ${label} build output: ${outputRelative} is older than ${relativeFromProjectRoot(
        projectRoot,
        latestSource.path
      )}. Run \`${rebuildCommand}\` before packaging.`
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
    '"AGENT_SERVER_CWD"',
    '"AGENT_SERVER_ENTRY"',
    '"AUTH_TOKEN"',
    '"BUN_OPTIONS"',
    '"DATABASE_PATH"',
    '"DEUS_AUTH_TOKEN"',
    '"DEUS_BUNDLED_BIN_DIR"',
    '"DEUS_BACKEND_PORT"',
    '"DEUS_DATA_DIR"',
    '"DEUS_PACKAGED"',
    '"DEUS_RESOURCES_PATH"',
    '"DEUS_RUNTIME"',
    '"DEUS_RUNTIME_COMMAND"',
    '"DEUS_RUNTIME_EXECUTABLE"',
    '"PORT"',
    '"ELECTRON_RUN_AS_NODE"',
    '"NODE_PATH"',
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
  if (!platformName) return;

  const supportedArches = SUPPORTED_PACKAGED_RUNTIME_KEYS.get(platformName);
  const arch = ARCH_BY_BUILDER_VALUE.get(context?.arch);
  if (supportedArches) {
    if (context?.arch == null) return;
    if (arch && supportedArches.has(arch)) return;
  }

  throw new Error(
    `Packaged Deus native runtime is staged for ${[...SUPPORTED_PACKAGED_RUNTIME_KEYS.entries()]
      .map(([platform, arches]) => `${platform}-${[...arches].join("|")}`)
      .join(
        ", "
      )}. Refusing to build ${platformName}${arch ? `-${arch}` : ""} artifacts until Resources/bin/deus-runtime and bundled native CLIs are staged for that platform.`
  );
}

function assertExecutableFile(filePath, label) {
  if (!existsSync(filePath)) {
    throw new Error(`Missing ${label}: ${filePath}`);
  }
  const stat = statSync(filePath);
  if (!stat.isFile()) {
    throw new Error(`${label} is not a regular file: ${filePath}`);
  }
  if ((stat.mode & 0o111) === 0) {
    throw new Error(`${label} is not executable: ${filePath}`);
  }
}

function assertUniversalMacHelper(filePath, label) {
  assertExecutableFile(filePath, label);
  execFileSync("lipo", [filePath, "-verify_arch", "arm64", "x86_64"], {
    stdio: "ignore",
  });
}

function assertDeviceUsePayloads(projectRoot) {
  const packageRoot = deviceUsePackageRoot(projectRoot);

  for (const [label, relativePath] of DEVICE_USE_PACKAGE_FILES) {
    const filePath = path.join(packageRoot, relativePath);
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      throw new Error(`Missing ${label}: ${filePath}. Run \`bun run prepare:device-use\`.`);
    }
  }

  const simbridge = path.join(packageRoot, "bin", DEVICE_USE_HELPER_NAMES.simbridge);
  const siminspector = path.join(packageRoot, "bin", DEVICE_USE_HELPER_NAMES.siminspector);
  assertUniversalMacHelper(simbridge, "device-use simbridge");
  assertUniversalMacHelper(siminspector, "device-use siminspector");
  assertNoBuildLocalInstallName(siminspector, projectRoot, "device-use siminspector");

  const tsSources = [
    "packages/device-use/src/cli",
    "packages/device-use/src/engine",
    "packages/device-use/src/server",
    "packages/device-use/package.json",
    "packages/device-use/scripts/build-ts.ts",
  ];
  const frontendSources = [
    "packages/device-use/src/frontend",
    "packages/device-use/vite.config.ts",
    "packages/device-use/package.json",
  ];
  const nativeSources = [
    "packages/device-use/native/Sources",
    "packages/device-use/native/Package.swift",
    "packages/device-use/native/Package.resolved",
    "packages/device-use/scripts/build-native.ts",
  ];
  const freshnessOptions = {
    kind: "device-use",
    rebuildCommand: "bun run prepare:device-use --force",
  };

  for (const [, relativePath] of DEVICE_USE_PACKAGE_FILES) {
    if (!relativePath.startsWith("dist/")) continue;
    const sources = relativePath.startsWith("dist/frontend/") ? frontendSources : tsSources;
    assertBuildOutputFresh(
      projectRoot,
      relativePath,
      path.join("packages/device-use", relativePath),
      sources,
      freshnessOptions
    );
  }
  assertBuildOutputFresh(
    projectRoot,
    "bin/simbridge",
    "packages/device-use/bin/simbridge",
    nativeSources,
    freshnessOptions
  );
  assertBuildOutputFresh(
    projectRoot,
    "bin/siminspector.dylib",
    "packages/device-use/bin/siminspector.dylib",
    nativeSources,
    freshnessOptions
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

  const platformName = context.electronPlatformName || SUPPORTED_PACKAGED_RUNTIME_PLATFORM;
  const arch = ARCH_BY_BUILDER_VALUE.get(context.arch);
  if (!arch) {
    throw new Error(`Unsupported ${platformName} packaging architecture: ${String(context.arch)}`);
  }
  const runtimeKey = `${platformName}-${arch}`;
  const binDir = path.join(projectRoot, "dist", "runtime", "electron", "bin", runtimeKey);
  const requiredBins = [
    ["GitHub CLI", "gh", "bun run prepare:gh-cli"],
    ["Deus runtime", "deus-runtime", "bun run build:runtime"],
    ["Codex CLI", "codex", "bun run prepare:agent-clis"],
    ["Claude CLI", "claude", "bun run prepare:agent-clis"],
    ["ripgrep for Codex", "rg", "bun run prepare:agent-clis"],
    ["agent-browser CLI", "agent-browser", "bun run prepare:agent-clis"],
  ];

  for (const [label, name, command] of requiredBins) {
    const binPath = path.join(binDir, name);
    if (!existsSync(binPath)) {
      throw new Error(
        `Missing bundled ${label} for ${runtimeKey}: ${binPath}. Run \`${command}\` before packaging.`
      );
    }
  }

  if (platformName === "darwin") {
    assertDeviceUsePayloads(projectRoot);
  }
};

module.exports.assertPackagedMainRuntimeContract = assertPackagedMainRuntimeContract;
module.exports.assertPackagedMainRuntimeContents = assertPackagedMainRuntimeContents;
module.exports.assertPackagedRuntimePlatform = assertPackagedRuntimePlatform;
module.exports.assertElectronBuildVersion = assertElectronBuildVersion;
