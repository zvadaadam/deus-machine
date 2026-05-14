// agent-server/agents/codex-server/codex-server-discovery.ts
// Discovery for the Codex app-server harness. Kept separate from the existing
// `codex-sdk` harness so app-server can require a newer Codex binary without
// changing current Codex sessions.

import {
  blockIfNotInitialized as sharedBlock,
  discoverExecutable,
  type DiscoveryState,
} from "../environment/cli-discovery";

const MIN_CODEX_APP_SERVER_VERSION = "0.128.0";

const state: DiscoveryState = { executablePath: "", result: null };

export function getCodexServerExecutablePath(): string {
  return state.executablePath;
}

export function initializeCodexServer(): { success: boolean; error?: string } {
  const result = discoverExecutable(
    {
      agentHarness: "codex-server",
      displayName: "Codex app-server",
      envVars: ["CODEX_APP_SERVER_CLI_PATH", "CODEX_CLI_PATH"],
      bundledTool: "codex",
      versionFlag: "--version",
      validateVersion: validateCodexAppServerVersion,
    },
    state
  );

  return result;
}

export function blockIfCodexServerNotInitialized(sessionId: string): boolean {
  return sharedBlock(state, "codex-server", sessionId);
}

function validateCodexAppServerVersion(versionOutput: string): {
  success: boolean;
  error?: string;
} {
  const version = readCodexVersion(versionOutput);
  if (isVersionAtLeast(version, MIN_CODEX_APP_SERVER_VERSION)) {
    return { success: true };
  }

  return {
    success: false,
    error:
      `requires codex-cli >= ${MIN_CODEX_APP_SERVER_VERSION}; ` + `found ${version || "unknown"}`,
  };
}

function readCodexVersion(versionOutput: string): string | null {
  return versionOutput.match(/\d+\.\d+\.\d+/)?.[0] ?? null;
}

function isVersionAtLeast(version: string | null, minimum: string): boolean {
  if (!version) return false;
  const currentParts = version.split(".").map(Number);
  const minimumParts = minimum.split(".").map(Number);

  for (let i = 0; i < minimumParts.length; i++) {
    const current = currentParts[i] ?? 0;
    const required = minimumParts[i] ?? 0;
    if (current > required) return true;
    if (current < required) return false;
  }
  return true;
}
