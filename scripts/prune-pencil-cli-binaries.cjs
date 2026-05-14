const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");
const { execFileSync, spawn, spawnSync } = require("node:child_process");

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
const MAC_CODESIGN_PAGE_SIZE = "4096";
const PACKAGED_VERSION_TIMEOUT_MS = 20_000;
const PACKAGED_VERSION_STOP_TIMEOUT_MS = 5_000;
const PROJECT_ROOT = path.resolve(__dirname, "..");
const PACKAGED_VERSION_ENV_DENYLIST = [
  "AGENT_SERVER_CWD",
  "AGENT_SERVER_ENTRY",
  "AUTH_TOKEN",
  "DATABASE_PATH",
  "DEUS_AUTH_TOKEN",
  "DEUS_BACKEND_PORT",
  "DEUS_BUNDLED_BIN_DIR",
  "DEUS_DATA_DIR",
  "DEUS_PACKAGED",
  "DEUS_RESOURCES_PATH",
  "DEUS_RUNTIME",
  "DEUS_RUNTIME_COMMAND",
  "DEUS_RUNTIME_EXECUTABLE",
  "ELECTRON_RUN_AS_NODE",
  "NODE_PATH",
  "PORT",
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

function pruneCanvasRuntimeBinaries(context) {
  if (context.electronPlatformName !== "darwin") return { removed: 0, kept: 0 };

  const targetArch = ARCH_BY_BUILDER_VALUE.get(context.arch);
  if (!targetArch) return { removed: 0, kept: 0 };

  const resourcesDir = context.resourcesDir ?? resourcesDirForContext(context);
  const napiRsRoot = path.join(
    resourcesDir,
    "app.asar.unpacked",
    "node_modules",
    "@napi-rs"
  );
  if (!fs.existsSync(napiRsRoot)) return { removed: 0, kept: 0 };

  const targetPackageName = `canvas-darwin-${targetArch}`;
  let removed = 0;
  let kept = 0;
  for (const entry of fs.readdirSync(napiRsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("canvas-")) continue;
    const entryPath = path.join(napiRsRoot, entry.name);
    if (entry.name === targetPackageName) {
      kept++;
      continue;
    }
    fs.rmSync(entryPath, { recursive: true, force: true });
    removed++;
  }

  if (removed > 0 || kept > 0) {
    console.log(
      `[runtime] kept @napi-rs/${targetPackageName}; removed ${removed} non-runtime canvas native dirs`
    );
  }
  return { removed, kept };
}

function fileArch(filePath) {
  const output = execFileSync("file", [filePath], {
    encoding: "utf8",
    timeout: 20_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const description = output.includes(":") ? output.slice(output.indexOf(":") + 1) : output;
  if (/\barm64\b/.test(description)) return "arm64";
  if (/\bx86_64\b/.test(description)) return "x64";
  return null;
}

function bunNodeTargetVersion() {
  return execFileSync("bun", ["-e", "console.log(process.version.replace(/^v/, ''))"], {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    timeout: 20_000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function installBetterSqlitePrebuild(packageRoot, targetArch) {
  const prebuildInstall = path.join(PROJECT_ROOT, "node_modules", "prebuild-install", "bin.js");
  fs.rmSync(path.join(packageRoot, "build"), { recursive: true, force: true });
  const result = spawnSync(
    process.execPath,
    [
      prebuildInstall,
      "--runtime",
      "node",
      "--target",
      bunNodeTargetVersion(),
      "--arch",
      targetArch,
      "--platform",
      "darwin",
    ],
    {
      cwd: packageRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  if (result.status !== 0) {
    throw new Error(
      `Failed to install packaged better-sqlite3 darwin-${targetArch} prebuild: ${
        result.stderr || result.stdout
      }`
    );
  }
}

function prepareBetterSqliteRuntimeBinding(context) {
  if (context.electronPlatformName !== "darwin") return { updated: false };

  const targetArch = ARCH_BY_BUILDER_VALUE.get(context.arch);
  if (!targetArch) return { updated: false };

  const resourcesDir = context.resourcesDir ?? resourcesDirForContext(context);
  const packageRoot = path.join(
    resourcesDir,
    "app.asar.unpacked",
    "node_modules",
    "better-sqlite3"
  );
  const nativeBinding = path.join(packageRoot, "build", "Release", "better_sqlite3.node");
  if (!fs.existsSync(packageRoot)) return { updated: false };
  if (fs.existsSync(nativeBinding) && fileArch(nativeBinding) === targetArch) {
    return { updated: false };
  }

  console.log(`[runtime] installing better-sqlite3 prebuild for darwin-${targetArch}`);
  installBetterSqlitePrebuild(packageRoot, targetArch);
  if (!fs.existsSync(nativeBinding) || fileArch(nativeBinding) !== targetArch) {
    throw new Error(`better-sqlite3 prebuild did not produce darwin-${targetArch} binding`);
  }
  return { updated: true };
}

function assertExecutable(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing packaged ${label}: ${filePath}`);
  }
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) {
    throw new Error(`Packaged ${label} is not a regular file: ${filePath}`);
  }
  if ((stat.mode & 0o111) === 0) {
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

function verifyMachO64Arch(filePath, label, expectedFileArch) {
  const fileOutput = require("node:child_process")
    .execFileSync("file", [filePath], {
      encoding: "utf8",
      timeout: 20_000,
      stdio: ["ignore", "pipe", "pipe"],
    })
    .trim();
  if (
    !fileOutput.includes("Mach-O 64-bit") ||
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

function verifyCodeSignaturePageSize(filePath, label, expectedPageSize = MAC_CODESIGN_PAGE_SIZE) {
  const result = require("node:child_process").spawnSync(
    "codesign",
    ["-dv", "--verbose=4", filePath],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  if (result.status !== 0) {
    throw new Error(
      `Unable to inspect packaged ${label} code signature: ${result.stderr || result.stdout}`
    );
  }
  const output = `${result.stdout}\n${result.stderr}`;
  if (!output.includes(`Page size=${expectedPageSize}`)) {
    throw new Error(
      `Packaged ${label} code signature page size mismatch; expected ${expectedPageSize}`
    );
  }
  console.log(`[runtime] packaged ${label} code signature page size verified`);
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

function verifyManifestFileEntry(entry, filePath, label, options = {}) {
  assertExecutable(filePath, label);
  if (!entry || typeof entry !== "object") {
    throw new Error(`Packaged manifest is missing ${label}`);
  }
  if (options.verifyFileHashes === false) return;
  if (entry.sha256 !== hashFile(filePath)) {
    throw new Error(`Packaged ${label} hash does not match its manifest entry`);
  }
  if (entry.size !== fs.statSync(filePath).size) {
    throw new Error(`Packaged ${label} size does not match its manifest entry`);
  }
}

function verifyPackagedRuntimeManifests(binDir, targetArch, options = {}) {
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
    verifyManifestFileEntry(runtimeEntry, path.join(binDir, "deus-runtime"), "Deus runtime", {
      verifyFileHashes: options.verifyFileHashes,
    });

    for (const tool of ["codex", "claude", "rg", "agent-browser"]) {
      const entry = agentCliManifest.targets.find(
        (candidate) => candidate.runtimeKey === runtimeKey && candidate.tool === tool
      );
      if (!entry) {
        throw new Error(`Packaged agent CLI manifest is missing ${runtimeKey}/${tool}`);
      }
      verifyManifestFileEntry(entry, path.join(binDir, tool), `${tool} CLI`, {
        verifyFileHashes: options.verifyFileHashes,
      });
    }
    const ghEntry = ghCliManifest.targets.find(
      (entry) => entry.runtimeKey === runtimeKey && entry.tool === "gh"
    );
    if (!ghEntry) {
      throw new Error(`Packaged GitHub CLI manifest is missing ${runtimeKey}/gh`);
    }
    verifyManifestFileEntry(ghEntry, path.join(binDir, "gh"), "GitHub CLI", {
      verifyFileHashes: options.verifyFileHashes,
    });
  }

  console.log("[runtime] packaged runtime manifests verified");
}

function verifyPackagedRuntimeExternalModules(resourcesDir, targetArch, options = {}) {
  const unpackedNodeModules = path.join(resourcesDir, "app.asar.unpacked", "node_modules");
  const requiredFiles = [
    [
      "better-sqlite3 package",
      path.join(unpackedNodeModules, "better-sqlite3", "package.json"),
    ],
    ["node-pty package", path.join(unpackedNodeModules, "node-pty", "package.json")],
    [
      "@napi-rs/canvas package",
      path.join(unpackedNodeModules, "@napi-rs", "canvas", "package.json"),
    ],
  ];
  const nativePayloads = [];
  const expectedFileArch = targetArch ? FILE_ARCH_BY_TARGET_ARCH.get(targetArch) : undefined;

  if (targetArch) {
    const betterSqliteNative = path.join(
      unpackedNodeModules,
      "better-sqlite3",
      "build",
      "Release",
      "better_sqlite3.node"
    );
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
    nativePayloads.push(
      [`better-sqlite3 native binding for darwin-${targetArch}`, betterSqliteNative],
      [`node-pty native binding for darwin-${targetArch}`, nodePtyPrebuildFiles[0]],
      [`node-pty spawn helper for darwin-${targetArch}`, nodePtyPrebuildFiles[1]],
      [
        `@napi-rs/canvas native binding for darwin-${targetArch}`,
        path.join(
          unpackedNodeModules,
          "@napi-rs",
          `canvas-darwin-${targetArch}`,
          `skia.darwin-${targetArch}.node`
        ),
      ]
    );

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

    const napiRsRoot = path.join(unpackedNodeModules, "@napi-rs");
    const expectedCanvasPackage = `canvas-darwin-${targetArch}`;
    const staleCanvasPackages = fs.existsSync(napiRsRoot)
      ? fs
          .readdirSync(napiRsRoot, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
          .filter((name) => name.startsWith("canvas-") && name !== expectedCanvasPackage)
      : [];
    if (staleCanvasPackages.length > 0) {
      throw new Error(
        `Packaged runtime still contains non-target @napi-rs/canvas native packages: ${staleCanvasPackages.join(
          ", "
        )}. Keep only @napi-rs/${expectedCanvasPackage} for darwin-${targetArch}.`
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

  if (options.verifyNativePayloads !== false) {
    for (const [label, filePath] of nativePayloads) {
      verifyMachO64Arch(filePath, label, expectedFileArch);
      if (options.verifyNativePayloadSignatures !== false) {
        verifyCodeSignature(filePath, label);
      }
    }
  }

  console.log("[runtime] packaged runtime external modules verified");
}

function validateVersionOutput(label, output) {
  if (!output) throw new Error(`Packaged ${label} --version produced no output`);
  if (label === "Deus runtime" && !/^deus-runtime \d+\.\d+\.\d+ /.test(output)) {
    throw new Error(`Packaged ${label} --version produced unexpected output: ${output}`);
  }
  if (label === "GitHub CLI" && !/^gh version \d+\.\d+\.\d+/m.test(output)) {
    throw new Error(`Packaged ${label} --version produced unexpected output: ${output}`);
  }
  if (label === "Codex ripgrep helper" && !/^ripgrep \d+\.\d+\.\d+/m.test(output)) {
    throw new Error(`Packaged ${label} --version produced unexpected output: ${output}`);
  }
}

function runDiagnostic(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 20_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
  if (result.error) {
    return [result.error.code || result.error.message, output].filter(Boolean).join("\n");
  }
  if (result.status !== 0) {
    return output || `${command} exited with status ${result.status}`;
  }
  return output;
}

function packagedExecutableDiagnostics(executablePath) {
  if (process.platform !== "darwin") return "";
  return [
    `file: ${runDiagnostic("file", [executablePath])}`,
    `codesign: ${runDiagnostic("codesign", ["-dv", "--verbose=4", executablePath])}`,
    `spctl: ${runDiagnostic("spctl", ["--assess", "--type", "execute", "--verbose=4", executablePath])}`,
    `xattr: ${runDiagnostic("xattr", ["-l", executablePath]) || "none"}`,
  ].join("\n");
}

function macExecutionPolicyHint(diagnostics) {
  if (process.platform !== "darwin") return "";
  if (!/spctl:[\s\S]*rejected/.test(diagnostics)) return "";
  if (!/com\.apple\.(provenance|quarantine)/.test(diagnostics)) return "";

  return [
    "",
    "macOS rejected this executable before its --version command produced output.",
    "Verify runnable packaged binaries on a notarized artifact or a macOS host that allows generated/copied Mach-O binaries to launch.",
  ].join("\n");
}

function killChildTree(child, signal) {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to the direct child if process-group termination is unavailable.
    }
  }
  child.kill(signal);
}

function stopVersionChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();

  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(forceTimer);
      resolve();
    };
    const forceTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) killChildTree(child, "SIGKILL");
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref?.();
      finish();
    }, PACKAGED_VERSION_STOP_TIMEOUT_MS);
    child.once("exit", finish);
    killChildTree(child, "SIGTERM");
  });
}

async function runPackagedVersionCheck(label, executablePath, binDir) {
  const env = { ...process.env };
  for (const key of PACKAGED_VERSION_ENV_DENYLIST) {
    delete env[key];
  }
  Object.assign(env, {
    DEUS_BUNDLED_BIN_DIR: binDir,
    PATH: [binDir, ...PACKAGED_SYSTEM_PATHS].join(path.delimiter),
  });

  const child = spawn(executablePath, ["--version"], {
    detached: process.platform !== "win32",
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";

  try {
    await new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        const diagnostics = packagedExecutableDiagnostics(executablePath);
        const hint = macExecutionPolicyHint(diagnostics);
        fail(
          new Error(
            `Packaged ${label} --version timed out after ${PACKAGED_VERSION_TIMEOUT_MS}ms stdout=${stdout
              .trim()
              .slice(-4000)} stderr=${stderr.trim().slice(-4000)}${
              diagnostics ? `\n${diagnostics}` : ""
            }${hint}`
          )
        );
      }, PACKAGED_VERSION_TIMEOUT_MS);

      const fail = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      };

      child.stdout.on("data", (data) => {
        stdout += data.toString();
      });
      child.stderr.on("data", (data) => {
        stderr += data.toString();
      });
      child.on("error", (error) => {
        const diagnostics = packagedExecutableDiagnostics(executablePath);
        const hint = macExecutionPolicyHint(diagnostics);
        fail(
          new Error(
            `Packaged ${label} --version failed to spawn: error=${
              error.code || error.message
            } stdout=${stdout.trim().slice(-4000)} stderr=${stderr.trim().slice(-4000)}${
              diagnostics ? `\n${diagnostics}` : ""
            }${hint}`
          )
        );
      });
      child.on("exit", (code, signal) => {
        if (settled) return;
        if (code === 0) {
          settled = true;
          clearTimeout(timeout);
          resolve();
          return;
        }

        const diagnostics = packagedExecutableDiagnostics(executablePath);
        const hint = macExecutionPolicyHint(diagnostics);
        fail(
          new Error(
            `Packaged ${label} --version failed: status=${code} signal=${
              signal ?? "none"
            } stdout=${stdout.trim().slice(-4000)} stderr=${stderr.trim().slice(-4000)}${
              diagnostics ? `\n${diagnostics}` : ""
            }${hint}`
          )
        );
      });
    });
  } finally {
    await stopVersionChild(child);
  }

  const output = stdout.trim();
  validateVersionOutput(label, output);
  console.log(`[runtime] packaged ${label}: ${output}`);
}

async function verifyPackagedAgentClis(context, options = {}) {
  if (context.electronPlatformName !== "darwin") return;

  const resourcesDir = context.resourcesDir ?? resourcesDirForContext(context);
  const binDir = path.join(resourcesDir, "bin");
  const targetArch = ARCH_BY_BUILDER_VALUE.get(context.arch);
  const expectedFileArch = targetArch ? FILE_ARCH_BY_TARGET_ARCH.get(targetArch) : undefined;
  verifyPackagedRuntimeManifests(binDir, targetArch, {
    verifyFileHashes: options.verifyManifestHashes,
  });
  verifyPackagedRuntimeExternalModules(resourcesDir, targetArch, {
    verifyNativePayloadSignatures: options.verifyNativePayloadSignatures,
  });
  const packagedExecutables = [
    ["Deus runtime", path.join(binDir, "deus-runtime")],
    ["GitHub CLI", path.join(binDir, "gh")],
    ["Codex CLI", path.join(binDir, "codex")],
    ["Claude CLI", path.join(binDir, "claude")],
    ["Codex ripgrep helper", path.join(binDir, "rg")],
    ["agent-browser CLI", path.join(binDir, "agent-browser")],
  ];

  for (const [label, executablePath] of packagedExecutables) {
    assertExecutable(executablePath, label);
    verifyMachOArch(executablePath, label, expectedFileArch);
    if (options.verifyExecutableSignatures !== false) {
      verifyCodeSignature(executablePath, label);
      if (label === "Deus runtime") {
        verifyCodeSignaturePageSize(executablePath, label);
      }
    }
    if (label === "Deus runtime") {
      verifyRuntimeEntitlements(executablePath);
      verifyRuntimeSystemDylibs(executablePath);
    }
  }

  if (options.runVersionChecks === false || (targetArch && targetArch !== process.arch)) return;

  for (const [label, executablePath] of [
    ["Deus runtime", path.join(binDir, "deus-runtime")],
    ["GitHub CLI", path.join(binDir, "gh")],
    ["Codex CLI", path.join(binDir, "codex")],
    ["Claude CLI", path.join(binDir, "claude")],
    ["Codex ripgrep helper", path.join(binDir, "rg")],
  ]) {
    await runPackagedVersionCheck(label, executablePath, binDir);
  }
}

module.exports = async function afterPack(context) {
  prunePencilCliBinaries(context);
  pruneNodePtyRuntimeBinaries(context);
  pruneCanvasRuntimeBinaries(context);
  prepareBetterSqliteRuntimeBinding(context);
  await verifyPackagedAgentClis(context, {
    runVersionChecks: false,
    verifyManifestHashes: true,
    verifyExecutableSignatures: false,
    verifyNativePayloadSignatures: false,
  });
};

module.exports.prunePencilCliBinaries = prunePencilCliBinaries;
module.exports.pruneNodePtyRuntimeBinaries = pruneNodePtyRuntimeBinaries;
module.exports.pruneCanvasRuntimeBinaries = pruneCanvasRuntimeBinaries;
module.exports.prepareBetterSqliteRuntimeBinding = prepareBetterSqliteRuntimeBinding;
module.exports.binaryNamesForTarget = binaryNamesForTarget;
module.exports.verifyPackagedRuntimeManifests = verifyPackagedRuntimeManifests;
module.exports.verifyPackagedRuntimeExternalModules = verifyPackagedRuntimeExternalModules;
module.exports.verifyPackagedAgentClis = verifyPackagedAgentClis;
module.exports.verifyCodeSignaturePageSize = verifyCodeSignaturePageSize;
