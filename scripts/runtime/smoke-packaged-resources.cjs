const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const afterPack = require("../prune-pencil-cli-binaries.cjs");
const { verifyPackagedAgentClis } = afterPack;

const PROJECT_ROOT = path.resolve(__dirname, "../..");
const STAGED_BIN_ROOT = path.join(PROJECT_ROOT, "dist", "runtime", "electron", "bin");
const TARGET_ARCHES = ["arm64", "x64"];
const RUNTIME_BINARIES = ["deus-runtime", "codex", "claude", "gh", "rg"];
const RUNTIME_MANIFESTS = ["deus-runtime.json", "agent-clis.json", "gh-cli.json"];

function copyFile(src, dest) {
  if (!fs.existsSync(src)) {
    throw new Error(`Missing source file for packaged resources smoke: ${src}`);
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  fs.chmodSync(dest, fs.statSync(src).mode);
}

function writeFile(dest, contents) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, contents);
}

function copyRuntimeBin(resourcesDir, arch) {
  const stagedArchDir = path.join(STAGED_BIN_ROOT, `darwin-${arch}`);
  const binDir = path.join(resourcesDir, "bin");

  for (const name of RUNTIME_BINARIES) {
    copyFile(path.join(stagedArchDir, name), path.join(binDir, name));
  }
  for (const name of RUNTIME_MANIFESTS) {
    copyFile(path.join(STAGED_BIN_ROOT, name), path.join(binDir, name));
  }
}

function copyNodePtyPayload(resourcesDir, arch) {
  const nodePtyRoot = path.join(
    resourcesDir,
    "app.asar.unpacked",
    "node_modules",
    "node-pty"
  );
  copyFile(
    path.join(PROJECT_ROOT, "node_modules", "node-pty", "package.json"),
    path.join(nodePtyRoot, "package.json")
  );

  for (const candidateArch of TARGET_ARCHES) {
    const sourcePrebuildDir = path.join(
      PROJECT_ROOT,
      "node_modules",
      "node-pty",
      "prebuilds",
      `darwin-${candidateArch}`
    );
    copyFile(
      path.join(sourcePrebuildDir, "pty.node"),
      path.join(nodePtyRoot, "prebuilds", `darwin-${candidateArch}`, "pty.node")
    );
    copyFile(
      path.join(sourcePrebuildDir, "spawn-helper"),
      path.join(nodePtyRoot, "prebuilds", `darwin-${candidateArch}`, "spawn-helper")
    );
  }

  // Prove the real afterPack hook prunes build/Release before verification.
  writeFile(path.join(nodePtyRoot, "build", "Release", "pty.node"), "stale build output");
  writeFile(path.join(nodePtyRoot, "build", "Release", "spawn-helper"), "stale build output");

  if (!fs.existsSync(path.join(nodePtyRoot, "prebuilds", `darwin-${arch}`, "pty.node"))) {
    throw new Error(`Failed to stage node-pty prebuild for darwin-${arch}`);
  }
}

function copyCanvasPayload(resourcesDir, arch) {
  const unpackedNodeModules = path.join(resourcesDir, "app.asar.unpacked", "node_modules");
  copyFile(
    path.join(PROJECT_ROOT, "node_modules", "@napi-rs", "canvas", "package.json"),
    path.join(unpackedNodeModules, "@napi-rs", "canvas", "package.json")
  );

  for (const candidateArch of TARGET_ARCHES) {
    const packageName = `canvas-darwin-${candidateArch}`;
    const sourcePackageDir = path.join(PROJECT_ROOT, "node_modules", "@napi-rs", packageName);
    copyFile(
      path.join(sourcePackageDir, "package.json"),
      path.join(unpackedNodeModules, "@napi-rs", packageName, "package.json")
    );
    copyFile(
      path.join(sourcePackageDir, `skia.darwin-${candidateArch}.node`),
      path.join(
        unpackedNodeModules,
        "@napi-rs",
        packageName,
        `skia.darwin-${candidateArch}.node`
      )
    );
  }
}

function signPackagedPayloads(resourcesDir, arch) {
  const unpackedNodeModules = path.join(resourcesDir, "app.asar.unpacked", "node_modules");
  execFileSync(
    "codesign",
    [
      "--force",
      "--options",
      "runtime",
      "--pagesize",
      "4096",
      "--entitlements",
      path.join(PROJECT_ROOT, "resources", "entitlements.runtime.plist"),
      "--sign",
      "-",
      path.join(resourcesDir, "bin", "deus-runtime"),
    ],
    {
      stdio: ["ignore", "ignore", "pipe"],
    }
  );

  const payloads = [
    path.join(resourcesDir, "bin", "codex"),
    path.join(resourcesDir, "bin", "claude"),
    path.join(resourcesDir, "bin", "gh"),
    path.join(resourcesDir, "bin", "rg"),
    path.join(unpackedNodeModules, "node-pty", "prebuilds", `darwin-${arch}`, "pty.node"),
    path.join(unpackedNodeModules, "node-pty", "prebuilds", `darwin-${arch}`, "spawn-helper"),
    path.join(
      unpackedNodeModules,
      "@napi-rs",
      `canvas-darwin-${arch}`,
      `skia.darwin-${arch}.node`
    ),
  ];

  for (const filePath of payloads) {
    execFileSync("codesign", ["--force", "--sign", "-", filePath], {
      stdio: ["ignore", "ignore", "pipe"],
    });
  }
}

async function smokeArch(arch) {
  const resourcesDir = fs.mkdtempSync(path.join(os.tmpdir(), `deus-resources-${arch}-`));
  try {
    copyRuntimeBin(resourcesDir, arch);
    copyNodePtyPayload(resourcesDir, arch);
    copyCanvasPayload(resourcesDir, arch);

    const context = {
      electronPlatformName: "darwin",
      arch,
      resourcesDir,
    };

    await afterPack(context);

    const nodePtyPrebuilds = fs.readdirSync(
      path.join(resourcesDir, "app.asar.unpacked", "node_modules", "node-pty", "prebuilds")
    );
    if (nodePtyPrebuilds.length !== 1 || nodePtyPrebuilds[0] !== `darwin-${arch}`) {
      throw new Error(`Unexpected packaged node-pty prebuilds: ${nodePtyPrebuilds.join(", ")}`);
    }

    signPackagedPayloads(resourcesDir, arch);
    verifyPackagedAgentClis(context, {
      runVersionChecks: false,
      verifyManifestHashes: false,
    });

    console.log(`[runtime-smoke] darwin-${arch} packaged resources verified`);
  } finally {
    fs.rmSync(resourcesDir, { recursive: true, force: true });
  }
}

void (async () => {
  for (const arch of TARGET_ARCHES) {
    await smokeArch(arch);
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
