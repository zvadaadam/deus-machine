import { execFile } from "child_process";
import { promisify } from "util";
import {
  extendCliPath,
  getBundledCliDirectory,
  resolveBundledCliPath,
} from "../../../shared/lib/cli-path";
import { syncShellEnvironment } from "./shell-env";

const execFileAsync = promisify(execFile);

const CLI_TOOL_NAME_PATTERN = /^[a-zA-Z0-9._+-]+$/;
const PACKAGED_BUNDLED_TOOLS = new Set(["codex", "claude", "gh", "rg"]);
const PACKAGED_SYSTEM_PATHS = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];

export interface CliToolStatus {
  installed: boolean;
  path: string | null;
}

function isPackagedRuntime(): boolean {
  return process.env.DEUS_PACKAGED === "1" || process.env.DEUS_RUNTIME === "1";
}

export function getCliLookupEnv(): NodeJS.ProcessEnv {
  if (isPackagedRuntime()) {
    const bundledDir = getBundledCliDirectory();
    return {
      ...process.env,
      PATH: [bundledDir, ...PACKAGED_SYSTEM_PATHS].filter(Boolean).join(":"),
    };
  }
  return { ...process.env, PATH: extendCliPath(process.env.PATH) };
}

function getCliLookupCommand(tool: string): { command: string; args: string[] } {
  if (process.platform === "win32") {
    return { command: "where.exe", args: [tool] };
  }

  return { command: "which", args: [tool] };
}

function parseLookupPath(stdout: string): string | null {
  return (
    stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? null
  );
}

async function findCliTool(tool: string): Promise<CliToolStatus> {
  if (!CLI_TOOL_NAME_PATTERN.test(tool)) return { installed: false, path: null };

  const bundledPath = resolveBundledCliPath(tool);
  if (bundledPath) return { installed: true, path: bundledPath };
  if (isPackagedRuntime() && PACKAGED_BUNDLED_TOOLS.has(tool)) {
    return { installed: false, path: null };
  }

  try {
    const lookup = getCliLookupCommand(tool);
    const { stdout } = await execFileAsync(lookup.command, lookup.args, {
      env: getCliLookupEnv(),
      windowsHide: true,
    });
    const path = parseLookupPath(stdout);
    return path ? { installed: true, path } : { installed: false, path: null };
  } catch {
    return { installed: false, path: null };
  }
}

export async function checkCliTool(tool: string): Promise<CliToolStatus> {
  const initialResult = await findCliTool(tool);
  if (
    initialResult.installed ||
    process.platform !== "darwin" ||
    (isPackagedRuntime() && PACKAGED_BUNDLED_TOOLS.has(tool))
  ) {
    return initialResult;
  }

  try {
    await syncShellEnvironment();
  } catch (error) {
    console.warn("[cli-tools] Failed to sync shell environment before CLI lookup:", error);
    return initialResult;
  }

  return findCliTool(tool);
}
