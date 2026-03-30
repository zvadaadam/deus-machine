// agent-server/agents/screen-studio-server.ts
// Factory for the screen-studio MCP server stdio config.
//
// Returns an McpStdioServerConfig that the Claude SDK will spawn as a
// child process. The screen-studio server provides recording tools
// (start, stop, event, chapter, status) for creating polished demo videos.

import * as path from "path";
import * as fs from "fs";

const TARGET = "packages/screen-studio/dist/mcp/index.cjs";

/**
 * Walk up from a directory looking for the screen-studio MCP server.
 * Tries up to `maxDepth` parent directories.
 */
function walkUp(startDir: string, maxDepth = 6): string | null {
  let dir = startDir;
  for (let i = 0; i < maxDepth; i++) {
    const candidate = path.join(dir, TARGET);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Resolves the absolute path to the screen-studio MCP server entry point.
 *
 * Strategy:
 * 1. SCREEN_STUDIO_SERVER_PATH env var (set by Electron main in production)
 * 2. Walk up from process.argv[1] (agent-server bundle location — works in both dev and prod)
 * 3. Walk up from cwd (fallback)
 */
function resolveScreenStudioServerPath(): string | null {
  // 1. Explicit env var
  const envPath = process.env.SCREEN_STUDIO_SERVER_PATH;
  if (envPath && fs.existsSync(envPath)) {
    return envPath;
  }

  // 2. Walk up from the agent-server entry point
  //    In dev: apps/agent-server/dist/index.bundled.cjs → walk up 2 levels → repo root
  //    In prod: resources/bin/index.bundled.cjs → won't find it (needs env var)
  const fromArgv = walkUp(path.dirname(process.argv[1]));
  if (fromArgv) return fromArgv;

  // 3. Walk up from cwd
  const fromCwd = walkUp(process.cwd());
  if (fromCwd) return fromCwd;

  console.warn(
    `[screen-studio-server] Server not found. ` +
      `Checked: SCREEN_STUDIO_SERVER_PATH=${envPath ?? "(unset)"}, ` +
      `walked up from argv[1]=${process.argv[1]} and cwd=${process.cwd()}. ` +
      `Run 'cd packages/screen-studio && bun run build' to build it.`
  );
  return null;
}

/**
 * Creates the screen-studio MCP server config for injection into sdkOptions.mcpServers.
 * Returns an empty object if the server is not found (graceful degradation).
 */
export function createScreenStudioMCPServer(): Record<
  string,
  { command: string; args: string[]; env: Record<string, string> }
> {
  const serverPath = resolveScreenStudioServerPath();
  if (!serverPath) return {};

  console.log(`[screen-studio-server] Resolved server at: ${serverPath}`);

  return {
    "screen-studio": {
      command: "node",
      args: [serverPath],
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            (entry): entry is [string, string] => entry[1] !== undefined
          )
        ),
      },
    },
  };
}
