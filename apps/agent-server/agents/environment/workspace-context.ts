// agent-server/agents/environment/workspace-context.ts
// Shared workspace context for agent system prompts.
// Both Claude and Codex handlers use this to tell agents about the
// Deus orchestrator, worktree location, and actual project name.

import * as path from "path";

/**
 * Derives the project (repo) name from a worktree path.
 * Worktrees live at `/path/to/repo/.deus/{workspace-name}`.
 * Returns the repo directory name, or falls back to the leaf directory.
 */
export function getProjectName(cwd: string): string {
  const marker = "/.deus/";
  const idx = cwd.indexOf(marker);
  if (idx === -1) return path.basename(cwd);
  return path.basename(cwd.substring(0, idx));
}

/**
 * Builds concise workspace context for any agent.
 * Includes project name, worktree path, and orchestrator info.
 */
export function buildWorkspaceContext(cwd?: string): string {
  if (!cwd) return "";

  const projectName = getProjectName(cwd);
  return (
    `You are working inside Deus, a desktop app that orchestrates multiple AI coding agents in parallel.\n` +
    `Project: **${projectName}**. ` +
    `Your working directory is a git worktree at \`${cwd}\` — the directory name is the workspace name, not the project name. ` +
    `You can only edit files within this worktree. Each workspace has a .context directory (gitignored) for cross-agent collaboration.\n` +
    `A built-in browser and iOS Simulator are available for visually testing UI changes. If you don't see these tools, ask the user to enable them in Settings > Experimental Features.\n` +
    `You can render live HTML+CSS previews inline in chat using the \`html-preview\` code fence — it renders in an isolated Shadow DOM instead of showing code. Use this naturally whenever showing is clearer than describing (design options, component variations, layout ideas).`
  );
}
