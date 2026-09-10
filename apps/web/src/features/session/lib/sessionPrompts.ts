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

${
  location === "cloud"
    ? `This workspace runs on AGNT's managed E2B base template. Configure the repository bootstrap; do not build or promote a platform template.
Use agnt_configure_environment to save verified setup commands, the run command, needed apt packages and requiredEnv names. The run field is a foreground app command (such as bun run dev) that AGNT starts in the background after setup; do not add shell backgrounding. Each setup command runs in its own shell with the repository as its working directory; keep dependent commands together in a script. Preserve needed existing configuration when replacing a setup or packages list. Save only after verification and report the tool's result. If the tool is unavailable or fails, explain that setup was not saved.
Saving affects future cloud workspaces, not the running sandbox. Ask the user to supply missing values in Environment → this repository → Cloud.`
    : `Configure deus.json in this workspace using the existing manifest when present. Preserve unrelated fields.
Use version: 1, lifecycle.setup for installation, scripts.run for the development server, requires for tool requirements, and tasks for useful project commands. Mark long-running tasks persistent: true. The env field is only for public configuration.
Local lifecycle commands must be a single executable command. Put multiline logic, shell chaining and exports in a script file, then point lifecycle.setup at that script. Keep scripts portable for the current machine and the repository's supported platforms.
Verify the saved commands, then summarize the changes for review. Local setup is versioned with the repository: changes in this workspace must be merged into the branch used for future workspaces. Do not write into another checkout, commit, push or merge automatically.`
}`;
}

/**
 * Instructs the agent to fix a failed setup script.
 * @param setupError - The error output from the failed setup command
 */
export function fixSetupErrorPrompt(setupError: string | null): string {
  return `The workspace setup script failed.\n\nError: ${setupError ?? "Unknown error"}\n\nPlease look at the deus.json manifest and the setup script, diagnose the issue, fix it, and then I'll retry the setup.`;
}
