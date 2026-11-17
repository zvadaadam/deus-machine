#!/usr/bin/env bun

import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import packageJson from "../../package.json";
import { PACKAGED_SYSTEM_PATHS } from "../../shared/runtime";

const VERSION = packageJson.version;
const RUNTIME_NAME = "deus-runtime";
const STAGED_RUNTIME_KEYS = new Set(["darwin-arm64", "darwin-x64", "linux-x64"]);
const REQUIRED_BINARIES = ["deus-runtime", "codex", "claude", "gh", "rg", "agent-browser"] as const;
const REQUIRED_SIMULATOR_HELPERS = ["simbridge", "siminspector.dylib"] as const;

type RuntimeCommand = "backend" | "self-test";

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
  if (first !== "backend") {
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

function isSourceRuntimeInvocation(): boolean {
  return process.argv.some((candidate) => candidate.endsWith(join("apps", "runtime", "index.ts")));
}

function isExecutableFile(filePath: string): boolean {
  if (!existsSync(filePath)) return false;
  const stat = statSync(filePath);
  if (!stat.isFile()) return false;
  return (stat.mode & 0o111) !== 0;
}

function runtimeExecutableInDirectory(dir: string | undefined): string | null {
  if (!dir) return null;
  const candidate = join(dir, RUNTIME_NAME);
  return isExecutableFile(candidate) ? candidate : null;
}

function resolveRuntimeExecutablePath(): string {
  const explicitRuntimeExecutable = process.env.DEUS_RUNTIME_EXECUTABLE;
  if (
    explicitRuntimeExecutable &&
    basename(explicitRuntimeExecutable) === RUNTIME_NAME &&
    isExecutableFile(explicitRuntimeExecutable)
  ) {
    return resolve(explicitRuntimeExecutable);
  }

  for (const candidate of [process.execPath, process.argv[0], process.argv[1]]) {
    if (candidate && basename(candidate) === RUNTIME_NAME) {
      return resolve(candidate);
    }
  }

  if (!isSourceRuntimeInvocation()) {
    const cwdExecutable = runtimeExecutableInDirectory(process.cwd());
    if (cwdExecutable) return resolve(cwdExecutable);

    const firstPathEntry = process.env.PATH?.split(delimiter).find(Boolean);
    const pathExecutable = runtimeExecutableInDirectory(firstPathEntry);
    if (pathExecutable) return resolve(pathExecutable);
  }

  return process.execPath;
}

function resolveRuntimeLayout() {
  const executablePath = resolveRuntimeExecutablePath();
  const executableDir = dirname(executablePath);
  const runtimeKey = getRuntimeKey();
  const isNativeRuntimeExecutable = basename(executablePath) === RUNTIME_NAME;
  const isStagedRuntime =
    STAGED_RUNTIME_KEYS.has(basename(executableDir)) && basename(dirname(executableDir)) === "bin";
  const projectRoot = isNativeRuntimeExecutable
    ? isStagedRuntime
      ? findProjectRoot(executableDir)
      : null
    : (findProjectRoot(process.cwd()) ?? findProjectRoot(resolve(executableDir, "../../..")));
  const stagedBinDir =
    projectRoot && STAGED_RUNTIME_KEYS.has(runtimeKey)
      ? join(projectRoot, "dist", "runtime", "electron", "bin", runtimeKey)
      : null;
  const bundledBinDir = isStagedRuntime
    ? executableDir
    : stagedBinDir && existsSync(stagedBinDir)
      ? stagedBinDir
      : executableDir;
  const resourcesPath = isStagedRuntime
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

function inspectSimulatorHelper(
  resourcesPath: string,
  name: (typeof REQUIRED_SIMULATOR_HELPERS)[number]
) {
  const filePath = join(resourcesPath, "simulator", name);
  const exists = existsSync(filePath);
  const executable = exists ? (statSync(filePath).mode & 0o111) !== 0 : false;
  return { path: filePath, exists, executable };
}

/** What the runtime loads from outside itself, each as the backend does: a
 * terminal (Bun's own, through the PTY service) and the canvas (from disk). */
const RUNTIME_CHECKS = {
  terminal: async () => {
    const { openTerminal } = await import("../backend/src/services/pty.service");
    let output = "";
    const exitCode = await new Promise<number | null>((resolveExit, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`no exit; output ${JSON.stringify(output)}`)),
        10_000
      );
      openTerminal({
        // Not a bare /bin/echo: see openTerminal on output Bun drops at exit.
        command: "/bin/sh",
        args: ["-c", "echo deus-runtime-terminal; sleep 0.1"],
        cols: 80,
        rows: 24,
        cwd: tmpdir(),
        env: { PATH: process.env.PATH ?? "" },
        onData: (bytes) => (output += Buffer.from(bytes).toString()),
        onExit: (code) => (clearTimeout(timer), resolveExit(code)),
      });
    });
    if (exitCode !== 0 || !output.includes("deus-runtime-terminal")) {
      throw new Error(`exit ${exitCode}, output ${JSON.stringify(output)}`);
    }
  },
  canvas: async () => {
    const { loadCanvas } = await import("../../packages/screen-studio/src/render/painter");
    const canvas = await loadCanvas();
    if (!canvas) throw new Error("@napi-rs/canvas did not load");
    const png = await canvas.createCanvas(8, 8).encode("png");
    if (png.length === 0) throw new Error("empty PNG");
  },
};

async function inspectRuntimeChecks() {
  const results: Record<string, { ok: boolean; error?: string }> = {};
  for (const [name, check] of Object.entries(RUNTIME_CHECKS)) {
    try {
      await check();
      results[name] = { ok: true };
    } catch (error) {
      results[name] = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
  return results;
}

async function inspectSqliteContract() {
  const tempDir = mkdtempSync(join(tmpdir(), "deus-runtime-sqlite-"));
  try {
    const { openSqliteDatabase } = await import("../backend/src/lib/sqlite");
    const db = openSqliteDatabase(join(tempDir, "contract.db"));
    try {
      db.pragma("journal_mode = WAL");
      db.exec("CREATE TABLE items (id TEXT PRIMARY KEY, value TEXT NOT NULL)");
      db.prepare("INSERT INTO items (id, value) VALUES (?, ?)").run("a", "one");

      const row = db.prepare("SELECT value FROM items WHERE id = ?").get("a") as
        | { value?: unknown }
        | undefined;
      if (row?.value !== "one") {
        throw new Error(`unexpected select result: ${JSON.stringify(row)}`);
      }

      const rows = db.prepare("SELECT value FROM items ORDER BY id").all() as Array<{
        value?: unknown;
      }>;
      if (rows.length !== 1 || rows[0]?.value !== "one") {
        throw new Error(`unexpected all result: ${JSON.stringify(rows)}`);
      }

      db.transaction(() => {
        db.prepare("INSERT INTO items (id, value) VALUES (?, ?)").run("b", "two");
      })();

      const count = db.prepare("SELECT count(*) as count FROM items").get() as
        | { count?: unknown }
        | undefined;
      if (Number(count?.count) !== 2) {
        throw new Error(`unexpected transaction count: ${JSON.stringify(count)}`);
      }
    } finally {
      db.close();
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function configureRuntimeEnv(command: RuntimeCommand, dataDir?: string): void {
  const layout = resolveRuntimeLayout();
  const isNativeRuntimeExecutable = basename(layout.executablePath) === RUNTIME_NAME;
  process.env.DEUS_RUNTIME = "1";
  process.env.DEUS_RUNTIME_COMMAND = command;
  if (isNativeRuntimeExecutable) {
    process.env.DEUS_RUNTIME_EXECUTABLE = layout.executablePath;
  }
  if (isNativeRuntimeExecutable) {
    process.env.DEUS_BUNDLED_BIN_DIR = layout.bundledBinDir;
    process.env.DEUS_RESOURCES_PATH = layout.resourcesPath;
    // A compiled Bun finds no package by name: where its native ones are.
    process.env.DEUS_NATIVE_MODULES = layout.projectRoot
      ? join(layout.projectRoot, "node_modules")
      : join(layout.resourcesPath, "app.asar.unpacked", "node_modules");
  } else {
    process.env.DEUS_BUNDLED_BIN_DIR ??= layout.bundledBinDir;
    process.env.DEUS_RESOURCES_PATH ??= layout.resourcesPath;
  }
  if (isNativeRuntimeExecutable) {
    process.env.NODE_ENV = "production";
  } else {
    process.env.NODE_ENV ??= "production";
  }
  process.env.PATH = isNativeRuntimeExecutable
    ? deterministicPackagedPath(layout.bundledBinDir)
    : prependPath(process.env.PATH, [layout.bundledBinDir]);

  if (command === "backend") {
    process.env.AUTH_TOKEN ??= randomBytes(24).toString("hex");
    process.env.PORT ??= "0";
    if (dataDir) {
      process.env.DEUS_DATA_DIR = resolve(dataDir);
      process.env.DATABASE_PATH = join(resolve(dataDir), "deus.db");
    }
  }
}

/** A macOS app bundle ships the simulator helpers; staged and source runtimes have none. */
function isMacAppBundle(resourcesPath: string): boolean {
  return (
    process.platform === "darwin" &&
    basename(resourcesPath) === "Resources" &&
    basename(dirname(resourcesPath)) === "Contents"
  );
}

async function run(command: RuntimeCommand, dataDir?: string): Promise<void> {
  configureRuntimeEnv(command, dataDir);

  if (command === "self-test") {
    const layout = resolveRuntimeLayout();
    const binaries = Object.fromEntries(
      REQUIRED_BINARIES.map((name) => [name, inspectBundledBinary(layout.bundledBinDir, name)])
    );
    const simulatorHelpers = Object.fromEntries(
      REQUIRED_SIMULATOR_HELPERS.map((name) => [
        name,
        inspectSimulatorHelper(layout.resourcesPath, name),
      ])
    );
    const requireSimulatorHelpers = isMacAppBundle(layout.resourcesPath);
    const checks = await inspectRuntimeChecks();
    const sqlite = await inspectSqliteContract();
    const missing = Object.entries(binaries)
      .filter(([, result]) => !result.exists || !result.executable)
      .map(([name]) => name);
    const missingSimulatorHelpers = Object.entries(simulatorHelpers)
      .filter(([, result]) => requireSimulatorHelpers && (!result.exists || !result.executable))
      .map(([name]) => name);
    const failedChecks = Object.entries(checks)
      .filter(([, result]) => !result.ok)
      .map(([name]) => name);
    console.log(
      JSON.stringify({
        ok:
          missing.length === 0 &&
          missingSimulatorHelpers.length === 0 &&
          failedChecks.length === 0 &&
          sqlite.ok,
        version: VERSION,
        executable: layout.executablePath,
        execPath: process.execPath,
        argv: process.argv,
        cwd: process.cwd(),
        binDir: layout.bundledBinDir,
        resourcesPath: layout.resourcesPath,
        nodeEnv: process.env["NODE_ENV"] ?? "",
        pathEnv: process.env.PATH ?? "",
        runtimeKey: getRuntimeKey(),
        binaries,
        simulatorHelpers,
        checks,
        sqlite,
        requireSimulatorHelpers,
        missing,
        missingSimulatorHelpers,
        failedChecks,
      })
    );
    if (
      missing.length > 0 ||
      missingSimulatorHelpers.length > 0 ||
      failedChecks.length > 0 ||
      !sqlite.ok
    ) {
      process.exit(1);
    }
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
