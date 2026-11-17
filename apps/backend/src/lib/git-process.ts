import { spawn } from "node:child_process";
import { createBackendChildEnv } from "../runtime/child-env";
import { processGroupsStopped, trackProcessGroup } from "./process-groups";

/** How long a stopped command gets to tidy up after itself before it is killed. */
const STOP_GRACE_MS = 2_000;

export class GitError extends Error {
  constructor(
    readonly args: readonly string[],
    /** What git printed on stderr, trimmed. Empty when it never started. */
    readonly stderr: string,
    readonly timedOut: boolean,
    cause?: unknown
  ) {
    super(
      [`git ${args.join(" ")}`, stderr || (cause instanceof Error ? cause.message : "")]
        .filter(Boolean)
        .join("\n"),
      { cause }
    );
    this.name = "GitError";
  }
}

/**
 * Run git in the background and resolve with its stdout.
 *
 * Two things a plain `execFile` gets wrong for commands that can run long:
 *
 * - It can ask. With a terminal attached (`bun run dev`), a remote that wants
 *   a password stops and waits for one nobody will type. Prompts are off, so
 *   that is an error at once.
 * - Its timeout stops only git itself. `git worktree add` checks files out
 *   in a child process, which keeps writing after its parent is gone, into a
 *   folder the caller is already deleting. The command runs in its own
 *   process group and the whole group is stopped: first asked (git then
 *   removes what it had half made), then killed.
 */
export function runGit(
  args: readonly string[],
  options: {
    cwd: string;
    timeoutMs?: number;
    /** Each piece of stderr as it arrives (a clone's progress). */
    onStderr?: (chunk: string) => void;
  }
): Promise<string> {
  const { cwd, timeoutMs = 10_000, onStderr } = options;
  return new Promise((resolve, reject) => {
    if (processGroupsStopped()) {
      reject(new GitError(args, "", false, new Error("Deus is closing.")));
      return;
    }
    const child = spawn("git", args, {
      cwd,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: createBackendChildEnv({ GIT_TERMINAL_PROMPT: "0" }),
    });
    const untrack = trackProcessGroup(child.pid);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
      onStderr?.(chunk);
    });

    const signalGroup = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        // The group is gone, or this platform has none: stop the one process.
        child.kill(signal);
      }
    };
    let timedOut = false;
    let kill: NodeJS.Timeout | undefined;
    const stop = setTimeout(() => {
      timedOut = true;
      signalGroup("SIGTERM");
      kill = setTimeout(() => signalGroup("SIGKILL"), STOP_GRACE_MS);
    }, timeoutMs);

    let settled = false;
    const settle = (error?: unknown, code?: number | null) => {
      if (settled) return;
      settled = true;
      untrack();
      clearTimeout(stop);
      clearTimeout(kill);
      if (error === undefined && code === 0 && !timedOut) resolve(stdout);
      else reject(new GitError(args, stderr.trim(), timedOut, error));
    };
    // "error" without "close": git is not installed, or the folder is gone.
    child.once("error", (error) => settle(error));
    child.once("close", (code) => settle(undefined, code));
  });
}
