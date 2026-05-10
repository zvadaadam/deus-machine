import { execFile } from "child_process";
import { promisify } from "util";
import { parseGhAuthStatus } from "../../../shared/lib/github";
import { checkCliTool, getCliLookupEnv } from "./cli-tools";

const execFileAsync = promisify(execFile);

export interface GhAuthCommandResult {
  success: boolean;
  path: string | null;
  error?: string;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function wasKilled(error: unknown): boolean {
  return typeof error === "object" && error != null && "killed" in error && error.killed === true;
}

/**
 * Internal: read the active github.com login from `gh auth status`.
 * Used only by `logoutGhAuth` to find which user to sign out. The web
 * UI gets identity (login + display name + avatar) from the backend's
 * /api/gh-status endpoint, which calls `gh api user` for the full record.
 */
async function readActiveGhLogin(ghPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      ghPath,
      ["auth", "status", "--hostname", "github.com", "--active", "--json", "hosts"],
      {
        env: {
          ...getCliLookupEnv(),
          GH_NO_UPDATE_NOTIFIER: "1",
        },
        timeout: 5_000,
      }
    );
    const account = parseGhAuthStatus(stdout);
    return account.authenticated ? account.login : null;
  } catch {
    return null;
  }
}

export async function startGhAuthLogin(): Promise<GhAuthCommandResult> {
  const gh = await checkCliTool("gh");
  if (!gh.installed || !gh.path) {
    return { success: false, path: null, error: "GitHub CLI not found" };
  }

  try {
    await execFileAsync(
      gh.path,
      [
        "auth",
        "login",
        "--hostname",
        "github.com",
        "--git-protocol",
        "https",
        "--web",
        "--clipboard",
      ],
      {
        env: {
          ...getCliLookupEnv(),
          GH_NO_UPDATE_NOTIFIER: "1",
        },
        timeout: 10 * 60 * 1000,
      }
    );
    return { success: true, path: gh.path };
  } catch (error) {
    if (wasKilled(error)) {
      return {
        success: false,
        path: gh.path,
        error: "GitHub sign-in timed out",
      };
    }

    return {
      success: false,
      path: gh.path,
      error: `GitHub sign-in did not complete: ${getErrorMessage(error)}`,
    };
  }
}

export async function logoutGhAuth(): Promise<GhAuthCommandResult> {
  const gh = await checkCliTool("gh");
  if (!gh.installed || !gh.path) {
    return { success: false, path: null, error: "GitHub CLI not found" };
  }

  const activeLogin = await readActiveGhLogin(gh.path);
  if (!activeLogin) {
    return { success: false, path: gh.path, error: "No active GitHub CLI account found" };
  }

  try {
    await execFileAsync(
      gh.path,
      ["auth", "logout", "--hostname", "github.com", "--user", activeLogin],
      {
        env: {
          ...getCliLookupEnv(),
          GH_PROMPT_DISABLED: "1",
          GH_NO_UPDATE_NOTIFIER: "1",
        },
        timeout: 15_000,
      }
    );
    return { success: true, path: gh.path };
  } catch (error) {
    if (wasKilled(error)) {
      return {
        success: false,
        path: gh.path,
        error: "GitHub sign-out timed out",
      };
    }

    return {
      success: false,
      path: gh.path,
      error: `GitHub sign-out did not complete: ${getErrorMessage(error)}`,
    };
  }
}
