const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const PROJECT_ROOT = path.resolve(__dirname, "../../..");

function parseArgs(argv) {
  const options = {
    dmgPaths: [],
    requireGatekeeper: false,
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--require-gatekeeper") {
      options.requireGatekeeper = true;
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      options.dmgPaths.push(path.resolve(arg));
    }
  }

  if (options.dmgPaths.length === 0) {
    throw new Error("At least one DMG path is required");
  }

  return options;
}

function printUsage() {
  console.log(`Usage: bun run smoke:packaged-dmgs -- [options] <dmg...>

Options:
  --require-gatekeeper     Require spctl execute assessment for each mounted app

Mounts each macOS DMG, runs the packaged app smoke against the contained
Deus.app with an inferred architecture, then detaches the image.`);
}

function inferArchFromDmgName(dmgPath) {
  const name = path.basename(dmgPath).toLowerCase();
  if (name.includes("arm64")) return "arm64";
  if (name.includes("x64") || name.includes("x86_64")) return "x64";
  // electron-builder's Intel mac artifact names commonly omit an x64 suffix.
  return "x64";
}

function run(command, args, options = {}) {
  execFileSync(command, args, {
    cwd: PROJECT_ROOT,
    stdio: "inherit",
    timeout: 120_000,
    ...options,
  });
}

function smokeDmg(dmgPath, options) {
  if (process.platform !== "darwin") {
    throw new Error("DMG packaged app smoke requires macOS");
  }
  if (!fs.existsSync(dmgPath)) {
    throw new Error(`Missing DMG: ${dmgPath}`);
  }

  const arch = inferArchFromDmgName(dmgPath);
  const mountDir = fs.mkdtempSync(path.join(os.tmpdir(), "deus-dmg-smoke-"));
  let attached = false;

  try {
    run("hdiutil", ["attach", dmgPath, "-mountpoint", mountDir, "-nobrowse", "-readonly"]);
    attached = true;

    const appPath = path.join(mountDir, "Deus.app");
    const args = [
      path.join(PROJECT_ROOT, "scripts", "runtime", "smoke", "packaged-app.cjs"),
      "--app",
      appPath,
      "--arch",
      arch,
    ];
    if (options.requireGatekeeper) args.push("--require-gatekeeper");
    run(process.execPath, args);
  } finally {
    if (attached) {
      try {
        run("hdiutil", ["detach", mountDir, "-quiet"], { timeout: 30_000 });
      } catch {
        // Keep the original smoke failure if detach also fails.
      }
    }
    fs.rmSync(mountDir, { recursive: true, force: true });
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  for (const dmgPath of options.dmgPaths) {
    console.log(`[runtime-smoke] inspecting packaged DMG app: ${dmgPath}`);
    smokeDmg(dmgPath, options);
  }
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
