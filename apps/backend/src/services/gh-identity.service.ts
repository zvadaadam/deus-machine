import { parseGhAuthStatus } from "@shared/lib/github";
import type { GhCliStatus } from "@shared/types/github";
import os from "node:os";
import { runGh } from "./gh.service";

interface GhApiUser {
  login?: string;
  name?: string | null;
  avatar_url?: string;
  html_url?: string;
}

function parseGhApiUser(stdout: string): GhApiUser | null {
  try {
    const parsed = JSON.parse(stdout);
    if (parsed && typeof parsed === "object") return parsed as GhApiUser;
    return null;
  } catch {
    return null;
  }
}

/**
 * Resolve the active gh CLI account: install state, auth state, login,
 * display name, and avatar. Runs `gh --version`, `gh auth status`, and
 * `gh api user` in two stages — auth is checked before hitting the GitHub
 * API. Tolerates `gh api user` failures (e.g. offline) by returning the
 * login from auth status alone.
 */
export async function getGhIdentity(): Promise<GhCliStatus> {
  const cwd = os.homedir();
  const versionResult = await runGh(["--version"], { cwd, timeoutMs: 2000 });
  if (!versionResult.success) return { isInstalled: false, isAuthenticated: false };

  const authResult = await runGh(
    ["auth", "status", "--hostname", "github.com", "--active", "--json", "hosts"],
    { cwd, timeoutMs: 5000 }
  );
  if (!authResult.success) return { isInstalled: true, isAuthenticated: false };

  const account = parseGhAuthStatus(authResult.stdout);
  if (!account.authenticated) {
    return { isInstalled: true, isAuthenticated: false };
  }

  const apiResult = await runGh(["api", "user"], { cwd, timeoutMs: 5000 });
  const user = apiResult.success ? parseGhApiUser(apiResult.stdout) : null;

  return {
    isInstalled: true,
    isAuthenticated: true,
    login: user?.login ?? account.login,
    displayName: user?.name ?? null,
    avatarUrl: user?.avatar_url ?? null,
    htmlUrl: user?.html_url ?? null,
  };
}
