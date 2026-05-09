import { execFile } from "child_process";
import { promisify } from "util";
import { extendCliPath, resolveBundledCliPath } from "../../../shared/lib/cli-path";
import { syncShellEnvironment } from "./shell-env";

const execFileAsync = promisify(execFile);

const CLI_TOOL_NAME_PATTERN = /^[a-zA-Z0-9._+-]+$/;

export interface CliToolStatus {
  installed: boolean;
  path: string | null;
}

export function getCliLookupEnv(): NodeJS.ProcessEnv {
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
  if (initialResult.installed || process.platform !== "darwin") return initialResult;

  try {
    await syncShellEnvironment();
  } catch (error) {
    console.warn("[cli-tools] Failed to sync shell environment before CLI lookup:", error);
    return initialResult;
  }

  return findCliTool(tool);
}
