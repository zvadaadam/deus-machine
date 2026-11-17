// agent-server/agents/environment/shell-env.ts
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
 * These are sign-ins and endpoints the user may have set globally, which
 * would silently replace the accounts Deus manages: the Claude or Codex
 * login a turn runs on, and the GitHub CLI's saved account (a token in the
 * environment also makes `gh auth login` refuse to run).
 */
const STRIPPED_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "GH_TOKEN",
  "GITHUB_TOKEN",
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
    // An interactive shell ignores SIGTERM, so a profile that hangs would hold
    // the backend's start for as long as it hangs: kill it outright.
    killSignal: "SIGKILL",
    // What a profile prints to stderr stays out of the backend's log.
    stdio: ["pipe", "pipe", "ignore"],
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
