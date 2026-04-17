import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

declare const __VERSION__: string;

let cached: string | undefined;

/** Resolve package version — works in dev, bundled, and compiled contexts. */
export function getVersion(): string {
  if (cached) return cached;
  try {
    cached = __VERSION__;
    if (cached) return cached;
  } catch {
    // __VERSION__ not defined — fall through to package.json lookup
  }
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const rel of ["../package.json", "../../package.json", "../../../package.json"]) {
      try {
        const pkg = JSON.parse(readFileSync(join(here, rel), "utf-8"));
        if (pkg.version) {
          cached = pkg.version;
          return cached!;
        }
      } catch {
        // try next candidate
      }
    }
  } catch {
    // ignore
  }
  cached = "0.0.0";
  return cached;
}

/** True if `latest` is a newer semver than `current`. */
export function isNewer(latest: string, current: string): boolean {
  const [a1 = 0, a2 = 0, a3 = 0] = latest.split(".").map(Number);
  const [b1 = 0, b2 = 0, b3 = 0] = current.split(".").map(Number);
  if (a1 !== b1) return a1 > b1;
  if (a2 !== b2) return a2 > b2;
  return a3 > b3;
}
