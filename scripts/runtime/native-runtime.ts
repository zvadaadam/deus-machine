import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRuntimeStagePaths } from "../../shared/runtime";

const runtimeDir = path.dirname(fileURLToPath(import.meta.url));
const defaultProjectRoot = path.resolve(runtimeDir, "../..");
const VERIFY_TIMEOUT_MS = 20_000;
const MAC_CODESIGN_PAGE_SIZE = "4096";
const SOURCE_EXTENSIONS = new Set([".cjs", ".js", ".json", ".mjs", ".ts", ".tsx"]);
const IGNORED_SOURCE_DIRS = new Set([
  ".git",
  ".turbo",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "test",
  "tests",
  "__tests__",
]);
const REQUIRED_RUNTIME_ENTITLEMENTS = [
  "com.apple.security.cs.allow-jit",
  "com.apple.security.cs.allow-unsigned-executable-memory",
  "com.apple.security.cs.disable-library-validation",
] as const;

export const DEUS_RUNTIME_TARGETS = [
  {
    runtimeKey: "darwin-arm64",
    bunTarget: "bun-darwin-arm64",
    fileArch: "arm64",
  },
  {
    runtimeKey: "darwin-x64",
    bunTarget: "bun-darwin-x64",
    fileArch: "x86_64",
  },
] as const;

type DeusRuntimeTarget = (typeof DEUS_RUNTIME_TARGETS)[number];

interface RuntimeManifestEntry {
  runtimeKey: string;
  bunTarget: string;
  path: string;
  sha256: string;
  size: number;
  fileOutput: string;
  otoolOutput: string;
  versionOutput?: string;
}

export interface DeusRuntimeManifest {
  version: 1;
  builtAt: string;
  bunVersion: string;
  packageVersion: string;
  entries: RuntimeManifestEntry[];
}

export interface BuildDeusRuntimeOptions {
  log?: (line: string) => void;
  projectRoot?: string;
}

export interface ValidateDeusRuntimeOptions {
  log?: (line: string) => void;
  projectRoot?: string;
  runtimeKey?: string;
  verifyRunnable?: boolean;
}

function relativeFromProjectRoot(projectRoot: string, targetPath: string): string {
  return path.relative(projectRoot, targetPath).split(path.sep).join("/");
}

export function resolveDeusRuntimeManifestPath(projectRoot: string): string {
  return path.join(resolveRuntimeStagePaths(projectRoot).electron.root, "bin", "deus-runtime.json");
}

export function resolveStagedDeusRuntimePath(projectRoot: string, runtimeKey: string): string {
  return path.join(
    resolveRuntimeStagePaths(projectRoot).electron.root,
    "bin",
    runtimeKey,
    "deus-runtime"
  );
}

function hashFile(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function getHostRuntimeKey(): string | null {
  if (process.platform === "darwin" && (process.arch === "arm64" || process.arch === "x64")) {
    return `darwin-${process.arch}`;
  }
  return null;
}

function shouldVerifyRuntimeKey(runtimeKey: string): boolean {
  return getHostRuntimeKey() === runtimeKey;
}

function execOutput(command: string, args: string[], cwd: string): string {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout: VERIFY_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function spawnErrorCode(error: Error | undefined): string {
  return (error as NodeJS.ErrnoException | undefined)?.code ?? error?.message ?? "none";
}

function diagnosticOutput(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout: VERIFY_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
  if (result.error) {
    return [spawnErrorCode(result.error), output].filter(Boolean).join("\n");
  }
  if (result.status !== 0) return output || `${command} exited with status ${result.status}`;
  return output;
}

function runtimeExecutableDiagnostics(executablePath: string): string {
  if (process.platform !== "darwin") return "";
  const cwd = path.dirname(executablePath);
  return [
    `file: ${diagnosticOutput("file", [executablePath], cwd)}`,
    `codesign: ${diagnosticOutput("codesign", ["-dv", "--verbose=4", executablePath], cwd)}`,
    `spctl: ${diagnosticOutput("spctl", ["--assess", "--type", "execute", "--verbose=4", executablePath], cwd)}`,
    `xattr: ${diagnosticOutput("xattr", ["-l", executablePath], cwd) || "none"}`,
  ].join("\n");
}

function macExecutionPolicyHint(diagnostics: string): string {
  if (process.platform !== "darwin") return "";
  if (!/spctl:[\s\S]*rejected/.test(diagnostics)) return "";
  if (!/com\.apple\.(provenance|quarantine)/.test(diagnostics)) return "";

  return [
    "",
    "macOS rejected this executable before --version produced output.",
    "Verify runnable staged runtime binaries on a notarized artifact or a macOS host that allows generated Mach-O binaries to launch.",
  ].join("\n");
}

function readPackageVersion(projectRoot: string): string {
  const packageJsonPath = path.join(projectRoot, "package.json");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version?: unknown };
  if (typeof packageJson.version !== "string" || packageJson.version.length === 0) {
    throw new Error(`package.json is missing a string version: ${packageJsonPath}`);
  }
  return packageJson.version;
}

function latestSourceMtime(projectRoot: string, sourceRelatives: string[]) {
  let latest: { mtimeMs: number; path: string | null } = { mtimeMs: 0, path: null };

  function visit(sourcePath: string): void {
    if (!existsSync(sourcePath)) return;
    const stat = statSync(sourcePath);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(sourcePath, { withFileTypes: true })) {
        if (IGNORED_SOURCE_DIRS.has(entry.name)) continue;
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

function assertRuntimeFresh(projectRoot: string, executablePath: string, runtimeKey: string): void {
  const latestSource = latestSourceMtime(projectRoot, [
    "apps/runtime",
    "apps/backend/src",
    "apps/agent-server",
    "shared",
    "resources/entitlements.runtime.plist",
  ]);
  if (!latestSource.path) return;
  if (statSync(executablePath).mtimeMs >= latestSource.mtimeMs) return;

  throw new Error(
    `${runtimeKey}/deus-runtime is stale: ${relativeFromProjectRoot(
      projectRoot,
      executablePath
    )} is older than ${relativeFromProjectRoot(projectRoot, latestSource.path)}. Run \`bun run build:runtime\` before packaging.`
  );
}

function assertExecutable(filePath: string, label: string): void {
  if (!existsSync(filePath)) {
    throw new Error(`Missing ${label}: ${filePath}`);
  }
  const stat = statSync(filePath);
  if (!stat.isFile()) {
    throw new Error(`Expected ${label} to be a regular file: ${filePath}`);
  }
  if ((stat.mode & 0o111) === 0) {
    throw new Error(`Expected ${label} to be executable: ${filePath}`);
  }
}

function assertFileArch(fileOutput: string, target: DeusRuntimeTarget, filePath: string): void {
  if (!fileOutput.includes("Mach-O 64-bit executable") || !fileOutput.includes(target.fileArch)) {
    throw new Error(`Unexpected file(1) output for ${filePath}: ${fileOutput}`);
  }
}

function resolveCodeSigningIdentity(): string {
  const explicitIdentity = process.env.DEUS_RUNTIME_CODESIGN_IDENTITY || process.env.CSC_NAME;
  if (explicitIdentity) return explicitIdentity;
  if (process.platform !== "darwin") return "-";

  try {
    const output = execFileSync("security", ["find-identity", "-v", "-p", "codesigning"], {
      encoding: "utf8",
      timeout: VERIFY_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const identities = output
      .split(/\r?\n/)
      .map((line) => line.match(/"([^"]+)"/)?.[1])
      .filter((identity): identity is string => Boolean(identity));
    return (
      identities.find((identity) => identity.startsWith("Developer ID Application:")) ??
      identities.find((identity) => identity.startsWith("Apple Development:")) ??
      "-"
    );
  } catch {
    return "-";
  }
}

function resolveRuntimeEntitlementsPath(projectRoot: string): string {
  return path.join(projectRoot, "resources", "entitlements.runtime.plist");
}

function signMacExecutable(filePath: string, projectRoot: string): void {
  if (process.platform !== "darwin") return;
  const entitlementsPath = resolveRuntimeEntitlementsPath(projectRoot);
  if (!existsSync(entitlementsPath)) {
    throw new Error(`Missing Deus runtime entitlements: ${entitlementsPath}`);
  }
  const identity = resolveCodeSigningIdentity();
  const result = spawnSync(
    "codesign",
    [
      "--force",
      "--options",
      "runtime",
      "--pagesize",
      MAC_CODESIGN_PAGE_SIZE,
      "--identifier",
      "deus-runtime",
      "--entitlements",
      entitlementsPath,
      "--sign",
      identity,
      filePath,
    ],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  if (result.status !== 0) {
    throw new Error(`Failed to sign ${filePath}: ${result.stderr || result.stdout}`);
  }
}

function verifyMacCodeSignature(filePath: string): void {
  if (process.platform !== "darwin") return;
  const result = spawnSync("codesign", ["--verify", "--verbose=2", filePath], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(`Invalid code signature for ${filePath}: ${result.stderr || result.stdout}`);
  }
}

function verifyMacCodeSignaturePageSize(filePath: string): void {
  if (process.platform !== "darwin") return;
  const result = spawnSync("codesign", ["-dv", "--verbose=4", filePath], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(
      `Unable to inspect code signature for ${filePath}: ${result.stderr || result.stdout}`
    );
  }
  const output = `${result.stdout}\n${result.stderr}`;
  if (!output.includes(`Page size=${MAC_CODESIGN_PAGE_SIZE}`)) {
    throw new Error(
      `Unexpected code signature page size for ${filePath}; expected ${MAC_CODESIGN_PAGE_SIZE}`
    );
  }
}

function readMacEntitlements(filePath: string): string {
  const result = spawnSync("codesign", ["-d", "--entitlements", ":-", filePath], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(`Unable to read entitlements for ${filePath}: ${result.stderr || result.stdout}`);
  }
  return `${result.stdout}\n${result.stderr}`;
}

function verifyMacSystemDylibs(otoolOutput: string, filePath: string): void {
  if (process.platform !== "darwin") return;
  const unexpected = otoolOutput
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim().split(/\s+/)[0])
    .filter(Boolean)
    .filter(
      (dependency) =>
        !dependency.startsWith("/usr/lib/") && !dependency.startsWith("/System/Library/")
    );
  if (unexpected.length > 0) {
    throw new Error(
      `Unexpected non-system dylib dependency for ${filePath}: ${unexpected.join(", ")}`
    );
  }
}

function verifyMacRuntimeEntitlements(filePath: string): void {
  if (process.platform !== "darwin") return;
  const entitlements = readMacEntitlements(filePath);
  for (const entitlement of REQUIRED_RUNTIME_ENTITLEMENTS) {
    if (!entitlements.includes(entitlement)) {
      throw new Error(`Missing ${entitlement} entitlement for ${filePath}`);
    }
  }
}

export function buildDeusRuntime(options: BuildDeusRuntimeOptions = {}): DeusRuntimeManifest {
  const log = options.log ?? console.log;
  const projectRoot = options.projectRoot ?? defaultProjectRoot;
  const entry = path.join(projectRoot, "apps", "runtime", "index.ts");
  const bunVersion = execOutput("bun", ["--version"], projectRoot);
  const packageVersion = readPackageVersion(projectRoot);
  const entries: RuntimeManifestEntry[] = [];

  for (const target of DEUS_RUNTIME_TARGETS) {
    const output = resolveStagedDeusRuntimePath(projectRoot, target.runtimeKey);
    mkdirSync(path.dirname(output), { recursive: true });
    rmSync(output, { force: true });

    const result = spawnSync(
      "bun",
      [
        "build",
        entry,
        "--compile",
        `--target=${target.bunTarget}`,
        "--sourcemap=none",
        `--outfile=${output}`,
        "--external",
        "better-sqlite3",
        "--external",
        "node-pty",
        "--external",
        "@napi-rs/canvas",
        "--external",
        "@napi-rs/canvas-darwin-arm64",
        "--external",
        "@napi-rs/canvas-darwin-x64",
      ],
      {
        cwd: projectRoot,
        stdio: "inherit",
      }
    );
    if (result.status !== 0) {
      throw new Error(`Failed to build ${target.runtimeKey}/deus-runtime`);
    }

    chmodSync(output, 0o755);
    signMacExecutable(output, projectRoot);
    const fileOutput = execOutput("file", [output], projectRoot);
    assertFileArch(fileOutput, target, output);
    const otoolOutput = execOutput("otool", ["-L", output], projectRoot);
    verifyMacSystemDylibs(otoolOutput, output);
    verifyMacCodeSignature(output);
    verifyMacCodeSignaturePageSize(output);
    verifyMacRuntimeEntitlements(output);

    const entryRecord: RuntimeManifestEntry = {
      runtimeKey: target.runtimeKey,
      bunTarget: target.bunTarget,
      path: relativeFromProjectRoot(projectRoot, output),
      sha256: hashFile(output),
      size: statSync(output).size,
      fileOutput,
      otoolOutput,
    };

    log(`✓ ${target.runtimeKey}/deus-runtime ${fileOutput}`);

    entries.push(entryRecord);
  }

  const manifest: DeusRuntimeManifest = {
    version: 1,
    builtAt: new Date().toISOString(),
    bunVersion,
    packageVersion,
    entries,
  };
  const manifestPath = resolveDeusRuntimeManifestPath(projectRoot);
  mkdirSync(path.dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  log(`✓ Native runtime manifest written (${relativeFromProjectRoot(projectRoot, manifestPath)})`);
  return manifest;
}

export function verifyStagedDeusRuntimeVersion(executablePath: string): string {
  const result = spawnSync(executablePath, ["--version"], {
    encoding: "utf8",
    timeout: VERIFY_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = (result.stdout || "").trim();
  if (result.status !== 0) {
    const stderr = (result.stderr || "").trim();
    const diagnostics = runtimeExecutableDiagnostics(executablePath);
    const hint = macExecutionPolicyHint(diagnostics);
    throw new Error(
      `deus-runtime --version failed for ${executablePath}: status=${result.status} signal=${
        result.signal
      } error=${spawnErrorCode(result.error)} stdout=${output} stderr=${stderr}${
        diagnostics ? `\n${diagnostics}` : ""
      }${hint}`
    );
  }
  if (!/^deus-runtime \d+\.\d+\.\d+ /.test(output)) {
    throw new Error(`Unexpected deus-runtime --version output for ${executablePath}: ${output}`);
  }
  return output;
}

export function validateDeusRuntime(options: ValidateDeusRuntimeOptions = {}): DeusRuntimeManifest {
  const log = options.log ?? console.log;
  const projectRoot = options.projectRoot ?? defaultProjectRoot;
  const manifestPath = resolveDeusRuntimeManifestPath(projectRoot);
  if (!existsSync(manifestPath)) {
    throw new Error(`Missing native runtime manifest: ${manifestPath}`);
  }

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as DeusRuntimeManifest;
  const packageVersion = readPackageVersion(projectRoot);
  if (manifest.packageVersion !== packageVersion) {
    throw new Error(
      `Native runtime manifest package version mismatch: expected ${packageVersion}, found ${
        manifest.packageVersion ?? "missing"
      }. Run \`bun run build:runtime\` before packaging.`
    );
  }
  const runtimeKeys = options.runtimeKey
    ? [options.runtimeKey]
    : DEUS_RUNTIME_TARGETS.map((target) => target.runtimeKey);

  for (const runtimeKey of runtimeKeys) {
    const target = DEUS_RUNTIME_TARGETS.find((item) => item.runtimeKey === runtimeKey);
    if (!target) throw new Error(`Unsupported native runtime key: ${runtimeKey}`);

    const executablePath = resolveStagedDeusRuntimePath(projectRoot, runtimeKey);
    assertExecutable(executablePath, `${runtimeKey}/deus-runtime`);
    assertRuntimeFresh(projectRoot, executablePath, runtimeKey);
    const manifestEntry = manifest.entries.find((entry) => entry.runtimeKey === runtimeKey);
    if (!manifestEntry) throw new Error(`Native runtime manifest is missing ${runtimeKey}`);
    const expectedPath = relativeFromProjectRoot(projectRoot, executablePath);
    if (manifestEntry.path !== expectedPath) {
      throw new Error(
        `Native runtime manifest path mismatch for ${runtimeKey}: expected ${expectedPath}, found ${manifestEntry.path}`
      );
    }
    if (manifestEntry.sha256 !== hashFile(executablePath)) {
      throw new Error(`Native runtime manifest hash mismatch for ${runtimeKey}`);
    }
    const fileOutput = execOutput("file", [executablePath], projectRoot);
    assertFileArch(fileOutput, target, executablePath);
    const otoolOutput = execOutput("otool", ["-L", executablePath], projectRoot);
    verifyMacSystemDylibs(otoolOutput, executablePath);
    if (manifestEntry.size !== statSync(executablePath).size) {
      throw new Error(`Native runtime manifest size mismatch for ${runtimeKey}`);
    }
    if (manifestEntry.fileOutput !== fileOutput) {
      throw new Error(`Native runtime manifest file output mismatch for ${runtimeKey}`);
    }
    if (manifestEntry.otoolOutput !== otoolOutput) {
      throw new Error(`Native runtime manifest otool output mismatch for ${runtimeKey}`);
    }
    verifyMacCodeSignature(executablePath);
    verifyMacCodeSignaturePageSize(executablePath);
    verifyMacRuntimeEntitlements(executablePath);

    if (options.verifyRunnable === true && shouldVerifyRuntimeKey(runtimeKey)) {
      const version = verifyStagedDeusRuntimeVersion(executablePath);
      log(`✓ ${runtimeKey}/deus-runtime ${version}`);
    }
  }

  log(`✓ Native runtime ready (${runtimeKeys.join(", ")})`);
  return manifest;
}
