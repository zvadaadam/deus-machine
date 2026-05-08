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

export interface GhAuthLoginResult {
  success: boolean;
  path: string | null;
  error?: string;
}

export interface GhAuthLogoutResult {
  success: boolean;
  path: string | null;
  error?: string;
}

export async function checkCliTool(name: string): Promise<CliCheckResult> {
  if (!capabilities.ipcInvoke) return { installed: false, path: null, webMode: true };
  try {
    return (
      (await invoke<CliCheckResult>("check_cli_tool", { name })) ?? { installed: false, path: null }
    );
  } catch {
    return { installed: false, path: null };
  }
}

export async function startGhAuthLogin(): Promise<GhAuthLoginResult> {
  if (!capabilities.ipcInvoke) {
    return {
      success: false,
      path: null,
      error: "GitHub CLI sign-in requires the desktop app",
    };
  }

  try {
    return (
      (await invoke<GhAuthLoginResult>("start_gh_auth_login")) ?? {
        success: false,
        path: null,
        error: "Could not start GitHub sign-in",
      }
    );
  } catch (error) {
    return {
      success: false,
      path: null,
      error: error instanceof Error ? error.message : "Could not start GitHub sign-in",
    };
  }
}

export async function logoutGhAuth(): Promise<GhAuthLogoutResult> {
  if (!capabilities.ipcInvoke) {
    return {
      success: false,
      path: null,
      error: "GitHub CLI sign-out requires the desktop app",
    };
  }

  try {
    return (
      (await invoke<GhAuthLogoutResult>("logout_gh_auth")) ?? {
        success: false,
        path: null,
        error: "Could not sign out of GitHub",
      }
    );
  } catch (error) {
    return {
      success: false,
      path: null,
      error: error instanceof Error ? error.message : "Could not sign out of GitHub",
    };
  }
}
