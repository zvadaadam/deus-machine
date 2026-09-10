/**
 * Action prompt catalogue — plain-text prompts for UI-triggered agent actions.
 *
 * All prompts that originate from button clicks (not user-typed messages) live here.
 * The agent-server receives raw text via onSend(string) — no template engine, no structured format.
 *
 * Static prompts are string constants. Parameterized prompts are functions.
 * Add new exports here when adding new action buttons.
 */

// ---------------------------------------------------------------------------
// Conversation management
// ---------------------------------------------------------------------------

/** Claude Code built-in slash-command that compresses conversation context */
export const COMPACT_CONVERSATION = "/compact";

// ---------------------------------------------------------------------------
// Pull request actions
// ---------------------------------------------------------------------------

/** Instructs the agent to create a PR targeting the given branch */
export function createPRPrompt(targetBranch = "main"): string {
  return `Create a PR onto ${targetBranch}`;
}

/** Instructs the agent to resolve merge conflicts on the PR */
export const RESOLVE_CONFLICTS = "Resolve the merge conflicts on the PR and push the fix";

/** Instructs the agent to fix failing CI checks, with optional check details */
export function fixCIPrompt(failingChecks?: { name: string; url?: string }[]): string {
  if (!failingChecks?.length) return "Fix the failing CI checks on the PR";
  const list = failingChecks
    .map((c) => (c.url ? `- ${c.name}: ${c.url}` : `- ${c.name}`))
    .join("\n");
  return `Fix the failing CI checks on the PR:\n\n${list}`;
}

/** Instructs the agent to address review comments */
export const ADDRESS_REVIEW = "Address the review comments on the PR";

/** Instructs the agent to merge the PR */
export const MERGE_PR = "Merge the PR";

/** Code review prompt — inserted into chat input from the Code panel Review button */
export const REVIEW_CODE = `Review the current code changes in this workspace. Analyze the diff for:
- Bugs, logic errors, or edge cases
- Performance issues or unnecessary complexity
- Security concerns (hardcoded secrets, injection, unsafe patterns)
- Code style and consistency with the existing codebase
- Missing error handling or tests

Provide a concise summary of findings with specific file and line references.`;

// ---------------------------------------------------------------------------
// Workspace setup
// ---------------------------------------------------------------------------

/** Shared setup workflow for settings, the workspace header and composer. */
export function setupEnvironmentPrompt(location: "local" | "cloud"): string {
  const workflow = `Set up this repository's ${location} development environment.

Inspect the repository instructions, lockfiles, existing configuration and scripts first. Preserve working behavior and use the project's pinned package manager and tool versions. Explain the setup strategy briefly, then implement it.

Separate installation from running the app: setup must be non-interactive, finish successfully and be safe to rerun. Keep development servers and watchers out of setup. Prefer existing scripts; use a small script file when several commands need shared shell state. Do not rewrite lockfiles or upgrade dependencies just to set up the environment.

Run the proposed setup, rerun it to check idempotence, then start the app and check an actual readiness signal. Run relevant existing checks. Stop the temporary processes you started after validation. Report what passed, what failed and which checks you could not run. Do not claim a fresh-workspace test unless you performed one.

Never write secret values into committed configuration, scripts, logs or chat. Report only the names of missing values. Do not deploy, publish or change shared infrastructure as part of setup.`;

  return `${workflow}

The public recipe is .deus/environment.json with version: 1, setup and run command strings, optional local/cloud command overrides, env for PUBLIC defaults, requiredEnv for secret NAMES, and tasks as name-to-command strings. Shared scripts apply to local and cloud; add an override only for an actual platform difference. Run must stay in the foreground; cloud starts it after setup, local uses the Run button.
Read the file in THIS checkout first. If it exists, edit it and use normal Git publication. Never copy another branch's recipe or secret values. Changes to this file affect this checkout; an unpushed edit is not shared.
${
  location === "cloud"
    ? "When the file is absent, use agnt_configure_environment with the verified project recipe to save shared defaults. If the tool fails, say the settings were not saved. Do not build a platform template."
    : "When the file is absent, prepare .deus/environment.json in this checkout and explain that it must be committed and pushed to share it. Local .env and .env.local files remain local; cloud secrets are configured separately in Environment settings."
}
Saving does not restart an existing workspace. Test your commands here explicitly and report the result.`;
}

/**
 * Instructs the agent to fix a failed setup script.
 * @param setupError - The error output from the failed setup command
 */
export function fixSetupErrorPrompt(setupError: string | null): string {
  return `The workspace setup script failed.\n\nError: ${setupError ?? "Unknown error"}\n\nPlease look at the .deus/environment.json recipe and the setup script, diagnose the issue, fix it, and then I'll retry the setup.`;
}
