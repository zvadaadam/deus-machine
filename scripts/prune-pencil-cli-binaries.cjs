const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");

const ARCH_BY_BUILDER_VALUE = new Map([
  [1, "x64"],
  [3, "arm64"],
  ["x64", "x64"],
  ["arm64", "arm64"],
]);
const FILE_ARCH_BY_TARGET_ARCH = new Map([
  ["x64", "x86_64"],
  ["arm64", "arm64"],
]);
const PACKAGED_SYSTEM_PATHS = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
const REQUIRED_RUNTIME_ENTITLEMENTS = [
  "com.apple.security.cs.allow-jit",
  "com.apple.security.cs.allow-unsigned-executable-memory",
  "com.apple.security.cs.disable-library-validation",
];

function platformSegment(electronPlatformName) {
  if (electronPlatformName === "darwin") return "darwin";
  if (electronPlatformName === "linux") return "linux";
  if (electronPlatformName === "win32") return "windows";
  return null;
}

function binaryNamesForTarget(electronPlatformName, archValue) {
  const platform = platformSegment(electronPlatformName);
  if (!platform) return new Set();

  const arch = ARCH_BY_BUILDER_VALUE.get(archValue);
  const arches = arch ? [arch] : ["arm64", "x64"];
  const ext = platform === "windows" ? ".exe" : "";
  return new Set(arches.map((item) => `mcp-server-${platform}-${item}${ext}`));
}

function resourcesDirForContext(context) {
  const productName = context.packager?.appInfo?.productFilename ?? "Deus";
  if (context.electronPlatformName === "darwin") {
    return path.join(context.appOutDir, `${productName}.app`, "Contents", "Resources");
  }
  return path.join(context.appOutDir, "resources");
}

function candidateOutDirs(resourcesDir) {
  return [
    path.join(
      resourcesDir,
      "app.asar.unpacked",
      "node_modules",
      "@pencil.dev",
      "cli",
      "dist",
      "out"
    ),
    path.join(resourcesDir, "node_modules", "@pencil.dev", "cli", "dist", "out"),
    path.join(resourcesDir, "app", "node_modules", "@pencil.dev", "cli", "dist", "out"),
    path.join(
      resourcesDir,
      "agentic-apps",
      "pencil",
      "node_modules",
      "@pencil.dev",
      "cli",
      "dist",
      "out"
    ),
  ];
}

function pruneOutDir(outDir, keepNames) {
  if (!fs.existsSync(outDir)) return { removed: 0, kept: 0 };

  let removed = 0;
  let kept = 0;
  for (const entry of fs.readdirSync(outDir, { withFileTypes: true })) {
    if (!entry.name.startsWith("mcp-server-")) continue;
    const entryPath = path.join(outDir, entry.name);
    if (keepNames.has(entry.name)) {
      kept++;
      continue;
    }
    fs.rmSync(entryPath, { recursive: true, force: true });
    removed++;
  }
  return { removed, kept };
}

function prunePencilCliBinaries(context) {
  const keepNames = binaryNamesForTarget(context.electronPlatformName, context.arch);
  if (keepNames.size === 0) return { removed: 0, kept: 0 };

  const resourcesDir = context.resourcesDir ?? resourcesDirForContext(context);
  const totals = { removed: 0, kept: 0 };
  for (const outDir of candidateOutDirs(resourcesDir)) {
    const result = pruneOutDir(outDir, keepNames);
    totals.removed += result.removed;
    totals.kept += result.kept;
  }

  if (totals.removed > 0 || totals.kept > 0) {
    console.log(
      `[prune-pencil-cli] kept ${[...keepNames].join(", ")}; removed ${totals.removed} unused MCP binaries`
    );
  }
  return totals;
}

function pruneNodePtyRuntimeBinaries(context) {
  if (context.electronPlatformName !== "darwin") return { removed: 0, kept: 0 };

  const targetArch = ARCH_BY_BUILDER_VALUE.get(context.arch);
  if (!targetArch) return { removed: 0, kept: 0 };

  const resourcesDir = context.resourcesDir ?? resourcesDirForContext(context);
  const nodePtyRoot = path.join(
    resourcesDir,
    "app.asar.unpacked",
    "node_modules",
    "node-pty"
  );
  if (!fs.existsSync(nodePtyRoot)) return { removed: 0, kept: 0 };

  let removed = 0;
  let kept = 0;
  const buildDir = path.join(nodePtyRoot, "build");
  if (fs.existsSync(buildDir)) {
    fs.rmSync(buildDir, { recursive: true, force: true });
    removed++;
  }

  const prebuildsDir = path.join(nodePtyRoot, "prebuilds");
  if (fs.existsSync(prebuildsDir)) {
    for (const entry of fs.readdirSync(prebuildsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const entryPath = path.join(prebuildsDir, entry.name);
      if (entry.name === `darwin-${targetArch}`) {
        kept++;
        continue;
      }
      fs.rmSync(entryPath, { recursive: true, force: true });
      removed++;
    }
  }

  if (removed > 0 || kept > 0) {
    console.log(
      `[runtime] kept node-pty prebuild darwin-${targetArch}; removed ${removed} non-runtime node-pty native dirs`
    );
  }
  return { removed, kept };
}

function assertExecutable(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing packaged ${label}: ${filePath}`);
  }
  if ((fs.statSync(filePath).mode & 0o111) === 0) {
    throw new Error(`Packaged ${label} is not executable: ${filePath}`);
  }
}

function verifyMachOArch(filePath, label, expectedFileArch) {
  const fileOutput = require("node:child_process")
    .execFileSync("file", [filePath], {
      encoding: "utf8",
      timeout: 20_000,
      stdio: ["ignore", "pipe", "pipe"],
    })
    .trim();
  if (
    !fileOutput.includes("Mach-O 64-bit executable") ||
    (expectedFileArch && !fileOutput.includes(expectedFileArch))
  ) {
    throw new Error(`Packaged ${label} has unexpected architecture: ${fileOutput}`);
  }
  console.log(`[runtime] packaged ${label}: ${fileOutput}`);
}

function verifyCodeSignature(filePath, label) {
  require("node:child_process").execFileSync("codesign", ["--verify", "--verbose=2", filePath], {
    encoding: "utf8",
    timeout: 20_000,
    stdio: ["ignore", "ignore", "pipe"],
  });
  console.log(`[runtime] packaged ${label} code signature verified`);
}

function verifyRuntimeEntitlements(filePath) {
  const result = require("node:child_process").spawnSync(
    "codesign",
    ["-d", "--entitlements", ":-", filePath],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  if (result.status !== 0) {
    throw new Error(
      `Unable to read packaged Deus runtime entitlements: ${result.stderr || result.stdout}`
    );
  }
  const entitlements = `${result.stdout}\n${result.stderr}`;
  for (const entitlement of REQUIRED_RUNTIME_ENTITLEMENTS) {
    if (!entitlements.includes(entitlement)) {
      throw new Error(`Packaged Deus runtime is missing ${entitlement} entitlement`);
    }
  }
  console.log("[runtime] packaged Deus runtime entitlements verified");
}

function verifyRuntimeSystemDylibs(filePath) {
  const output = require("node:child_process").execFileSync("otool", ["-L", filePath], {
    encoding: "utf8",
    timeout: 20_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const unexpected = output
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim().split(/\s+/)[0])
    .filter(Boolean)
    .filter(
      (dependency) =>
        !dependency.startsWith("/usr/lib/") && !dependency.startsWith("/System/Library/")
    );
  if (unexpected.length > 0) {
    throw new Error(`Packaged Deus runtime has non-system dylib dependencies: ${unexpected.join(", ")}`);
  }
  console.log("[runtime] packaged Deus runtime dylib dependencies verified");
}

function readJsonFile(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing packaged ${label}: ${filePath}`);
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(
      `Unable to read packaged ${label}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function hashFile(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function verifyManifestFileEntry(entry, filePath, label) {
  assertExecutable(filePath, label);
  if (!entry || typeof entry !== "object") {
    throw new Error(`Packaged manifest is missing ${label}`);
  }
  if (entry.sha256 !== hashFile(filePath)) {
    throw new Error(`Packaged ${label} hash does not match its manifest entry`);
  }
  if (entry.size !== fs.statSync(filePath).size) {
    throw new Error(`Packaged ${label} size does not match its manifest entry`);
  }
}

function verifyPackagedRuntimeManifests(binDir, targetArch) {
  const runtimeKey = targetArch ? `darwin-${targetArch}` : null;
  const runtimeManifest = readJsonFile(
    path.join(binDir, "deus-runtime.json"),
    "Deus runtime manifest"
  );
  const agentCliManifest = readJsonFile(
    path.join(binDir, "agent-clis.json"),
    "agent CLI manifest"
  );
  const ghCliManifest = readJsonFile(path.join(binDir, "gh-cli.json"), "GitHub CLI manifest");

  if (runtimeManifest.version !== 1 || !Array.isArray(runtimeManifest.entries)) {
    throw new Error("Packaged Deus runtime manifest has an unexpected shape");
  }
  if (agentCliManifest.version !== 1 || !Array.isArray(agentCliManifest.targets)) {
    throw new Error("Packaged agent CLI manifest has an unexpected shape");
  }
  if (ghCliManifest.version !== 1 || !Array.isArray(ghCliManifest.targets)) {
    throw new Error("Packaged GitHub CLI manifest has an unexpected shape");
  }
  if (runtimeKey && !runtimeManifest.entries.some((entry) => entry.runtimeKey === runtimeKey)) {
    throw new Error(`Packaged Deus runtime manifest is missing ${runtimeKey}`);
  }
  if (runtimeKey) {
    const runtimeEntry = runtimeManifest.entries.find((entry) => entry.runtimeKey === runtimeKey);
    verifyManifestFileEntry(runtimeEntry, path.join(binDir, "deus-runtime"), "Deus runtime");

    for (const tool of ["codex", "claude", "rg"]) {
      const entry = agentCliManifest.targets.find(
        (candidate) => candidate.runtimeKey === runtimeKey && candidate.tool === tool
      );
      if (!entry) {
        throw new Error(`Packaged agent CLI manifest is missing ${runtimeKey}/${tool}`);
      }
      verifyManifestFileEntry(entry, path.join(binDir, tool), `${tool} CLI`);
    }
    const ghEntry = ghCliManifest.targets.find(
      (entry) => entry.runtimeKey === runtimeKey && entry.tool === "gh"
    );
    if (!ghEntry) {
      throw new Error(`Packaged GitHub CLI manifest is missing ${runtimeKey}/gh`);
    }
    verifyManifestFileEntry(ghEntry, path.join(binDir, "gh"), "GitHub CLI");
  }

  console.log("[runtime] packaged runtime manifests verified");
}

function verifyPackagedRuntimeExternalModules(resourcesDir, targetArch) {
  const unpackedNodeModules = path.join(resourcesDir, "app.asar.unpacked", "node_modules");
  const requiredFiles = [
    ["better-sqlite3 package", path.join(unpackedNodeModules, "better-sqlite3", "package.json")],
    [
      "better-sqlite3 native binding",
      path.join(unpackedNodeModules, "better-sqlite3", "build", "Release", "better_sqlite3.node"),
    ],
    ["node-pty package", path.join(unpackedNodeModules, "node-pty", "package.json")],
    [
      "@napi-rs/canvas package",
      path.join(unpackedNodeModules, "@napi-rs", "canvas", "package.json"),
    ],
  ];

  if (targetArch) {
    const nodePtyPackageRoot = path.join(unpackedNodeModules, "node-pty");
    const nodePtyPrebuildFiles = [
      path.join(nodePtyPackageRoot, "prebuilds", `darwin-${targetArch}`, "pty.node"),
      path.join(nodePtyPackageRoot, "prebuilds", `darwin-${targetArch}`, "spawn-helper"),
    ];
    requiredFiles.push([
      `@napi-rs/canvas native package for darwin-${targetArch}`,
      path.join(unpackedNodeModules, "@napi-rs", `canvas-darwin-${targetArch}`, "package.json"),
    ]);
    requiredFiles.push([
      `@napi-rs/canvas native binding for darwin-${targetArch}`,
      path.join(
        unpackedNodeModules,
        "@napi-rs",
        `canvas-darwin-${targetArch}`,
        `skia.darwin-${targetArch}.node`
      ),
    ]);

    const hasNodePtyPrebuild = nodePtyPrebuildFiles.every((filePath) => fs.existsSync(filePath));
    const staleNodePtyBuild = path.join(nodePtyPackageRoot, "build", "Release", "pty.node");
    if (fs.existsSync(staleNodePtyBuild)) {
      throw new Error(
        `Packaged node-pty build output is still present: ${staleNodePtyBuild}. ` +
          "node-pty resolves build/Release before prebuilds, so packaged deus-runtime must keep only the target Darwin prebuild."
      );
    }
    if (!hasNodePtyPrebuild) {
      throw new Error(
        `Missing unpacked runtime external module node-pty prebuild files for darwin-${targetArch}: ` +
          `${nodePtyPrebuildFiles.join(", ")}. Bun-compiled deus-runtime cannot rely on Electron app.asar module resolution.`
      );
    }
  }

  for (const [label, filePath] of requiredFiles) {
    if (!fs.existsSync(filePath)) {
      throw new Error(
        `Missing unpacked runtime external module ${label}: ${filePath}. ` +
          "Bun-compiled deus-runtime cannot rely on Electron app.asar module resolution."
      );
    }
  }

  console.log("[runtime] packaged runtime external modules verified");
}

function validateVersionOutput(label, output) {
  if (!output) throw new Error(`Packaged ${label} --version produced no output`);
  if (label === "Deus runtime" && !/^deus-runtime \d+\.\d+\.\d+ /.test(output)) {
    throw new Error(`Packaged ${label} --version produced unexpected output: ${output}`);
  }
}

function verifyPackagedAgentClis(context, options = {}) {
  if (context.electronPlatformName !== "darwin") return;

  const resourcesDir = context.resourcesDir ?? resourcesDirForContext(context);
  const binDir = path.join(resourcesDir, "bin");
  const targetArch = ARCH_BY_BUILDER_VALUE.get(context.arch);
  const expectedFileArch = targetArch ? FILE_ARCH_BY_TARGET_ARCH.get(targetArch) : undefined;
  verifyPackagedRuntimeManifests(binDir, targetArch);
  verifyPackagedRuntimeExternalModules(resourcesDir, targetArch);
  const packagedExecutables = [
    ["Deus runtime", path.join(binDir, "deus-runtime")],
    ["GitHub CLI", path.join(binDir, "gh")],
    ["Codex CLI", path.join(binDir, "codex")],
    ["Claude CLI", path.join(binDir, "claude")],
    ["Codex ripgrep helper", path.join(binDir, "rg")],
  ];

  for (const [label, executablePath] of packagedExecutables) {
    assertExecutable(executablePath, label);
    verifyMachOArch(executablePath, label, expectedFileArch);
    verifyCodeSignature(executablePath, label);
    if (label === "Deus runtime") {
      verifyRuntimeEntitlements(executablePath);
      verifyRuntimeSystemDylibs(executablePath);
    }
  }

  if (options.runVersionChecks === false || (targetArch && targetArch !== process.arch)) return;

  for (const [label, executablePath] of [
    ["Deus runtime", path.join(binDir, "deus-runtime")],
    ["Codex CLI", path.join(binDir, "codex")],
    ["Claude CLI", path.join(binDir, "claude")],
  ]) {
    const output = require("node:child_process")
      .execFileSync(executablePath, ["--version"], {
        encoding: "utf8",
        timeout: 20_000,
        env: {
          ...process.env,
          DEUS_BUNDLED_BIN_DIR: binDir,
          PATH: [binDir, ...PACKAGED_SYSTEM_PATHS].join(path.delimiter),
        },
        stdio: ["ignore", "pipe", "pipe"],
      })
      .trim();
    validateVersionOutput(label, output);
    console.log(`[runtime] packaged ${label}: ${output}`);
  }
}

module.exports = async function afterPack(context) {
  prunePencilCliBinaries(context);
  pruneNodePtyRuntimeBinaries(context);
  verifyPackagedAgentClis(context, { runVersionChecks: false });
};

module.exports.prunePencilCliBinaries = prunePencilCliBinaries;
module.exports.pruneNodePtyRuntimeBinaries = pruneNodePtyRuntimeBinaries;
module.exports.binaryNamesForTarget = binaryNamesForTarget;
module.exports.verifyPackagedRuntimeManifests = verifyPackagedRuntimeManifests;
module.exports.verifyPackagedRuntimeExternalModules = verifyPackagedRuntimeExternalModules;
module.exports.verifyPackagedAgentClis = verifyPackagedAgentClis;
