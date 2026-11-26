#!/usr/bin/env bun

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import packageJson from "../../package.json";
import { DEUS_DB_FILENAME, PACKAGED_SYSTEM_PATHS } from "../../shared/runtime";
import { defaultDatabasePathForEnv } from "../../shared/lib/child-env";
import { configureBackendEnv } from "../backend/runtime-env";

const VERSION = packageJson.version;
const RUNTIME_NAME = "deus-runtime";

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

function getRuntimeKey(): string {
  return `${process.platform}-${process.arch}`;
}

/** The packaged app's Resources/bin/deus-runtime: its folder is the bundled
 * executables', the one above it the app's resources. The desktop names the
 * path it started (DEUS_RUNTIME_EXECUTABLE), which may differ from execPath by a symlink. */
function resolveRuntimeLayout() {
  const named = process.env.DEUS_RUNTIME_EXECUTABLE;
  const executablePath =
    named && basename(named) === RUNTIME_NAME && existsSync(named)
      ? resolve(named)
      : process.execPath;
  const bundledBinDir = dirname(executablePath);
  return { executablePath, bundledBinDir, resourcesPath: dirname(bundledBinDir) };
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
        // Exercise a shell that stays open after printing, like a workspace terminal.
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
  process.env.DEUS_PACKAGED = "1";
  process.env.DEUS_RUNTIME_EXECUTABLE = layout.executablePath;
  process.env.DEUS_BUNDLED_BIN_DIR = layout.bundledBinDir;
  process.env.DEUS_RESOURCES_PATH = layout.resourcesPath;
  // A compiled Bun finds no package by name: where its native ones are.
  process.env.DEUS_NATIVE_MODULES = join(layout.resourcesPath, "app.asar.unpacked", "node_modules");
  process.env.NODE_ENV = "production";
  process.env.PATH = [layout.bundledBinDir, ...PACKAGED_SYSTEM_PATHS].join(delimiter);

  if (command === "backend") {
    process.env.PORT ??= "0";
    if (dataDir) {
      process.env.DEUS_DATA_DIR = resolve(dataDir);
      process.env.DATABASE_PATH = join(process.env.DEUS_DATA_DIR, DEUS_DB_FILENAME);
    }
    process.env.DATABASE_PATH ||= defaultDatabasePathForEnv(process.env);
  }
}

async function run(command: RuntimeCommand, dataDir?: string): Promise<void> {
  configureBackendEnv(() => configureRuntimeEnv(command, dataDir));

  if (command === "self-test") {
    const layout = resolveRuntimeLayout();
    const checks = await inspectRuntimeChecks();
    const sqlite = await inspectSqliteContract();
    const failedChecks = Object.entries(checks)
      .filter(([, result]) => !result.ok)
      .map(([name]) => name);
    console.log(
      JSON.stringify({
        ok: failedChecks.length === 0 && sqlite.ok,
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
        checks,
        sqlite,
        failedChecks,
      })
    );
    if (failedChecks.length > 0 || !sqlite.ok) {
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
