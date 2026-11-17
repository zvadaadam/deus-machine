import { execFile, execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SimBridgeRequest, SimBridgeResponse } from "./types.js";
import { DependencyError, SimBridgeError } from "./errors.js";
import { DEFAULT_MAX_BUFFER } from "./utils/exec.js";

const BRIDGE_TIMEOUT_MS = 30_000;

let xcodeDeveloperDir: string | null | undefined;

/**
 * The environment for Xcode's tools and the helpers: `base` with a developer
 * directory that has the simulator. `DEVELOPER_DIR` when `base` sets it;
 * otherwise `xcode-select`'s choice, unless that is the Command Line Tools,
 * which have no simulator: then the first Xcode in /Applications.
 */
export function simulatorEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (base["DEVELOPER_DIR"]) return { ...base };
  if (xcodeDeveloperDir === undefined) {
    let selected = "";
    let apps: string[] = [];
    try {
      selected = execFileSync("xcode-select", ["-p"], { encoding: "utf8", stdio: "pipe" });
      apps = readdirSync("/Applications").filter((name) => /^Xcode.*\.app$/.test(name));
    } catch {
      // No developer tools, or no /Applications: nothing to choose.
    }
    const xcode = ["Xcode.app", ...apps]
      .map((app) => `/Applications/${app}/Contents/Developer`)
      .find((dir) => existsSync(dir));
    xcodeDeveloperDir = selected.includes("CommandLineTools") ? (xcode ?? null) : null;
  }
  return xcodeDeveloperDir ? { ...base, DEVELOPER_DIR: xcodeDeveloperDir } : { ...base };
}

export interface SimBridgeCallOptions {
  timeout?: number;
  /** When false (default), drop framework-load diagnostics from stderr. */
  verbose?: boolean;
  /** The environment to start from (see `simulatorEnv`); this process's by default. */
  env?: NodeJS.ProcessEnv;
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
 * Where a helper is, or null: the override when it exists, then Deus's
 * packaged `Resources/simulator`, then this package's `bin/` (from
 * `src/engine/` or a bundle in `dist/`), next to a compiled CLI, then a
 * local `native/.build/release/`.
 */
function findHelper(name: string, override: string | undefined): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const resources = process.env["DEUS_RESOURCES_PATH"];
  const candidates = [
    override,
    resources && join(resources, "simulator", name),
    join(here, "../../bin", name),
    join(here, "../bin", name),
    join(dirname(process.execPath), name),
    // Where `swift build -c release` (and the CLI's install) puts it.
    ...["../../native", "../native"].map((dir) => join(here, dir, ".build/release", name)),
  ];
  return candidates.find((path): path is string => !!path && existsSync(path)) ?? null;
}

export const findBridgePath = (): string | null =>
  findHelper("simbridge", process.env["DEVICE_USE_SIMBRIDGE"]);

export const findInspectorPath = (): string | null =>
  findHelper("siminspector.dylib", process.env["DEVICE_USE_SIMINSPECTOR"]);

export async function callSimBridge(
  request: SimBridgeRequest,
  options?: SimBridgeCallOptions
): Promise<SimBridgeResponse> {
  const bridgePath = findBridgePath();
  if (!bridgePath) {
    throw new DependencyError(
      "simbridge binary not found. Run: cd native && swift build -c release"
    );
  }

  const input = JSON.stringify(request);

  return new Promise<SimBridgeResponse>((resolve, reject) => {
    execFile(
      bridgePath,
      [input],
      {
        timeout: options?.timeout ?? BRIDGE_TIMEOUT_MS,
        maxBuffer: DEFAULT_MAX_BUFFER,
        env: simulatorEnv(options?.env),
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
