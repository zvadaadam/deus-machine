/** Parse a git remote URL (SSH or HTTPS) into OWNER/REPO format. */
export function parseGitHubRepo(url: string): string | null {
  const sshMatch = url.match(/git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/);
  if (sshMatch) return sshMatch[1];

  const httpsMatch = url.match(/https?:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/);
  if (httpsMatch) return httpsMatch[1];

  return null;
}

export interface GhAuthAccount {
  authenticated: boolean;
  login: string | null;
}

/**
 * Parse the JSON output of `gh auth status --hostname github.com --active --json hosts`.
 * Returns the active github.com account, or an unauthenticated default if parsing fails
 * or no active account exists.
 */
export function parseGhAuthStatus(stdout: string): GhAuthAccount {
  try {
    const parsed = JSON.parse(stdout) as {
      hosts?: Record<
        string,
        Array<{ active?: boolean; login?: string; state?: string; host?: string }>
      >;
    };
    const account = parsed.hosts?.["github.com"]?.find((entry) => entry.active) ?? null;
    return {
      authenticated: account?.state === "success",
      login: account?.login ?? null,
    };
  } catch {
    return { authenticated: false, login: null };
  }
}
