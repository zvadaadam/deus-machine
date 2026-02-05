// sidecar/agents/env-builder.ts
// Shared environment construction for all agent handlers.
// Builds the 6-layer environment: shell env → process.env → extra env →
// conductorEnv → claudeEnvVars → ghToken.

import { getShellEnvironment } from "./shell-env";

/**
 * Parses a multi-line "KEY=value" env string (supports export prefix, quoting).
 * Used to parse user-provided environment variable overrides.
 */
export function parseEnvString(envString: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = envString.split("\n");
  let i = 0;

  while (i < lines.length) {
    let line = lines[i].trim();
    if (!line || line.startsWith("#")) {
      i++;
      continue;
    }
    if (line.startsWith("export ")) {
      line = line.substring(7).trim();
    }

    const equalIndex = line.indexOf("=");
    if (equalIndex === -1) {
      i++;
      continue;
    }

    const key = line.substring(0, equalIndex).trim();
    if (!key) {
      i++;
      continue;
    }

    let value = line.substring(equalIndex + 1).trim();

    // Handle quoted values (may span multiple lines)
    if ((value.startsWith('"') || value.startsWith("'")) && value.length > 1) {
      const quote = value[0];
      let endQuoteIndex = value.indexOf(quote, 1);
      while (endQuoteIndex === -1 && i + 1 < lines.length) {
        i++;
        value += "\n" + lines[i];
        endQuoteIndex = value.indexOf(quote, 1);
      }
      if (endQuoteIndex !== -1) {
        value = value.substring(1, endQuoteIndex);
      }
    }

    result[key] = value;
    i++;
  }
  return result;
}

/**
 * Builds the environment variable object for an agent session.
 *
 * Layer precedence (later layers override earlier):
 * 1. Shell environment (login shell capture)
 * 2. process.env (sidecar process environment)
 * 3. extraEnv (agent-specific static env vars, e.g. CLAUDE_CODE_ENABLE_TASKS)
 * 4. conductorEnv (from frontend options)
 * 5. claudeEnvVars (user-configured env string, empty values delete keys)
 * 6. ghToken (sets GH_TOKEN if provided)
 */
export function buildAgentEnvironment(options?: {
  claudeEnvVars?: string;
  conductorEnv?: Record<string, string>;
  ghToken?: string;
  extraEnv?: Record<string, string>;
}): Record<string, string> {
  const env: Record<string, string> = {};

  // Layer 1: Shell environment
  try {
    Object.assign(env, getShellEnvironment());
  } catch (error) {
    console.error("Failed to load shell environment, continuing without it:", error);
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

  // Layer 4: Conductor env (from frontend)
  if (options?.conductorEnv) {
    for (const [key, value] of Object.entries(options.conductorEnv)) {
      env[key] = value;
    }
  }

  // Layer 5: User-configured env vars (empty values delete keys)
  if (options?.claudeEnvVars) {
    const parsed = parseEnvString(options.claudeEnvVars);
    for (const [key, value] of Object.entries(parsed)) {
      if (value === "") delete env[key];
      else env[key] = value;
    }
  }

  // Layer 6: GitHub token
  if (options?.ghToken) env["GH_TOKEN"] = options.ghToken;

  return env;
}
