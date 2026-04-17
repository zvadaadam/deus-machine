// Live log streaming from a booted simulator's system log.
// Wraps `xcrun simctl spawn <udid> log stream ...`. Streams newline-delimited
// log entries to a callback. Caller gets a handle with `stop()`.

import { spawn, type ChildProcess } from "node:child_process";

export interface StreamLogsOptions {
  udid: string;
  /** Filter to a specific process/app by bundle identifier. */
  bundleId?: string;
  /** Filter to a specific process ID. */
  pid?: number;
  /** Predicate string in log(1) format. Overrides bundleId/pid if set. */
  predicate?: string;
  /** Log level — "default" | "info" | "debug". Default: "default". */
  level?: "default" | "info" | "debug";
  /** Output format — "default" | "compact" | "json" | "ndjson". Default: "compact". */
  style?: "default" | "compact" | "json" | "ndjson";
  /** Emitted once per log line (newline trimmed). */
  onLine: (line: string) => void;
  /** Emitted if the spawn process fails before exit. */
  onError?: (err: Error) => void;
  /** Emitted when the stream ends (expected after `stop()` or unexpected exit). */
  onExit?: (exitCode: number | null) => void;
}

export interface LogStreamHandle {
  /** Sends SIGTERM to the log-stream process. Idempotent. */
  stop: () => void;
  /** True once the underlying child process has exited. */
  readonly stopped: boolean;
}

export type Spawner = typeof spawn;

function buildPredicate(opts: StreamLogsOptions): string | undefined {
  if (opts.predicate) return opts.predicate;
  const parts: string[] = [];
  if (opts.bundleId) parts.push(`subsystem == "${opts.bundleId}"`);
  if (opts.pid !== undefined) parts.push(`processID == ${opts.pid}`);
  return parts.length ? parts.join(" AND ") : undefined;
}

/**
 * Starts a live log stream from the given simulator. Non-blocking — returns
 * a handle that exposes `stop()`.
 */
export function streamLogs(options: StreamLogsOptions, spawner: Spawner = spawn): LogStreamHandle {
  const args = ["simctl", "spawn", options.udid, "log", "stream"];
  args.push("--level", options.level ?? "default");
  args.push("--style", options.style ?? "compact");
  const predicate = buildPredicate(options);
  if (predicate) args.push("--predicate", predicate);

  let stopped = false;
  let child: ChildProcess;
  try {
    child = spawner("xcrun", args);
  } catch (err) {
    if (options.onError) options.onError(err as Error);
    return {
      stop: () => {},
      get stopped() {
        return true;
      },
    };
  }

  let partial = "";
  child.stdout?.on("data", (data: Buffer) => {
    const text = partial + data.toString();
    const lines = text.split("\n");
    partial = lines.pop() ?? "";
    for (const line of lines) options.onLine(line);
  });

  child.once("error", (err) => {
    stopped = true;
    if (options.onError) options.onError(err);
  });

  child.once("close", (exitCode) => {
    if (partial) options.onLine(partial);
    stopped = true;
    if (options.onExit) options.onExit(exitCode);
  });

  return {
    stop: () => {
      if (stopped) return;
      if (!child.killed) child.kill("SIGTERM");
    },
    get stopped() {
      return stopped;
    },
  };
}
