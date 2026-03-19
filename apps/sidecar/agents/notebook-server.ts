// sidecar/agents/notebook-server.ts
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
 * - The sidecar runs from its bundled CJS file (both dev and prod).
 * - The notebook server is bundled to `notebook-server.bundled.cjs` in the same directory.
 * - We resolve relative to `process.argv[1]` (the sidecar entry point).
 */
function resolveNotebookServerPath(): string | null {
  // Primary: bundled CJS in the same directory as the sidecar
  const sidecarDir = path.dirname(process.argv[1]);
  const bundledPath = path.join(sidecarDir, "notebook-server.bundled.cjs");
  if (fs.existsSync(bundledPath)) {
    return bundledPath;
  }

  console.warn(
    `[notebook-server] Bundled server not found at ${bundledPath}. ` +
      `Run 'bun run build:sidecar' to build it.`
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
        // NODE_PATH, and any other env vars the sidecar was launched with.
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
