// agent-server/agents/notebook-server.ts
// Factory for the notebook MCP server stdio config.
//
// Returns an McpStdioServerConfig that the Claude SDK will spawn as a
// child process. The notebook server persists a .ipynb file at
// {workspacePath}/.context/notebook.ipynb so the frontend can read it.

import * as path from "path";
import * as fs from "fs";

/**
 * Resolves the absolute path to the bundled notebook MCP server.
 *
 * Strategy:
 * - The agent-server runs from its bundled CJS file (both dev and prod).
 * - The notebook server is bundled to `notebook-server.bundled.cjs` in the same directory.
 * - We resolve relative to `process.argv[1]` (the agent-server entry point).
 */
function resolveNotebookServerPath(): string | null {
  // 1. Env var from Electron main process (set in backend-process.ts)
  const envPath = process.env.NOTEBOOK_SERVER_BUNDLE_PATH;
  if (envPath && fs.existsSync(envPath)) {
    return envPath;
  }

  // 2. Same directory as the agent-server bundle (production layout)
  const agentServerDir = path.dirname(process.argv[1]);
  const bundledPath = path.join(agentServerDir, "notebook-server.bundled.cjs");
  if (fs.existsSync(bundledPath)) {
    return bundledPath;
  }

  console.warn(
    `[notebook-server] Bundled server not found. ` +
      `Checked: NOTEBOOK_SERVER_BUNDLE_PATH=${envPath ?? "(unset)"}, ${bundledPath}. ` +
      `Run 'bun run build:agent-server' to build it.`
  );
  return null;
}

/**
 * Creates the notebook MCP server config for injection into sdkOptions.mcpServers.
 * Returns an empty object if the server bundle is not found (graceful degradation).
 */
export function createNotebookMCPServer(
  workingDirectory: string | undefined
): Record<string, { command: string; args: string[]; env: Record<string, string> }> {
  if (!workingDirectory) return {};

  const serverPath = resolveNotebookServerPath();
  if (!serverPath) return {};

  const notebookPath = path.join(workingDirectory, ".context", "notebook.ipynb");

  return {
    notebook: {
      command: "node",
      args: [serverPath],
      env: {
        // Spread process.env so the spawned server inherits PATH, HOME,
        // NODE_PATH, and any other env vars the agent-server was launched with.
        // The MCP SDK's StdioClientTransport only auto-inherits a small
        // whitelist (HOME, PATH, SHELL, TERM, USER, LOGNAME on macOS).
        // Filter out undefined values (process.env values are string | undefined).
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            (entry): entry is [string, string] => entry[1] !== undefined
          )
        ),
        NOTEBOOK_CWD: workingDirectory,
        NOTEBOOK_PATH: notebookPath,
      },
    },
  };
}
