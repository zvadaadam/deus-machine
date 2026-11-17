const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const afterPack = require("../electron-builder-after-pack.cjs");
const { verifyPackagedAgentClis } = afterPack;
const { PROJECT_ROOT, RUNTIME_BINARIES, RUNTIME_MANIFESTS } = require("./lib/smoke-helpers.cjs");

const STAGED_BIN_ROOT = path.join(PROJECT_ROOT, "dist", "runtime", "electron", "bin");
const DARWIN_ARCHES = ["arm64", "x64"];

function targetArches() {
  if (process.env.DEUS_RESOURCE_SMOKE_ALL_ARCHES === "1") return DARWIN_ARCHES;
  if (process.platform === "darwin" && (process.arch === "arm64" || process.arch === "x64")) {
    return [process.arch];
  }
  return DARWIN_ARCHES;
}

function copyFile(src, dest) {
  if (!fs.existsSync(src)) {
    throw new Error(`Missing source file for packaged resources smoke: ${src}`);
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.lstatSync(src).isSymbolicLink()) {
    fs.symlinkSync(fs.readlinkSync(src), dest);
    return;
  }
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
  fs.cpSync(path.join(stagedArchDir, "codex-runtime"), path.join(binDir, "codex-runtime"), {
    recursive: true,
  });
  for (const name of RUNTIME_MANIFESTS) {
    copyFile(path.join(STAGED_BIN_ROOT, name), path.join(binDir, name));
  }
}

function copyCanvasPayload(resourcesDir, arch) {
  const unpackedNodeModules = path.join(resourcesDir, "app.asar.unpacked", "node_modules");
  copyFile(
    path.join(PROJECT_ROOT, "node_modules", "@napi-rs", "canvas", "package.json"),
    path.join(unpackedNodeModules, "@napi-rs", "canvas", "package.json")
  );

  for (const candidateArch of DARWIN_ARCHES) {
    const packageName = `canvas-darwin-${candidateArch}`;
    const sourcePackageDir = path.join(PROJECT_ROOT, "node_modules", "@napi-rs", packageName);
    const targetPackageDir = path.join(unpackedNodeModules, "@napi-rs", packageName);

    if (candidateArch !== arch && !fs.existsSync(sourcePackageDir)) {
      writeFile(
        path.join(targetPackageDir, "package.json"),
        JSON.stringify({ name: `@napi-rs/${packageName}`, private: true })
      );
      continue;
    }

    copyFile(
      path.join(sourcePackageDir, "package.json"),
      path.join(targetPackageDir, "package.json")
    );
    copyFile(
      path.join(sourcePackageDir, `skia.darwin-${candidateArch}.node`),
      path.join(targetPackageDir, `skia.darwin-${candidateArch}.node`)
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
    path.join(resourcesDir, "bin", "codex-runtime", "bin", "codex-code-mode-host"),
    path.join(resourcesDir, "bin", "codex-runtime", "codex-resources", "zsh", "bin", "zsh"),
    path.join(resourcesDir, "bin", "claude"),
    path.join(resourcesDir, "bin", "gh"),
    path.join(resourcesDir, "bin", "rg"),
    path.join(resourcesDir, "bin", "agent-browser"),
    path.join(unpackedNodeModules, "@napi-rs", `canvas-darwin-${arch}`, `skia.darwin-${arch}.node`),
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
    copyCanvasPayload(resourcesDir, arch);

    const context = {
      electronPlatformName: "darwin",
      arch,
      resourcesDir,
    };

    await afterPack(context);

    signPackagedPayloads(resourcesDir, arch);
    // Re-signing mutates Mach-O bytes. The real afterPack hook verifies
    // pre-sign manifest hashes; signed artifacts are verified by signature,
    // architecture, entitlements, and dylib checks.
    await verifyPackagedAgentClis(context, {
      runVersionChecks: false,
      verifyManifestHashes: false,
    });

    console.log(`[runtime-smoke] darwin-${arch} packaged resources verified`);
  } finally {
    fs.rmSync(resourcesDir, { recursive: true, force: true });
  }
}

void (async () => {
  for (const arch of targetArches()) {
    await smokeArch(arch);
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
