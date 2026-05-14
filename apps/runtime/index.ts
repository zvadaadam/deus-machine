#!/usr/bin/env bun

import { randomBytes } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import packageJson from "../../package.json";

const VERSION = packageJson.version;
const RUNTIME_NAME = "deus-runtime";
const DARWIN_RUNTIME_KEYS = new Set(["darwin-arm64", "darwin-x64"]);
const PACKAGED_SYSTEM_PATHS = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
const REQUIRED_BINARIES = ["deus-runtime", "codex", "claude", "gh", "rg"] as const;

type RuntimeCommand = "agent-server" | "backend" | "self-test";

interface ParsedArgs {
  command: RuntimeCommand | "version" | "help";
  dataDir?: string;
}

function usage(): string {
  return [
    `${RUNTIME_NAME} ${VERSION}`,
    "",
    "Usage:",
    `  ${RUNTIME_NAME} --version`,
    `  ${RUNTIME_NAME} self-test`,
    `  ${RUNTIME_NAME} agent-server`,
    `  ${RUNTIME_NAME} backend [--data-dir <path>]`,
  ].join("\n");
}

function parseArgs(argv: string[]): ParsedArgs {
  const [first, ...rest] = argv;
  if (!first || first === "help" || first === "--help" || first === "-h") {
    return { command: "help" };
  }
  if (first === "--version" || first === "-v" || first === "version") {
    return { command: "version" };
  }
  if (first === "self-test") return { command: "self-test" };
  if (first !== "agent-server" && first !== "backend") {
    throw new Error(`Unknown command: ${first}`);
  }

  const parsed: ParsedArgs = { command: first };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--data-dir") {
      const value = rest[++i];
      if (!value) throw new Error("--data-dir requires a path");
      parsed.dataDir = value;
      continue;
    }
    throw new Error(`Unknown ${first} option: ${arg}`);
  }

  return parsed;
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function getRuntimeKey(): string {
  return `${process.platform}-${process.arch}`;
}

function findProjectRoot(start: string): string | null {
  let current = resolve(start);
  while (true) {
    if (existsSync(join(current, "package.json")) && existsSync(join(current, "apps"))) {
      return current;
    }
    const next = dirname(current);
    if (next === current) return null;
    current = next;
  }
}

function resolveRuntimeLayout() {
  const executablePath = process.execPath;
  const executableDir = dirname(executablePath);
  const runtimeKey = getRuntimeKey();
  const isNativeRuntimeExecutable = basename(executablePath) === RUNTIME_NAME;
  const isStagedDarwinRuntime =
    DARWIN_RUNTIME_KEYS.has(basename(executableDir)) && basename(dirname(executableDir)) === "bin";
  const projectRoot = isNativeRuntimeExecutable
    ? isStagedDarwinRuntime
      ? findProjectRoot(executableDir)
      : null
    : findProjectRoot(process.cwd()) ?? findProjectRoot(resolve(executableDir, "../../.."));
  const stagedBinDir =
    projectRoot && DARWIN_RUNTIME_KEYS.has(runtimeKey)
      ? join(projectRoot, "dist", "runtime", "electron", "bin", runtimeKey)
      : null;
  const bundledBinDir = isStagedDarwinRuntime
    ? executableDir
    : stagedBinDir && existsSync(stagedBinDir)
      ? stagedBinDir
      : executableDir;
  const resourcesPath = isStagedDarwinRuntime
    ? resolve(executableDir, "../..")
    : stagedBinDir && existsSync(stagedBinDir)
      ? join(projectRoot!, "dist", "runtime", "electron")
      : dirname(executableDir);

  return {
    executablePath,
    executableDir,
    bundledBinDir,
    resourcesPath,
    projectRoot,
  };
}

function prependPath(pathValue: string | undefined, entries: string[]): string {
  return unique([...entries, ...(pathValue ?? "").split(delimiter)]).join(delimiter);
}

function deterministicPackagedPath(bundledBinDir: string): string {
  return unique([bundledBinDir, ...PACKAGED_SYSTEM_PATHS]).join(delimiter);
}

function inspectBundledBinary(binDir: string, name: (typeof REQUIRED_BINARIES)[number]) {
  const filePath = join(binDir, name);
  const exists = existsSync(filePath);
  const executable = exists ? (statSync(filePath).mode & 0o111) !== 0 : false;
  return { path: filePath, exists, executable };
}

function configureRuntimeEnv(command: RuntimeCommand, dataDir?: string): void {
  const layout = resolveRuntimeLayout();
  const isNativeRuntimeExecutable = basename(layout.executablePath) === RUNTIME_NAME;
  const runtimeNodePathCandidates = [
    join(layout.resourcesPath, "app.asar", "node_modules"),
    join(layout.resourcesPath, "app.asar.unpacked", "node_modules"),
    isNativeRuntimeExecutable && layout.projectRoot
      ? join(layout.projectRoot, "node_modules")
      : undefined,
  ];
  const nodePathCandidates = unique(
    isNativeRuntimeExecutable
      ? runtimeNodePathCandidates
      : [
          process.env.NODE_PATH,
          ...runtimeNodePathCandidates,
          layout.projectRoot ? join(layout.projectRoot, "node_modules") : undefined,
        ]
  );

  process.env.DEUS_RUNTIME = "1";
  process.env.DEUS_RUNTIME_COMMAND = command;
  if (isNativeRuntimeExecutable) {
    process.env.DEUS_RUNTIME_EXECUTABLE = layout.executablePath;
  }
  if (isNativeRuntimeExecutable) {
    process.env.DEUS_BUNDLED_BIN_DIR = layout.bundledBinDir;
    process.env.DEUS_RESOURCES_PATH = layout.resourcesPath;
  } else {
    process.env.DEUS_BUNDLED_BIN_DIR ??= layout.bundledBinDir;
    process.env.DEUS_RESOURCES_PATH ??= layout.resourcesPath;
  }
  process.env.NODE_ENV ??= "production";
  process.env.NODE_PATH = nodePathCandidates.join(delimiter);
  process.env.PATH = isNativeRuntimeExecutable
    ? deterministicPackagedPath(layout.bundledBinDir)
    : prependPath(process.env.PATH, [layout.bundledBinDir]);

  if (command === "backend") {
    process.env.AUTH_TOKEN ??= randomBytes(24).toString("hex");
    process.env.PORT ??= "0";
    if (!isNativeRuntimeExecutable && layout.projectRoot) {
      process.env.AGENT_SERVER_ENTRY ??= join(
        layout.projectRoot,
        "apps",
        "agent-server",
        "dist",
        "index.bundled.cjs"
      );
      process.env.AGENT_SERVER_CWD ??= join(layout.projectRoot, "apps", "agent-server");
    }
    if (dataDir) {
      process.env.DEUS_DATA_DIR = resolve(dataDir);
      process.env.DATABASE_PATH = join(resolve(dataDir), "deus.db");
    }
  }
}

async function run(command: RuntimeCommand, dataDir?: string): Promise<void> {
  configureRuntimeEnv(command, dataDir);

  if (command === "self-test") {
    const layout = resolveRuntimeLayout();
    const binaries = Object.fromEntries(
      REQUIRED_BINARIES.map((name) => [name, inspectBundledBinary(layout.bundledBinDir, name)])
    );
    const missing = Object.entries(binaries)
      .filter(([, result]) => !result.exists || !result.executable)
      .map(([name]) => name);
    console.log(
      JSON.stringify({
        ok: missing.length === 0,
        version: VERSION,
        executable: layout.executablePath,
        binDir: layout.bundledBinDir,
        resourcesPath: layout.resourcesPath,
        runtimeKey: getRuntimeKey(),
        binaries,
        missing,
      })
    );
    if (missing.length > 0) process.exit(1);
    return;
  }

  if (command === "agent-server") {
    await import("../agent-server/index");
    return;
  }

  await import("../backend/src/server");
}

async function main(): Promise<void> {
  let args: ParsedArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(usage());
    process.exit(2);
  }

  if (args.command === "help") {
    console.log(usage());
    return;
  }

  if (args.command === "version") {
    console.log(`${RUNTIME_NAME} ${VERSION} ${getRuntimeKey()}`);
    return;
  }

  await run(args.command, args.dataDir);
}

main().catch((error) => {
  console.error(`[${RUNTIME_NAME}]`, error);
  process.exit(1);
});
