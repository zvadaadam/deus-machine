import { spawn } from "node:child_process";
import { createBackendChildEnv } from "./child-env";
import { processGroupsStopped, trackProcessGroup } from "./process-groups";

/** How long a stopped command gets to tidy up after itself before it is killed. */
const STOP_GRACE_MS = 2_000;

export class GitError extends Error {
  /** The exit status, or null when git never started or was stopped. */
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;

  constructor(
    readonly args: readonly string[],
    fields: {
      stderr?: string;
      stdout?: string;
      code?: number | null;
      timedOut?: boolean;
      cause?: unknown;
    }
  ) {
    const { stderr = "", cause } = fields;
    super(
      [`git ${args.join(" ")}`, stderr || (cause instanceof Error ? cause.message : "")]
        .filter(Boolean)
        .join("\n"),
      { cause }
    );
    this.name = "GitError";
    this.code = fields.code ?? null;
    this.stdout = fields.stdout ?? "";
    this.stderr = stderr;
    this.timedOut = fields.timedOut ?? false;
  }
}

/**
 * Git runs without prompts. A timeout or excess stdout stops its whole process
 * group so a checkout cannot keep writing into a folder the caller is removing.
 */
export function runGit(
  args: readonly string[],
  options: {
    cwd: string;
    timeoutMs?: number;
    maxOutputBytes?: number;
    signal?: AbortSignal;
    /** Each piece of stderr as it arrives (a clone's progress). */
    onStderr?: (chunk: string) => void;
  }
): Promise<string> {
  const { cwd, timeoutMs = 10_000, maxOutputBytes = 10 * 1024 * 1024, onStderr, signal } = options;
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    if (processGroupsStopped()) {
      reject(new GitError(args, { cause: new Error("Deus is closing.") }));
      return;
    }
    const child = spawn("git", args, {
      cwd,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: createBackendChildEnv({ GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" }),
    });
    const untrack = trackProcessGroup(child.pid);
    const chunks: Buffer[] = [];
    let stdoutBytes = 0;
    let outputError: Error | undefined;
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
      onStderr?.(chunk);
    });

    const signalGroup = (killSignal: NodeJS.Signals | 0) => {
      if (!child.pid) return false;
      try {
        return process.kill(-child.pid, killSignal);
      } catch {
        // The group is gone, or this platform has none: stop the one process.
        return child.kill(killSignal);
      }
    };
    const abort = () => signalGroup("SIGKILL");
    signal?.addEventListener("abort", abort, { once: true });
    let timedOut = false;
    let kill: NodeJS.Timeout | undefined;
    let killed: Promise<void> | undefined;
    const stopGroup = () => {
      signalGroup("SIGTERM");
      killed = new Promise<void>((done) => {
        kill = setTimeout(() => {
          signalGroup("SIGKILL");
          done();
        }, STOP_GRACE_MS);
      });
    };
    const stop = setTimeout(() => {
      timedOut = true;
      stopGroup();
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      if (outputError) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes <= maxOutputBytes) {
        chunks.push(chunk);
        return;
      }
      outputError = new Error(
        `Git output exceeded its byte limit by ${stdoutBytes - maxOutputBytes} (limit ${maxOutputBytes}, received ${stdoutBytes}).`
      );
      chunks.length = 0;
      clearTimeout(stop);
      if (!timedOut) stopGroup();
    });

    let settled = false;
    const settle = async (error?: unknown, code: number | null = null) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      clearTimeout(stop);
      // Git can exit while a helper with its own stdio is still running.
      if (kill && signalGroup(0)) await killed;
      clearTimeout(kill);
      untrack();
      const stdout = Buffer.concat(chunks).toString("utf8");
      const exitCode = timedOut || outputError ? null : code;
      if (signal?.aborted) reject(signal.reason);
      else if (error === undefined && exitCode === 0) resolve(stdout);
      else {
        reject(
          new GitError(args, {
            code: exitCode,
            stdout,
            stderr: stderr.trim(),
            timedOut,
            cause: outputError ?? error,
          })
        );
      }
    };
    // "error" without "close": git is not installed, or the folder is gone.
    child.once("error", (error) => settle(error));
    child.once("close", (code) => settle(undefined, code));
  });
}
