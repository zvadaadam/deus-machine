/**
 * Shell Environment Sync
 *
 * On macOS, when the development app is launched from Finder (not from a
 * terminal), the PATH is minimal (/usr/bin:/bin:/usr/sbin:/sbin). This means
 * developer tools may not be found.
 *
 * This module runs the user's login shell to capture the full PATH for dev
 * only. Packaged, the backend's engine adds the login shell's PATH itself
 * (apps/agent-server/agents/environment), after the bundled bin folder.
 *
 * Ensures dev child processes get the user's full shell environment.
 */

import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/** PATH as the app was started, before the first sync replaced it. */
let launchPath: string | undefined;

/**
 * The PATH the app was started with: the terminal's for `bun run dev` (whose
 * `node` the native modules were built for by `bun run native:node`), Finder's
 * minimal one otherwise. The current PATH when no sync has replaced it.
 */
export function getLaunchPath(): string {
  return launchPath ?? process.env.PATH ?? "";
}

export async function syncShellEnvironment(): Promise<void> {
  if (process.platform !== "darwin") return;
  if (process.env.DEUS_PACKAGED === "1") return;

  try {
    // Detect user's actual login shell via dscl (macOS directory service),
    // falling back to SHELL env var. Finder-launched apps may not have SHELL set correctly.
    let userShell = "/bin/zsh";
    try {
      const { stdout: dsclOut } = await execFileAsync("dscl", [
        ".",
        "-read",
        `/Users/${process.env.USER}`,
        "UserShell",
      ]);
      const shellMatch = dsclOut.match(/UserShell:\s*(.+)/);
      if (shellMatch) userShell = shellMatch[1].trim();
    } catch {
      userShell = process.env.SHELL || "/bin/zsh";
    }

    // Run the shell in login + interactive mode to source all profile files,
    // then print PATH. The -i flag ensures .zshrc/.bashrc are sourced.
    const { stdout } = await execFileAsync(userShell, ["-ilc", "echo __PATH__=$PATH"], {
      timeout: 5_000,
      env: { ...process.env },
    });

    // Parse the PATH from output
    const match = stdout.match(/__PATH__=(.+)/);
    if (match?.[1]) {
      launchPath ??= process.env.PATH ?? "";
      process.env.PATH = match[1].trim();
    }
  } catch (err) {
    // Non-fatal — app continues with the default PATH.
    // User may need to launch from terminal or install tools globally.
    console.warn("[shell-env] Failed to sync shell environment:", err);
  }
}
