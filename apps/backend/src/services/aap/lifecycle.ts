// apps/backend/src/services/aap/lifecycle.ts
// Process lifecycle primitives for AAP apps.
//
// Stateless — just spawn + probe + stop + alive-check. No DB access, no
// bookkeeping. apps.service composes these and owns all state.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { isAbsolute, join, resolve as resolvePath } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { match } from "ts-pattern";

import type { Manifest, ReadyProbe } from "@shared/aap/manifest";
import {
  substituteArgs,
  substituteEnv,
  substituteTemplate,
  type TemplateVars,
} from "@shared/aap/template";

import { resolveRepoRoot } from "../../lib/repo-root";

// ----------------------------------------------------------------------------
// spawn
// ----------------------------------------------------------------------------

export interface SpawnArgs {
  manifest: Manifest;
  vars: TemplateVars & { port: number };
  /** Fallback working directory when manifest doesn't declare `launch.cwd`. */
  packageRoot: string;
  /** Called once when the child exits (normally or via signal). */
  onExit(code: number | null, signal: NodeJS.Signals | null, stderrTail: string): void;
  /** Called once if the child never spawns (ENOENT, EACCES, invalid cwd).
   *  Node emits this asynchronously on the ChildProcess; without a handler
   *  it terminates the whole backend. Callers that care about distinguishing
   *  spawn-failure from clean-exit should pass this. */
  onError?(err: Error): void;
}

export interface Spawned {
  child: ChildProcess;
  pid: number;
  port: number;
  /** Snapshot of the current stdout ring buffer. Safe to call any time —
   *  the ring is retained by closure, not consumed on read. */
  getStdout(): string;
  /** Snapshot of the current stderr ring buffer. Same semantics as stdout. */
  getStderr(): string;
}

/** Each "data" event is one chunk (a Buffer.toString()), not a line. The
 *  ring caps chunk count so we don't buffer megabytes of stdout from a
 *  chatty child while still preserving the most recent crash context. */
const RING_MAX_CHUNKS = 50;

export function spawnApp(args: SpawnArgs): Spawned {
  const { manifest, vars, packageRoot, onExit, onError } = args;
  const { launch } = manifest;

  const cmdArgs = substituteArgs(launch.args, vars);
  // Anchor a relative `launch.cwd` (e.g. `"."` or `"./server"`) to the app's
  // package root, NOT the backend's process cwd. Manifests are written
  // relative to the package they live in.
  const rawCwd = launch.cwd ? substituteTemplate(launch.cwd, vars) : packageRoot;
  const cwd = isAbsolute(rawCwd) ? rawCwd : resolvePath(packageRoot, rawCwd);
  const resolvedCommand = resolveCommand(launch.command, packageRoot);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...substituteEnv(launch.env, vars),
    DEUS_APP_ID: manifest.id,
    DEUS_WORKSPACE_ID: vars.workspace ?? "",
    DEUS_PORT: String(vars.port),
  };

  const child = spawn(resolvedCommand, cmdArgs, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Critical: attach the "error" listener BEFORE any early-return. Node
  // emits "error" asynchronously on ENOENT/EACCES even when the caller
  // never uses the ChildProcess further. An unhandled "error" on an
  // EventEmitter terminates Node — this must never happen on AAP spawns.
  const stdoutRing: string[] = [];
  const stderrRing: string[] = [];
  const getStdout = (): string => stdoutRing.join("");
  const getStderr = (): string => stderrRing.join("");

  const pushBounded = (ring: string[], chunk: Buffer): void => {
    ring.push(chunk.toString("utf8"));
    while (ring.length > RING_MAX_CHUNKS) ring.shift();
  };

  child.stdout?.on("data", (chunk: Buffer) => pushBounded(stdoutRing, chunk));
  child.stderr?.on("data", (chunk: Buffer) => pushBounded(stderrRing, chunk));

  // Dedupe: ENOENT can fire both "error" and "exit" on the same ChildProcess.
  // First event wins; the other is ignored.
  let finalized = false;
  const finalizeExit = (
    code: number | null,
    signal: NodeJS.Signals | null,
    stderrTail: string
  ): void => {
    if (finalized) return;
    finalized = true;
    onExit(code, signal, stderrTail);
  };

  child.once("error", (err: Error) => {
    if (onError) onError(err);
    finalizeExit(null, null, getStderr());
  });

  // We finalize on "exit", NOT "close". Close is technically safer for
  // flushing late stderr — but on Linux it only fires once EVERY writer to
  // the pipe has closed, and an unkillable `sh -c "sleep 30"` leaves `sleep`
  // as an orphan holding the fd open long after the shell exits. That
  // blocks finalization forever (the SIGTERM lifecycle test hangs its 10s
  // timeout on CI). The ring buffer already captures the chunks delivered
  // up to the exit moment — for crash diagnostics, that's the material
  // signal; a few trailing bytes from a flush that hasn't happened yet are
  // not worth the cross-platform hang.
  child.once("exit", (code, signal) => {
    finalizeExit(code, signal, getStderr());
  });

  // Now safe to early-return: even if we throw, the "error" listener above
  // will swallow the async ENOENT emission. Message includes ENOENT-ish hint
  // so the caller's error surface mentions the real cause on sync-detected
  // spawn failures (bun detects ENOENT synchronously on some platforms).
  if (!child.pid) {
    throw new Error(`spawn ENOENT or similar: ${launch.command} could not be started`);
  }

  return { child, pid: child.pid, port: vars.port, getStdout, getStderr };
}

// ----------------------------------------------------------------------------
// ready probe
// ----------------------------------------------------------------------------

const PROBE_INTERVAL_MS = 200;
const PROBE_SINGLE_ATTEMPT_TIMEOUT_MS = 1_000;

/** Poll the app until the ready probe succeeds. The caller owns the timeout
 *  via the AbortSignal — we loop until it fires. This keeps the single
 *  source of truth for "how long are we willing to wait" in apps.service,
 *  which also uses the same signal to abort on spawn errors (so we don't
 *  wait the full probe timeout when the binary is missing). */
export async function waitForReady(
  probe: ReadyProbe,
  port: number,
  abort: AbortSignal
): Promise<void> {
  while (true) {
    if (abort.aborted) throw new Error("aap/lifecycle: ready probe aborted");
    const ok = await probeOnce(probe, port);
    if (ok) return;
    try {
      await sleep(PROBE_INTERVAL_MS, undefined, { signal: abort });
    } catch {
      throw new Error("aap/lifecycle: ready probe aborted");
    }
  }
}

async function probeOnce(probe: ReadyProbe, port: number): Promise<boolean> {
  try {
    return await match(probe)
      .with({ type: "http" }, (p) => probeHttp(port, p.path))
      .with({ type: "tcp" }, () => probeTcp(port))
      .exhaustive();
  } catch {
    return false;
  }
}

async function probeHttp(port: number, path: string): Promise<boolean> {
  const url = `http://127.0.0.1:${port}${path}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(PROBE_SINGLE_ATTEMPT_TIMEOUT_MS) });
    return res.ok;
  } catch {
    return false;
  }
}

function probeTcp(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (ok: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(PROBE_SINGLE_ATTEMPT_TIMEOUT_MS);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
  });
}

// ----------------------------------------------------------------------------
// stop
// ----------------------------------------------------------------------------

/** SIGTERM the child, wait `stopTimeoutMs`, SIGKILL if still alive.
 *  Returns the exit code (or null when the child exited via signal). */
export async function stopChild(
  child: ChildProcess,
  stopTimeoutMs: number
): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return child.exitCode;

  const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
    }
  );

  try {
    child.kill("SIGTERM");
  } catch {
    /* already dead */
  }

  const TIMED_OUT = "__aap_timed_out__" as const;
  const raced: { code: number | null; signal: NodeJS.Signals | null } | typeof TIMED_OUT =
    await Promise.race([exitPromise, sleep(stopTimeoutMs).then(() => TIMED_OUT)]);

  if (raced === TIMED_OUT) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already dead */
    }
    // Hard ceiling on the post-SIGKILL wait. SIGKILL is uninterruptible, so
    // healthy processes exit in ms — but a process stuck in kernel D state
    // (uninterruptible IO) or an exit event that was missed (advisory
    // `exitCode`/`signalCode` guard above can race) will hang this forever.
    // After the ceiling, consider the child done; the pid journal sweep will
    // kill it on next boot if it's somehow still alive.
    const SIGKILL_WAIT_CEILING_MS = 2_000;
    const final = await Promise.race([
      exitPromise,
      sleep(SIGKILL_WAIT_CEILING_MS).then(
        () => ({ code: null, signal: "SIGKILL" as NodeJS.Signals }) as const
      ),
    ]);
    return final.code;
  }
  return raced.code;
}

// ----------------------------------------------------------------------------
// command resolution
// ----------------------------------------------------------------------------

/** Resolve an app's `launch.command` to an absolute path. Matches the AAP
 *  spec's "PATH, then app package's bin/" intent by trying, in order:
 *
 *    1. absolute command → as-is
 *    2. `<packageRoot>/package.json` `bin[command]` (npm/bun package bin)
 *    3. `<packageRoot>/bin/<command>` (convention for standalone binaries)
 *    4. `<repoRoot>/node_modules/.bin/<command>` (workspace symlinks —
 *       what `bun run` implicitly prepends to PATH)
 *    5. fall through (return as-is; spawn will use process PATH)
 *
 *  Returning absolute paths means Electron / Finder-launched backends don't
 *  depend on the inherited PATH to find workspace binaries. */
function resolveCommand(command: string, packageRoot: string): string {
  if (isAbsolute(command)) return command;

  // (1.5) Path-form command (`./dist/cli.js`, `bin/foo`, etc.) — Node's spawn
  // would resolve these against `process.cwd`, but the manifest writes them
  // relative to the package, so anchor here too.
  if (command.includes("/") || command.includes("\\")) {
    return resolvePath(packageRoot, command);
  }

  // (2) package.json bin entry
  try {
    const pj = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
      name?: string;
      bin?: string | Record<string, string>;
    };
    if (typeof pj.bin === "string") {
      // npm shorthand: `bin: "./path"` means the binary name is the package's
      // own `name` and the entry is the bin value itself (NOT `main`).
      if (pj.name === command) return resolvePath(packageRoot, pj.bin);
    } else if (typeof pj.bin === "object" && pj.bin !== null) {
      const entry = pj.bin[command];
      if (entry) return resolvePath(packageRoot, entry);
    }
  } catch {
    // no package.json or unreadable — try the next strategy
  }

  // (3) <packageRoot>/bin/<command>
  const packageBin = join(packageRoot, "bin", command);
  if (existsSync(packageBin)) return packageBin;

  // (4) repo-root workspace bin
  try {
    const workspaceBin = join(resolveRepoRoot(packageRoot), "node_modules", ".bin", command);
    if (existsSync(workspaceBin)) return workspaceBin;
  } catch {
    // No discoverable repo root — skip this strategy.
  }

  // (5) Let spawn() resolve via PATH; if absent there too, the "error"
  //     event fires with ENOENT and our onError handler surfaces it.
  return command;
}

// ----------------------------------------------------------------------------
// orphan check
// ----------------------------------------------------------------------------

/** Unix-standard "kill -0" — does the PID correspond to *any* live process?
 *  Returns true if the process exists (even if owned by another user and
 *  unsignalable: EPERM). Returns false only on ESRCH (no such process).
 *
 *  Reporting EPERM as "alive" is the honest answer — the process really
 *  does exist. The caller's subsequent `killByPid` is a no-op on EPERM
 *  (silently swallowed), so reporting the other-user process as dead would
 *  be a lie with no behavioral benefit. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code !== "ESRCH";
  }
}

/** Best-effort SIGKILL by PID for orphaned processes we no longer have a
 *  ChildProcess ref to (e.g., after a backend restart). Silent on error. */
export function killByPid(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* already dead or not ours */
  }
}
