import { spawn, type SpawnOptions } from "node:child_process";
import { ScreenStudioError } from "../errors.js";

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  /** Raw stdout, for binary output such as decoded frames. */
  stdoutBuffer: Buffer;
  stderr: string;
}

export interface RunOptions {
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  signal?: AbortSignal;
}

/**
 * Run a command to completion without blocking the event loop. Never throws for
 * a non-zero exit (callers decide); throws `tool_missing` when the binary is absent.
 */
export function run(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const spawnOptions: SpawnOptions = {
      stdio: ["ignore", "pipe", "pipe"],
      env: options.env ?? process.env,
      cwd: options.cwd,
    };
    const child = spawn(command, args, spawnOptions);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, options.timeoutMs ?? 30_000);
    const onAbort = () => child.kill("SIGKILL");
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (settled) return;
      settled = true;
      reject(
        err.code === "ENOENT"
          ? new ScreenStudioError("tool_missing", `${command} is not installed or not on PATH`, {
              hint: installHint(command),
            })
          : err
      );
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (settled) return;
      settled = true;
      resolve({
        code,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stdoutBuffer: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

/** Run and return stdout, throwing with the stderr tail on failure. */
export async function runOk(
  command: string,
  args: string[],
  options: RunOptions = {}
): Promise<string> {
  const result = await run(command, args, options);
  if (result.code !== 0) {
    throw new Error(
      `${command} ${args.slice(0, 3).join(" ")} failed (${result.signal ?? `exit ${result.code}`}): ${tail(result.stderr)}`
    );
  }
  return result.stdout;
}

export function tail(text: string, length = 600): string {
  const trimmed = text.trim();
  return trimmed.length > length ? `…${trimmed.slice(-length)}` : trimmed;
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The command line of a live process, or null (gone, or no `ps` here). */
export async function commandLine(pid: number): Promise<string | null> {
  if (process.platform === "win32") return null;
  const result = await run("ps", ["-o", "command=", "-p", String(pid)], { timeoutMs: 5_000 }).catch(
    () => null
  );
  return result?.code === 0 ? result.stdout.trim() : null;
}

/** True while any process in the group led by `pgid` is alive. */
export function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Stop a detached worker's whole process group (it and the capture helpers
 * it spawned): SIGINT so helpers like simctl finalize, then SIGKILL.
 */
export async function stopGroup(pgid: number, graceMs = 10_000): Promise<void> {
  try {
    process.kill(-pgid, "SIGINT");
  } catch {
    return;
  }
  const deadline = Date.now() + graceMs;
  while (groupAlive(pgid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  try {
    process.kill(-pgid, "SIGKILL");
  } catch {
    // already gone
  }
}

export function installHint(command: string): string | undefined {
  if (command.startsWith("ff")) {
    return process.platform === "darwin"
      ? "Install FFmpeg: brew install ffmpeg"
      : "Install FFmpeg with your package manager, e.g. apt-get install ffmpeg";
  }
  if (command === "xcrun") return "Install Xcode, or set DEVELOPER_DIR to its Contents/Developer";
  if (command === "agent-browser") return "Install agent-browser: npm i -g agent-browser";
  return undefined;
}
