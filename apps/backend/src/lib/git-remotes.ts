import { execFileSync, execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
const GIT_REMOTE_TIMEOUT_MS = 2000;

/** Get a git remote URL synchronously. Returns null if remote doesn't exist or git fails. */
export function getGitRemoteUrlSync(rootPath: string, remoteName = "origin"): string | null {
  try {
    return (
      execFileSync("git", ["remote", "get-url", remoteName], {
        cwd: rootPath,
        encoding: "utf-8",
        timeout: GIT_REMOTE_TIMEOUT_MS,
      }).trim() || null
    );
  } catch {
    return null;
  }
}

/** Get a git remote URL asynchronously. Returns null if remote doesn't exist or git fails. */
export async function getGitRemoteUrl(
  rootPath: string,
  remoteName = "origin"
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["remote", "get-url", remoteName], {
      cwd: rootPath,
      encoding: "utf-8",
      timeout: GIT_REMOTE_TIMEOUT_MS,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}
