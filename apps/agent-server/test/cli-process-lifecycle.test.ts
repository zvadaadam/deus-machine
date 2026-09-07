import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as path from "path";

/**
 * Process-level lifecycle tests for apps/agent-server/cli.ts. These reproduce
 * the two orphan scopes from the bug report by running the REAL cli.ts against
 * stub bundles (pointed at via the DEUS_CLI_BUNDLE_PATH test hook):
 *
 *   Scope A — startup-rejection orphan: a stale bundle whose `initialize` reply
 *     carries an unsupported protocolVersion makes client.initialize() reject,
 *     which previously escaped to main().catch → process.exit(1) with no
 *     reference to the spawned child (re-parented to PID 1).
 *
 *   Scope B — bare-supervisor-kill orphan: a bare `kill -TERM <parent>` uses
 *     default termination, which previously leapfrogged shutdown() and the
 *     process.on("exit") handler (the "exit" event does NOT fire on default
 *     SIGTERM under node or bun when no handler is registered).
 *
 * The stub bundles live in test/fixtures/, print LISTEN_URL, write their PID to
 * a file the test reads back, and mirror the real server's SIGINT/SIGTERM
 * handlers — so a leaked child stays alive precisely because no signal reached
 * it, not because the child ignores signals.
 */

const CLI_PATH = path.resolve(__dirname, "..", "cli.ts");
const FIXTURES = path.resolve(__dirname, "fixtures");
const STALE_BUNDLE = path.join(FIXTURES, "stale-bundle.cjs");
const VALID_BUNDLE = path.join(FIXTURES, "valid-bundle.cjs");
const STALE_PID = path.join(FIXTURES, "stale-bundle.pid");
const VALID_PID = path.join(FIXTURES, "valid-bundle.pid");

function readPid(file: string): number | null {
  if (!fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file, "utf8").trim();
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForDeath(pid: number, timeoutMs = 4000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !isAlive(pid);
}

/** Resolve once the CLI's combined stdout/stderr first contains `needle`. */
function onceOutputContains(cli: ChildProcess, needle: string, timeoutMs = 15000): Promise<void> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const onChunk = (d: Buffer) => {
      buf += d.toString();
      if (buf.includes(needle)) {
        cli.stdout?.off("data", onChunk);
        cli.stderr?.off("data", onErr);
        clearTimeout(timer);
        resolve();
      }
    };
    const onErr = onChunk;
    cli.stdout?.on("data", onChunk);
    cli.stderr?.on("data", onErr);
    const timer = setTimeout(() => {
      cli.stdout?.off("data", onChunk);
      cli.stderr?.off("data", onErr);
      reject(new Error(`timed out waiting for "${needle}". output so far:\n${buf}`));
    }, timeoutMs);
  });
}

function spawnCli(bundlePath: string, extra: string[] = []): ChildProcess {
  return spawn("bun", [CLI_PATH, ...extra], {
    env: { ...process.env, DEUS_CLI_BUNDLE_PATH: bundlePath },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

afterEach(() => {
  // Belt-and-suspenders: never let a leaked stub survive a test run, and clean
  // the PID files the stubs wrote. If the fix regresses, the assertion below
  // fires first; this just keeps the dev machine clean.
  for (const file of [STALE_PID, VALID_PID]) {
    const pid = readPid(file);
    if (pid !== null && isAlive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // ignore
      }
    }
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
});

describe("cli.ts process lifecycle — spawned server never outlives the parent", () => {
  it("Scope A: kills the spawned server when the handshake rejects (no orphan)", async () => {
    const cli = spawnCli(STALE_BUNDLE, ["--prompt", "hi"]);
    let stderr = "";
    cli.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });

    const code = await new Promise<number>((resolve) => cli.on("exit", (c) => resolve(c ?? -1)));

    // The CLI must surface the exact handshake rejection (proving the stale-
    // bundle path was reached) and exit non-zero.
    expect(code).toBe(1);
    expect(stderr).toContain("server selected unsupported protocol version: 99");

    // The stub recorded its PID when it started. After the CLI exits, the
    // spawned server must NOT still be alive re-parented to PID 1.
    const pid = readPid(STALE_PID);
    expect(pid, "stale stub should have recorded its PID at startup").not.toBeNull();
    const dead = await waitForDeath(pid!);
    expect(dead, "spawned server must be killed on startup rejection — no orphan").toBe(true);
  }, 30000);

  it("Scope B: kills the spawned server on a bare SIGTERM to the parent (no orphan)", async () => {
    // No --prompt → the CLI drops into its REPL and waits on stdin. We keep the
    // stdin pipe open, so the CLI parks in the post-connect phase where
    // shutdown() exists but a bare SIGTERM previously leapfrogged it.
    const cli = spawnCli(VALID_BUNDLE);

    const exitPromise = new Promise<number>((resolve) => cli.on("exit", (c) => resolve(c ?? -1)));

    // Wait until the CLI has connected — i.e. the state where a supervisor
    // sending SIGTERM to just the parent would previously orphan the child.
    await onceOutputContains(cli, "Connected");

    const pid = readPid(VALID_PID);
    expect(pid, "valid stub should have recorded its PID at startup").not.toBeNull();
    expect(isAlive(pid!)).toBe(true);

    // A bare kill targeting ONLY the parent PID (not the process group / cgroup
    // a systemd stop would signal). Default SIGTERM must be turned into an
    // explicit exit so the registered "exit" handler can SIGTERM the child.
    cli.kill("SIGTERM");

    const code = await exitPromise;
    expect(code).toBe(143);

    const dead = await waitForDeath(pid!);
    expect(dead, "spawned server must be killed on bare SIGTERM to parent — no orphan").toBe(true);
  }, 30000);
});
