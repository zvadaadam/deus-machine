const fs = require("node:fs");
const path = require("node:path");

const ARCH_BY_BUILDER_VALUE = new Map([
  [1, "x64"],
  [3, "arm64"],
  ["x64", "x64"],
  ["arm64", "arm64"],
]);

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

module.exports = async function afterPack(context) {
  prunePencilCliBinaries(context);
};

module.exports.prunePencilCliBinaries = prunePencilCliBinaries;
module.exports.binaryNamesForTarget = binaryNamesForTarget;
