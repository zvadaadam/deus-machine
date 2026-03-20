/**
 * CLI tool detection — check if CLI tools (git, gh, node, etc.) are installed.
 * Desktop-only: shells out to `which` on macOS/Linux.
 * Web mode: returns "not installed" defaults.
 */

import { capabilities } from "../capabilities";
import { invoke } from "../electron/invoke";

export interface CliCheckResult {
  installed: boolean;
  path: string | null;
  webMode?: boolean;
}

export interface GhAuthResult {
  authenticated: boolean;
  username?: string | null;
}

export async function checkCliTool(name: string): Promise<CliCheckResult> {
  if (!capabilities.ipcInvoke) return { installed: false, path: null, webMode: true };
  try {
    return (await invoke<CliCheckResult>("check_cli_tool", { name })) ?? { installed: false, path: null };
  } catch {
    return { installed: false, path: null };
  }
}

export async function checkGhAuth(): Promise<GhAuthResult> {
  if (!capabilities.ipcInvoke) return { authenticated: false, username: null };
  try {
    return (await invoke<GhAuthResult>("check_gh_auth")) ?? { authenticated: false, username: null };
  } catch {
    return { authenticated: false, username: null };
  }
}
