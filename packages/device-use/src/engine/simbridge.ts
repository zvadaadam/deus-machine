import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SimBridgeRequest, SimBridgeResponse } from "./types.js";
import { DependencyError, SimBridgeError } from "./errors.js";
import { DEFAULT_MAX_BUFFER } from "./utils/exec.js";

const BRIDGE_TIMEOUT_MS = 30_000;

/** Env passed to simbridge child processes — keeps Xcode tools discoverable. */
export const SIMBRIDGE_ENV = {
  ...process.env,
  DEVELOPER_DIR: process.env["DEVELOPER_DIR"] ?? "/Applications/Xcode.app/Contents/Developer",
} as const;

export interface SimBridgeCallOptions {
  timeout?: number;
  /** When false (default), drop framework-load diagnostics from stderr. */
  verbose?: boolean;
}

// Patterns for harmless framework-load noise emitted every time simbridge starts.
// Matched against the full stderr dump so either raw or already-prefixed lines are caught.
const NOISE_PATTERNS = [
  /CoreSimulator loaded/,
  /SimulatorKit loaded/,
  /AccessibilityPlatformTranslation loaded/,
  /AXPTranslator configured/,
];

function filterSimBridgeStderr(raw: string, verbose: boolean): string {
  if (verbose) return raw;
  const out: string[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    if (NOISE_PATTERNS.some((p) => p.test(line))) continue;
    out.push(line);
  }
  return out.join("\n");
}

/**
 * Locate the simbridge binary. Search order:
 *   1. `$DEVICE_USE_SIMBRIDGE` env override
 *   2. Sibling of the current executable (compiled / brew install case)
 *   3. Relative to source/bundle location (dev + npm install case)
 */
export function findBridgePath(): string {
  const override = process.env["DEVICE_USE_SIMBRIDGE"];
  if (override && existsSync(override)) return override;

  // When running as a compiled Bun binary, process.execPath is the device-use binary itself.
  // Ship simbridge as a sibling.
  try {
    const execDir = dirname(process.execPath);
    const sibling = join(execDir, "simbridge");
    if (existsSync(sibling)) return sibling;
  } catch {
    // ignore
  }

  // Relative to this module's file location (dev or bundled dist/)
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      join(here, "../../native/.build/release/simbridge"), // from dist/
      join(here, "../native/.build/release/simbridge"), // from src/engine/
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
    }
    return candidates[0]!;
  } catch {
    // import.meta.url may be unreachable in compiled builds — fall back
    return "simbridge";
  }
}

/** Locate the siminspector dylib shipped next to simbridge. */
export function findInspectorPath(): string {
  const override = process.env["DEVICE_USE_SIMINSPECTOR"];
  if (override && existsSync(override)) return override;

  try {
    const execDir = dirname(process.execPath);
    const sibling = join(execDir, "siminspector.dylib");
    if (existsSync(sibling)) return sibling;
  } catch {
    // ignore
  }

  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      join(here, "../../native/.build/release/siminspector.dylib"),
      join(here, "../native/.build/release/siminspector.dylib"),
      join(here, "../../bin/siminspector.dylib"),
      join(here, "../bin/siminspector.dylib"),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
    }
    return candidates[0]!;
  } catch {
    return "siminspector.dylib";
  }
}

const BRIDGE_PATH = findBridgePath();

export async function callSimBridge(
  request: SimBridgeRequest,
  options?: SimBridgeCallOptions
): Promise<SimBridgeResponse> {
  if (!existsSync(BRIDGE_PATH)) {
    throw new DependencyError(
      `simbridge binary not found at ${BRIDGE_PATH}. Run: cd native && swift build -c release`
    );
  }

  const input = JSON.stringify(request);

  return new Promise<SimBridgeResponse>((resolve, reject) => {
    execFile(
      BRIDGE_PATH,
      [input],
      {
        timeout: options?.timeout ?? BRIDGE_TIMEOUT_MS,
        maxBuffer: DEFAULT_MAX_BUFFER,
        env: SIMBRIDGE_ENV,
      },
      (error, stdout, stderr) => {
        const filtered = stderr ? filterSimBridgeStderr(stderr, options?.verbose ?? false) : "";
        if (filtered) {
          process.stderr.write(filtered.endsWith("\n") ? filtered : `${filtered}\n`);
        }

        if (error && !stdout) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            reject(new DependencyError("simbridge binary not found"));
            return;
          }
          if (error.killed) {
            reject(new SimBridgeError("simbridge timed out", "TIMEOUT"));
            return;
          }
          reject(new SimBridgeError(`simbridge crashed: ${error.message}`, "CRASH"));
          return;
        }

        try {
          const response = JSON.parse(stdout) as SimBridgeResponse;
          if (!response.success && response.error) {
            reject(
              new SimBridgeError(
                response.error.message,
                response.error.code,
                response.error.details
              )
            );
            return;
          }
          resolve(response);
        } catch {
          reject(
            new SimBridgeError(`Invalid simbridge output: ${stdout.slice(0, 200)}`, "PARSE_ERROR")
          );
        }
      }
    );
  });
}

export async function isBridgeAvailable(
  options?: SimBridgeCallOptions
): Promise<{ available: boolean; reason?: string }> {
  if (!existsSync(BRIDGE_PATH)) {
    return {
      available: false,
      reason: "Binary not built. Run: cd native && swift build -c release",
    };
  }

  try {
    const response = await callSimBridge({ command: "doctor" }, options);
    if (response.success) return { available: true };
    return { available: false, reason: response.error?.message ?? "Unknown issue" };
  } catch (err) {
    return { available: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
