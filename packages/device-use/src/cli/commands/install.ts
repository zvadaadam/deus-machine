import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { CommandDefinition, CommandResult } from "../../engine/types.js";
import { findBridgePath, isBridgeAvailable } from "../../engine/simbridge.js";
import { listSimulators } from "../../engine/simctl.js";
import { getXcodePath, hasSimctl } from "../../engine/utils/platform.js";
import { BOLD, DIM, GREEN, RED, RESET, statusIcon } from "../output/style.js";
import { getSimBridgeOptions } from "../runtime.js";
import { getVersion } from "../version.js";

const schema = z.object({});
type Params = z.infer<typeof schema>;

const SKILL_DIRS = [".claude/skills", ".agents/skills"];
const SKILL_NAME = "device-use";

function ok(msg: string): string {
  return `  ${statusIcon("ok")} ${msg}`;
}
function fail(msg: string): string {
  return `  ${statusIcon("error")} ${msg}`;
}
function warn(msg: string): string {
  return `  ${statusIcon("warn")} ${msg}`;
}
function heading(msg: string): string {
  return `\n${DIM}→${RESET} ${BOLD}${msg}${RESET}`;
}

export const installCommand: CommandDefinition<Params> = {
  name: "install",
  description: "Verify setup and install the Claude skill",
  usage: "install",
  examples: ["install", "install --json"],
  schema,
  async handler(_params, ctx): Promise<CommandResult> {
    const lines: string[] = [];
    const json = ctx.flags.json;
    const log = (line: string) => {
      if (!json) lines.push(line);
    };
    const results: {
      prerequisites: Record<string, { status: string; detail: string }>;
      skills: Record<string, { installed: boolean; path: string }>;
      simulators: number;
    } = { prerequisites: {}, skills: {}, simulators: 0 };
    let hasErrors = false;

    log(`\n  ${BOLD}device-use${RESET} ${DIM}v${getVersion()}${RESET}`);

    log(heading("Checking prerequisites..."));

    if (process.platform === "darwin") {
      const version = getMacOSVersion();
      const detail = version ? `macOS ${version}` : "macOS";
      log(ok(detail));
      results.prerequisites["macOS"] = { status: "ok", detail };
    } else {
      hasErrors = true;
      log(fail(`macOS required (found: ${process.platform})`));
      results.prerequisites["macOS"] = { status: "error", detail: process.platform };
    }

    const xcodePath = await getXcodePath(ctx.executor);
    if (xcodePath) {
      log(ok(`Xcode CLI Tools (${xcodePath})`));
      results.prerequisites["Xcode"] = { status: "ok", detail: xcodePath };
    } else {
      hasErrors = true;
      log(fail("Xcode CLI Tools — run: xcode-select --install"));
      results.prerequisites["Xcode"] = { status: "error", detail: "Not found" };
    }

    const simctlOk = await hasSimctl(ctx.executor);
    if (simctlOk) {
      log(ok("simctl available"));
      results.prerequisites["simctl"] = { status: "ok", detail: "Available" };
    } else {
      hasErrors = true;
      log(fail("simctl not available"));
      results.prerequisites["simctl"] = { status: "error", detail: "Not found" };
    }

    log(heading("Checking simbridge binary..."));
    const bridgePath = findBridgePath();
    if (!existsSync(bridgePath)) {
      const nativeDir = findNativeDir();
      if (nativeDir && commandExists("swift")) {
        log(`  ${DIM}Building simbridge from source...${RESET}`);
        try {
          execFileSync("swift", ["build", "-c", "release"], {
            cwd: nativeDir,
            stdio: "pipe",
          });
          log(ok("simbridge built from source"));
        } catch {
          log(fail("simbridge build failed. Try: cd native && swift build -c release"));
        }
      } else {
        log(fail("simbridge binary missing and Swift toolchain not found"));
      }
    }

    const bridge = await isBridgeAvailable(getSimBridgeOptions(ctx.flags));
    if (bridge.available) {
      log(ok("simbridge binary"));
      results.prerequisites["simbridge"] = { status: "ok", detail: "Available" };
    } else {
      hasErrors = true;
      log(fail(`simbridge — ${bridge.reason}`));
      results.prerequisites["simbridge"] = {
        status: "error",
        detail: bridge.reason ?? "Not available",
      };
    }

    log(heading("Installing Claude skill..."));

    const skillSource = findSkillSource();
    if (skillSource) {
      for (const dir of SKILL_DIRS) {
        const destDir = join(process.cwd(), dir, SKILL_NAME);
        const destFile = join(destDir, "SKILL.md");
        try {
          mkdirSync(destDir, { recursive: true });
          cpSync(skillSource, destFile);
          log(ok(join(dir, SKILL_NAME, "SKILL.md")));
          results.skills[dir] = { installed: true, path: destFile };
        } catch (err) {
          hasErrors = true;
          log(fail(`${dir} — ${err instanceof Error ? err.message : String(err)}`));
          results.skills[dir] = { installed: false, path: destFile };
        }
      }
    } else {
      log(warn("SKILL.md not found in package. Skipping skill install."));
    }

    log(heading("Verifying setup..."));

    if (simctlOk) {
      try {
        const sims = await listSimulators(ctx.executor);
        results.simulators = sims.length;
        if (sims.length > 0) {
          log(ok(`${sims.length} simulator${sims.length > 1 ? "s" : ""} available`));
        } else {
          log(warn("No simulators found. Install a runtime in Xcode → Settings → Platforms."));
        }
      } catch {
        log(warn("Could not list simulators."));
      }
    }

    if (!json) {
      lines.push("");
      if (!hasErrors) {
        lines.push(`${GREEN}✓${RESET} ${BOLD}device-use is ready!${RESET}`);
        lines.push("");
        lines.push(`  ${DIM}Quick start:${RESET}`);
        lines.push(`    device-use list`);
        lines.push(`    device-use boot "iPhone 17 Pro"`);
        lines.push(`    device-use snapshot -i`);
        lines.push(`    device-use tap @e1`);
      } else {
        lines.push(`${RED}✗${RESET} ${BOLD}Some prerequisites are missing.${RESET}`);
        lines.push(`  Fix the issues above and run ${BOLD}device-use install${RESET} again.`);
      }
      lines.push("");
    }

    return {
      success: !hasErrors,
      data: json ? results : lines.join("\n"),
      message: hasErrors ? "Some prerequisites are missing" : "device-use is ready!",
    };
  },
};

function getMacOSVersion(): string | null {
  try {
    const plist = readFileSync("/System/Library/CoreServices/SystemVersion.plist", "utf-8");
    const match = plist.match(/<key>ProductVersion<\/key>\s*<string>([^<]+)<\/string>/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

function findSkillSource(): string | null {
  let dir: string;
  try {
    dir = dirname(fileURLToPath(import.meta.url));
  } catch {
    dir = process.cwd();
  }
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, "skills", SKILL_NAME, "SKILL.md");
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  return null;
}

function findNativeDir(): string | null {
  let dir: string;
  try {
    dir = dirname(fileURLToPath(import.meta.url));
  } catch {
    dir = process.cwd();
  }
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, "native");
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  return null;
}

function commandExists(cmd: string): boolean {
  try {
    execFileSync(cmd, ["--version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}
