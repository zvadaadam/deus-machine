import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";

let xcodeDeveloperDir: string | null = null;
let expiresAt = 0;

/** Respect the chosen developer directory. When it points at the Command Line Tools,
 *  use an installed Xcode for simulator commands. */
export function simulatorEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (process.platform !== "darwin" || base.DEVELOPER_DIR) return { ...base };
  if (Date.now() >= expiresAt) {
    expiresAt = Date.now() + 60_000;
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
