// sidecar/agents/environment/shell-env.ts
// Captures the user's login-shell environment so child processes (Claude SDK)
// inherit PATH, NVM, pyenv, etc. without manual configuration.

import { execFileSync } from "child_process";
import { stripVTControlCharacters } from "util";

let shellEnvironment: Record<string, string> | null = null;

const DELIMITER = "_SHELL_ENV_DELIMITER_";

function parseEnv(output: string): Record<string, string> {
  const envSection = output.split(DELIMITER)[1];
  if (!envSection) {
    return {};
  }

  const env: Record<string, string> = {};
  for (const line of stripVTControlCharacters(envSection).split("\n").filter(Boolean)) {
    const separatorIndex = line.indexOf("=");
    if (separatorIndex > 0) {
      const key = line.substring(0, separatorIndex);
      const value = line.substring(separatorIndex + 1);
      env[key] = value;
    }
  }
  return env;
}

/**
 * Keys stripped from the shell environment to prevent auth interference.
 * These are provider-specific keys that the user may have set globally
 * but that should not leak into the OpenDevs-managed Claude session.
 */
const STRIPPED_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
];

/**
 * Lazily captures and returns the user's interactive login-shell environment.
 * Results are cached after the first call.
 */
export function getShellEnvironment(): Record<string, string> {
  if (shellEnvironment !== null) {
    return shellEnvironment;
  }

  const shell = process.env.SHELL || "/bin/zsh";
  const command = `echo -n "${DELIMITER}"; env; echo -n "${DELIMITER}"; exit`;

  const output = execFileSync(shell, ["-ilc", command], {
    encoding: "utf8",
    timeout: 5_000,
    env: {
      // Prevent Oh My Zsh from blocking with auto-update prompts
      DISABLE_AUTO_UPDATE: "true",
    },
  });

  const env = parseEnv(output);

  for (const key of STRIPPED_ENV_KEYS) {
    if (key in env) {
      console.log(`Stripped ${key} from shell environment to prevent auth interference`);
      delete env[key];
    }
  }

  console.log(`Loaded ${Object.keys(env).length} environment variables from shell`);

  shellEnvironment = env;
  return env;
}
