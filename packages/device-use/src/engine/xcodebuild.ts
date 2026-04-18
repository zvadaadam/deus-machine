// xcodebuild wrapper — builds an iOS app for a given scheme + destination.
// Uses Node's `spawn` for streaming stdout/stderr to a callback so the
// viewer's log drawer and the agent's tool-log events can tail the build live.

import { spawn, type ChildProcess } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { DeviceUseError } from "./errors.js";

export interface BuildOptions {
  /** Absolute path to `.xcodeproj` or `.xcworkspace` */
  project: string;
  /** Scheme name (required — no auto-pick in the engine) */
  scheme: string;
  /** Simulator destination, e.g. `platform=iOS Simulator,id=<UDID>` or `platform=iOS Simulator,name=iPhone 16 Pro` */
  destination: string;
  /** Build configuration — defaults to "Debug" */
  configuration?: string;
  /** Override DerivedData location. Defaults to xcodebuild's default. */
  derivedDataPath?: string;
  /** Streams every line of stdout/stderr while the build runs. */
  onLog?: (line: string, stream: "stdout" | "stderr") => void;
  /** Abort signal — when aborted, SIGTERM is sent to xcodebuild. */
  signal?: AbortSignal;
}

export interface BuildResult {
  /** True if xcodebuild exited 0. */
  success: boolean;
  exitCode: number | null;
  /** Last N lines of stdout. */
  stdoutTail: string;
  /** Last N lines of stderr. */
  stderrTail: string;
}

/**
 * Injectable spawner — lets tests substitute a fake. Real code uses Node's `spawn`.
 */
export type Spawner = typeof spawn;

export class BuildError extends DeviceUseError {
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly stderrTail: string
  ) {
    super(message);
  }
}

const TAIL_LINES = 200;

function keepTail(buffer: string, chunk: string): string {
  const combined = buffer + chunk;
  const lines = combined.split("\n");
  if (lines.length <= TAIL_LINES) return combined;
  return lines.slice(-TAIL_LINES).join("\n");
}

function streamLines(data: Buffer, partial: { value: string }, emit: (line: string) => void): void {
  const text = partial.value + data.toString();
  const lines = text.split("\n");
  partial.value = lines.pop() ?? "";
  for (const line of lines) emit(line);
}

/**
 * Kicks off an xcodebuild build. Returns a promise that resolves when the
 * process exits (whether success or failure).
 */
export async function build(options: BuildOptions, spawner: Spawner = spawn): Promise<BuildResult> {
  const kind = options.project.endsWith(".xcworkspace") ? "-workspace" : "-project";
  const args: string[] = [
    kind,
    options.project,
    "-scheme",
    options.scheme,
    "-destination",
    options.destination,
    "-configuration",
    options.configuration ?? "Debug",
    "build",
  ];
  if (options.derivedDataPath) {
    args.push("-derivedDataPath", options.derivedDataPath);
  }

  return new Promise<BuildResult>((resolve, reject) => {
    let stdoutTail = "";
    let stderrTail = "";
    const stdoutPartial = { value: "" };
    const stderrPartial = { value: "" };

    let child: ChildProcess;
    try {
      child = spawner("xcodebuild", args);
    } catch (err) {
      reject(new BuildError((err as Error).message, null, ""));
      return;
    }

    const onAbort = () => {
      if (!child.killed) child.kill("SIGTERM");
    };
    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout?.on("data", (data: Buffer) => {
      stdoutTail = keepTail(stdoutTail, data.toString());
      if (options.onLog) {
        streamLines(data, stdoutPartial, (line) => options.onLog!(line, "stdout"));
      }
    });

    child.stderr?.on("data", (data: Buffer) => {
      stderrTail = keepTail(stderrTail, data.toString());
      if (options.onLog) {
        streamLines(data, stderrPartial, (line) => options.onLog!(line, "stderr"));
      }
    });

    child.once("error", (err) => {
      reject(new BuildError(err.message, null, stderrTail));
    });

    child.once("close", (exitCode) => {
      if (options.signal) options.signal.removeEventListener("abort", onAbort);

      // Flush any remaining partial lines
      if (options.onLog) {
        if (stdoutPartial.value) options.onLog(stdoutPartial.value, "stdout");
        if (stderrPartial.value) options.onLog(stderrPartial.value, "stderr");
      }

      // Don't synthesize an `appPath` from `scheme` — it's wrong whenever
      // a target's product name differs from the scheme name, and a wrong
      // appPath is worse than none (callers will fail later during install).
      // Use `resolveAppPath()` after a successful build to get the real path
      // from xcodebuild's own settings.
      resolve({
        success: exitCode === 0,
        exitCode,
        stdoutTail,
        stderrTail,
      });
    });
  });
}

/**
 * Resolves the built `.app` path by querying xcodebuild's build settings.
 * Call this after a successful build when you didn't pass a `derivedDataPath`.
 */
export async function resolveAppPath(
  options: Pick<BuildOptions, "project" | "scheme" | "destination" | "configuration">,
  executor: (command: string[]) => Promise<{ success: boolean; output: string; error?: string }>
): Promise<string | undefined> {
  const kind = options.project.endsWith(".xcworkspace") ? "-workspace" : "-project";
  const result = await executor([
    "xcodebuild",
    kind,
    options.project,
    "-scheme",
    options.scheme,
    "-destination",
    options.destination,
    "-configuration",
    options.configuration ?? "Debug",
    "-showBuildSettings",
    "-json",
  ]);
  if (!result.success) return undefined;
  try {
    const parsed = JSON.parse(result.output) as Array<{ buildSettings: Record<string, string> }>;
    const settings = parsed[0]?.buildSettings;
    if (!settings) return undefined;
    const productDir = settings.BUILT_PRODUCTS_DIR;
    const productName = settings.FULL_PRODUCT_NAME;
    if (!productDir || !productName) return undefined;
    const candidate = path.join(productDir, productName);
    try {
      await access(candidate);
      return candidate;
    } catch {
      return undefined;
    }
  } catch {
    return undefined;
  }
}
