/**
 * Shell Environment Sync
 *
 * On macOS, when an app is launched from Finder (not from a terminal),
 * the PATH is minimal (/usr/bin:/bin:/usr/sbin:/sbin). This means tools
 * like `git`, `gh`, `node`, and `bun` are not found.
 *
 * This module runs the user's login shell to capture the full PATH and
 * applies it to process.env before spawning the backend or any child processes.
 *
 * Pattern borrowed from T3 Code (syncShellEnvironment.ts) and VS Code.
 */

import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export async function syncShellEnvironment(): Promise<void> {
  if (process.platform !== "darwin") return;

  try {
    // Detect user's shell from SHELL env var (defaults to /bin/zsh on modern macOS)
    const userShell = process.env.SHELL || "/bin/zsh";

    // Run the shell in login + interactive mode to source all profile files,
    // then print PATH. The -i flag ensures .zshrc/.bashrc are sourced.
    const { stdout } = await execFileAsync(userShell, ["-ilc", "echo __PATH__=$PATH"], {
      timeout: 5_000,
      env: { ...process.env },
    });

    // Parse the PATH from output
    const match = stdout.match(/__PATH__=(.+)/);
    if (match?.[1]) {
      process.env.PATH = match[1].trim();
    }
  } catch (err) {
    // Non-fatal — app continues with the default PATH.
    // User may need to launch from terminal or install tools globally.
    console.warn("[shell-env] Failed to sync shell environment:", err);
  }
}
