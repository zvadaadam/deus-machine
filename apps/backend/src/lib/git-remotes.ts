import { runGit } from "@shared/lib/git-process";

/** Get a git remote URL asynchronously. Returns null if remote doesn't exist or git fails. */
export async function getGitRemoteUrl(
  rootPath: string,
  remoteName = "origin"
): Promise<string | null> {
  try {
    const stdout = await runGit(["remote", "get-url", remoteName], {
      cwd: rootPath,
      timeoutMs: 2000,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}
