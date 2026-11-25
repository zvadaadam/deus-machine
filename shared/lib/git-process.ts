import { spawn } from "node:child_process";
import { createBackendChildEnv } from "./child-env";
import { processGroupsStopped, trackProcessGroup } from "./process-groups";

/** How long a stopped command gets to tidy up after itself before it is killed. */
const STOP_GRACE_MS = 2_000;
const STDERR_TAIL_BYTES = 1024 * 1024;

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
    let stderr: Buffer | undefined;
    let stderrEnd = 0;
    let stderrSize = 0;
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr ??= Buffer.allocUnsafe(STDERR_TAIL_BYTES);
      const bytes = Buffer.from(chunk).subarray(-STDERR_TAIL_BYTES);
      const first = bytes.copy(stderr, stderrEnd);
      bytes.copy(stderr, 0, first);
      stderrEnd = (stderrEnd + bytes.length) % STDERR_TAIL_BYTES;
      stderrSize = Math.min(stderrSize + bytes.length, STDERR_TAIL_BYTES);
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
    let timedOut = false;
    let kill: NodeJS.Timeout | undefined;
    let settled = false;
    const stop = setTimeout(() => {
      timedOut = true;
      stopGroup();
    }, timeoutMs);

    function stopGroup() {
      if (settled || kill) return;
      clearTimeout(stop);
      if (signalGroup("SIGTERM")) kill = setTimeout(forceStop, STOP_GRACE_MS);
      else forceStop();
    }

    function forceStop() {
      signalGroup("SIGKILL");
      // A helper in another group can hold the pipes after git and its group have exited.
      child.stdout.destroy();
      child.stderr.destroy();
      settle();
    }
    signal?.addEventListener("abort", stopGroup, { once: true });

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
      stopGroup();
    });

    function settle(error?: unknown, code: number | null = null) {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", stopGroup);
      clearTimeout(stop);
      clearTimeout(kill);
      untrack();
      const stdout = Buffer.concat(chunks).toString("utf8");
      const exitCode = timedOut || outputError ? null : code;
      if (signal?.aborted) reject(signal.reason);
      else if (error === undefined && exitCode === 0) resolve(stdout);
      else {
        const tail =
          stderr &&
          Buffer.concat([stderr.subarray(stderrEnd, stderrSize), stderr.subarray(0, stderrEnd)]);
        let start = 0;
        // The oldest retained byte can be in the middle of a UTF-8 character.
        while (tail && (tail[start] & 0xc0) === 0x80) start++;
        reject(
          new GitError(args, {
            code: exitCode,
            stdout,
            stderr: tail?.toString("utf8", start).trim(),
            timedOut,
            cause: outputError ?? error,
          })
        );
      }
    }
    child.once("error", (error) => settle(error));
    child.once("close", (code) => {
      // Git may have exited before a group member with its own stdio.
      if (!kill || !signalGroup(0)) settle(undefined, code);
    });
  });
}
