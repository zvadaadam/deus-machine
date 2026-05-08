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

async function findCliTool(tool: string): Promise<CliToolStatus> {
  if (!CLI_TOOL_NAME_PATTERN.test(tool)) return { installed: false, path: null };

  const bundledPath = resolveBundledCliPath(tool);
  if (bundledPath) return { installed: true, path: bundledPath };

  try {
    const { stdout } = await execFileAsync("which", [tool], { env: getCliLookupEnv() });
    return { installed: true, path: stdout.trim() };
  } catch {
    return { installed: false, path: null };
  }
}

export async function checkCliTool(tool: string): Promise<CliToolStatus> {
  const initialResult = await findCliTool(tool);
  if (initialResult.installed || process.platform !== "darwin") return initialResult;

  await syncShellEnvironment();
  return findCliTool(tool);
}
