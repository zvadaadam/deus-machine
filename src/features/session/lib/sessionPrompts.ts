/**
 * Action prompt catalogue — plain-text prompts for UI-triggered agent actions.
 *
 * All prompts that originate from button clicks (not user-typed messages) live here.
 * The sidecar receives raw text via onSend(string) — no template engine, no structured format.
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

/** Instructs the agent to fix failing CI checks */
export const FIX_CI = "Fix the failing CI checks on the PR";

/** Instructs the agent to address review comments */
export const ADDRESS_REVIEW = "Address the review comments on the PR";

/** Instructs the agent to merge the PR */
export const MERGE_PR = "Merge the PR";

// ---------------------------------------------------------------------------
// Workspace setup
// ---------------------------------------------------------------------------

/**
 * Instructs the agent to analyze the project and generate a opendevs.json manifest.
 * Sent when user clicks "Set up your environment" in a fresh workspace.
 * Keep in sync with .claude/skills/generate-opendevs-json/SKILL.md
 */
export const GENERATE_HIVE_JSON = `Analyze this project and generate a \`opendevs.json\` manifest file at the project root. This manifest tells the IDE how to set up workspaces, run dev servers, and execute common tasks.

**Steps:**
1. Detect the tech stack from lockfiles and project files (package.json, Cargo.toml, pyproject.toml, etc.)
2. Detect the package manager (bun, npm, yarn, pnpm, cargo, uv, pip, etc.)
3. Check for existing configs to import from: \`opendevs.json\`, \`.codex/environments/environment.toml\`
4. Extract scripts from package.json (or equivalent) and map them to tasks
5. Detect runtime requirements (.nvmrc, engines field, rust-toolchain.toml, etc.)
6. Write the \`opendevs.json\` file

**Schema:**
\`\`\`json
{
  "$schema": "https://opendevs.dev/schemas/opendevs.json",
  "version": 1,
  "name": "<project name>",
  "scripts": { "setup": "<install command>", "run": "<main dev command>" },
  "requires": { "<runtime>": ">= <version>" },
  "env": {},
  "lifecycle": { "setup": "<setup script>" },
  "tasks": {
    "<name>": "<command>",
    "<name>": { "command": "<cmd>", "icon": "<lucide-icon>", "persistent": true, "description": "..." }
  }
}
\`\`\`

**Script-to-task mapping:**
- dev/start/serve → task "dev" (icon: "play", persistent: true)
- build/compile → task "build" (icon: "hammer")
- test → task "test" (icon: "check-circle")
- lint → task "lint" (icon: "search-code")
- format/fmt → task "format" (icon: "paintbrush")
- typecheck/tsc → task "typecheck" (icon: "search-code")
- deploy/release → task "deploy" (icon: "rocket")
- storybook → task "storybook" (icon: "book-open", persistent: true)

**Rules:**
- Use string shorthand for simple tasks: \`"test": "bun run test"\`
- Use object form only when task needs icon, depends, persistent, or mode
- Always include backwards-compatible \`scripts.setup\` and \`scripts.run\` fields
- Dev tasks with long-running servers must have \`persistent: true\`
- Write the file, then show a brief summary of what was generated`;

/**
 * Instructs the agent to fix a failed setup script.
 * @param setupError - The error output from the failed setup command
 */
export function fixSetupErrorPrompt(setupError: string | null): string {
  return `The workspace setup script failed.\n\nError: ${setupError ?? "Unknown error"}\n\nPlease look at the opendevs.json manifest and the setup script, diagnose the issue, fix it, and then I'll retry the setup.`;
}
