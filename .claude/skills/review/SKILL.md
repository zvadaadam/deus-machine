---
name: review
description: Review code changes for quality, security, and CLAUDE.md compliance. Use when reviewing a PR, after finishing implementation, or when asked to check code quality. Triggers on "review", "check my code", "look at changes", "PR review".
context: fork
agent: code-reviewer
allowed-tools: Bash(git *)
argument-hint: "[branch|file|--staged]"
---

Review the current code changes for quality, security, performance, and adherence to project conventions.

## What to review

Determine scope from the arguments:
- No arguments: review all uncommitted changes (`git diff` + `git diff --cached`)
- `--staged`: review only staged changes (`git diff --cached`)
- A branch name: review changes vs that branch (`git diff <branch>...HEAD`)
- A file path: review only that specific file

## Steps

1. **Gather changes**: Run the appropriate git diff command to see what changed
2. **Read changed files**: Read the full content of each changed file for context
3. **Check CLAUDE.md compliance**: Verify changes follow the project's documented conventions
4. **Assess risk tier**: Note which risk tier the changed files fall into:
   - **High risk**: `src-tauri/src/`, `sidecar/`, `backend/src/lib/schema.ts`, `backend/src/lib/database.ts`
   - **Medium risk**: `backend/src/`, `src/platform/`, `src/features/*/api/`
   - **Low risk**: `src/components/`, `src/features/*/ui/`, tests, config files
5. **Produce report**: Output structured findings organized by severity

## Key conventions to check

- Bun, not npm/yarn
- Tailwind CSS v4 (no JS config, no `@apply`, no `@layer`, OKLCH colors)
- Zustand for UI state only, TanStack Query for server state
- `ts-pattern` for discriminated union dispatch
- No hardcoded colors — use CSS variables/tokens
- No N+1 queries — use denormalized columns or batch queries
- New query patterns must have indexes in `schema.ts`
- Components in `src/features/{feature}/ui/` by default
- Shadcn components are editable — check if overrides should be component edits instead

## Output

Produce a clear, actionable review. For each finding:
- State the file and line
- Explain what's wrong and why it matters
- Suggest a specific fix

End with a summary: `X critical / Y warnings / Z suggestions`

$ARGUMENTS
