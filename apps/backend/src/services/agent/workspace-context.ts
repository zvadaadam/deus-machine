// backend/src/services/agent/workspace-context.ts
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

/** The device a workspace's Simulator tab shows: its UDID only, since a device's name is text a person or an agent chose. */
export interface Simulator {
  udid: string;
}

/**
 * Builds concise workspace context for any agent.
 * Includes project name, worktree path, and orchestrator info.
 */
export function buildWorkspaceContext(cwd?: string, simulator?: Simulator | null): string {
  if (!cwd) return "";

  const projectName = getProjectName(cwd);
  return (
    `You are working inside Deus, a desktop app that orchestrates multiple AI coding agents in parallel.\n` +
    `Project: **${projectName}**. ` +
    `Your working directory is a git worktree at \`${cwd}\` — the directory name is the workspace name, not the project name. ` +
    `You can only edit files within this worktree. Each workspace has a .context directory (gitignored) for cross-agent collaboration.\n` +
    `A built-in browser is available for testing UI changes.\n` +
    (simulator
      ? `This workspace's Simulator tab shows the simulator ${simulator.udid}: pass \`--udid ${simulator.udid}\` to agent-device so the person sees what you do.\n`
      : "") +
    `You can render live HTML+CSS previews inline in chat using the \`html-preview\` code fence — it renders in an isolated Shadow DOM instead of showing code. Use this naturally whenever showing is clearer than describing (design options, component variations, layout ideas).`
  );
}
