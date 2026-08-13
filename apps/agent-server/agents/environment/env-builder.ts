// agent-server/agents/environment/env-builder.ts
// Shared environment construction for agent sessions.
// Builds the layered environment: shell env in dev → process.env → extra env.

import { getShellEnvironment } from "./shell-env";

function shouldLoadShellEnvironment(): boolean {
  return process.env.DEUS_PACKAGED !== "1" && process.env.DEUS_RUNTIME !== "1";
}

/**
 * Builds the environment variable object for an agent session.
 *
 * Layer precedence (later layers override earlier):
 * 1. Shell environment (login shell capture, dev/source runtime only)
 * 2. process.env (agent-server process environment)
 * 3. extraEnv (agent-specific static env vars)
 */
export function buildAgentEnvironment(options?: {
  extraEnv?: Record<string, string>;
}): Record<string, string> {
  const env: Record<string, string> = {};

  // Layer 1: Shell environment. Packaged runtime skips login-shell capture so
  // bundled agent CLIs cannot silently fall through to Homebrew/global PATH.
  if (shouldLoadShellEnvironment()) {
    try {
      Object.assign(env, getShellEnvironment());
    } catch (error) {
      console.error("Failed to load shell environment, continuing without it:", error);
    }
  }

  // Layer 2: process.env
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }

  // Layer 3: Extra static env vars
  if (options?.extraEnv) {
    for (const [key, value] of Object.entries(options.extraEnv)) {
      env[key] = value;
    }
  }

  return env;
}
