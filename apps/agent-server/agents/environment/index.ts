// agent-server/agents/environment/index.ts

export { getShellEnvironment } from "./shell-env";

import { getShellEnvironment } from "./shell-env";

function shouldLoadShellEnvironment(): boolean {
  return process.env.DEUS_PACKAGED !== "1" && process.env.DEUS_RUNTIME !== "1";
}

/**
 * Fold the login shell's environment into process.env once at startup —
 * process.env wins on conflicts (same precedence the legacy per-turn env
 * builder used). The engine spreads process.env under every harness
 * subprocess, so this is all the env plumbing a turn needs. Packaged runtime
 * skips login-shell capture so bundled agent CLIs cannot silently fall
 * through to Homebrew/global PATH.
 */
export function applyShellEnvironment(): void {
  if (!shouldLoadShellEnvironment()) return;
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
    console.error("Failed to load shell environment, continuing without it:", error);
  }
}
