#!/usr/bin/env bun

import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { Module as NodeModule } from "node:module";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import packageJson from "../../package.json";

const VERSION = packageJson.version;
const RUNTIME_NAME = "deus-runtime";
const DARWIN_RUNTIME_KEYS = new Set(["darwin-arm64", "darwin-x64"]);
const PACKAGED_SYSTEM_PATHS = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
const REQUIRED_BINARIES = ["deus-runtime", "codex", "claude", "gh", "rg", "agent-browser"] as const;
const REQUIRED_RUNTIME_IMPORTS = [
  {
    name: "@anthropic-ai/claude-agent-sdk",
    load: async () => {
      const module = await import("@anthropic-ai/claude-agent-sdk");
      if (typeof module.query !== "function") {
        throw new Error("missing query export");
      }
    },
  },
  {
    name: "@openai/codex-sdk",
    load: async () => {
      const module = await import("@openai/codex-sdk");
      if (typeof module.Codex !== "function") {
        throw new Error("missing Codex export");
      }
    },
  },
  {
    name: "@hono/node-server",
    load: async () => {
      const module = await import("@hono/node-server");
      if (typeof module.serve !== "function") {
        throw new Error("missing serve export");
      }
    },
  },
] as const;

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
    : (findProjectRoot(process.cwd()) ?? findProjectRoot(resolve(executableDir, "../../..")));
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

function refreshNodePathResolution(): void {
  const moduleWithInitPaths = NodeModule as typeof NodeModule & {
    _initPaths?: () => void;
  };
  moduleWithInitPaths._initPaths?.();
}

function inspectBundledBinary(binDir: string, name: (typeof REQUIRED_BINARIES)[number]) {
  const filePath = join(binDir, name);
  const exists = existsSync(filePath);
  const executable = exists ? (statSync(filePath).mode & 0o111) !== 0 : false;
  return { path: filePath, exists, executable };
}

async function inspectRuntimeImports() {
  const results: Record<string, { ok: boolean; error?: string }> = {};

  for (const item of REQUIRED_RUNTIME_IMPORTS) {
    try {
      await item.load();
      results[item.name] = { ok: true };
    } catch (error) {
      results[item.name] = {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
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
  const runtimeNodePathCandidates = [
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
  if (isNativeRuntimeExecutable) {
    process.env.NODE_ENV = "production";
  } else {
    process.env.NODE_ENV ??= "production";
  }
  process.env.NODE_PATH = nodePathCandidates.join(delimiter);
  refreshNodePathResolution();
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
    const imports = await inspectRuntimeImports();
    const sqlite = await inspectSqliteContract();
    const missing = Object.entries(binaries)
      .filter(([, result]) => !result.exists || !result.executable)
      .map(([name]) => name);
    const failedImports = Object.entries(imports)
      .filter(([, result]) => !result.ok)
      .map(([name]) => name);
    console.log(
      JSON.stringify({
        ok: missing.length === 0 && failedImports.length === 0 && sqlite.ok,
        version: VERSION,
        executable: layout.executablePath,
        binDir: layout.bundledBinDir,
        resourcesPath: layout.resourcesPath,
        nodeEnv: process.env.NODE_ENV ?? "",
        nodePath: process.env.NODE_PATH ?? "",
        pathEnv: process.env.PATH ?? "",
        nodeGlobalPaths: NodeModule.globalPaths,
        runtimeKey: getRuntimeKey(),
        binaries,
        imports,
        sqlite,
        missing,
        failedImports,
      })
    );
    if (missing.length > 0 || failedImports.length > 0 || !sqlite.ok) process.exit(1);
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
