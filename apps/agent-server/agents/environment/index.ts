// agent-server/agents/environment/index.ts

export { getShellEnvironment } from "./shell-env";

import { getShellEnvironment } from "./shell-env";

/**
 * Fold the login shell's environment into process.env once at startup —
 * process.env wins on conflicts (same precedence the legacy per-turn env
 * builder used). The engine merges process.env into each subprocess, then
 * the native spawn hook strips the backend's runtime settings. The installed
 * app's PATH (the bundled bin folder, then the system folders) keeps
 * precedence, and the login shell's entries (Homebrew, nvm, bun, …) come
 * after, so the bundled CLIs still win (and are pinned through
 * CLAUDE_CLI_PATH / CODEX_CLI_PATH as well).
 */
export function applyShellEnvironment(): void {
  try {
    for (const [key, value] of Object.entries(getShellEnvironment())) {
      if (key === "PATH" && process.env.PATH) {
        // Union rather than skip: a GUI-launched process has a minimal PATH,
        // and the login shell's entries (homebrew, nvm, …) must still be
        // findable. Current entries keep precedence.
        const current = process.env.PATH.split(":").filter(Boolean);
        const merged = new Set([...current, ...value.split(":").filter(Boolean)]);
        process.env.PATH = [...merged].join(":");
        continue;
      }
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch (error) {
    // Never the error itself: a shell killed at its timeout leaves what `env`
    // had already printed on it.
    const { code, signal } = error as { code?: string; signal?: string };
    console.error(
      `Failed to load shell environment (${code ?? signal ?? "error"}), continuing without it`
    );
  }
}
