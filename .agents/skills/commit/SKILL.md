---
name: commit
description: Create a well-crafted git commit following project conventions. Analyzes staged changes, computes risk tier, and writes a concise commit message. Use after completing work.
disable-model-invocation: true
argument-hint: "[optional message hint]"
---

Create a git commit for the current staged changes.

## Context

Staged changes:
!`git diff --cached --stat`

Unstaged changes (NOT being committed):
!`git diff --stat`

Untracked files:
!`git status --short | grep '^??' | head -20`

Recent commit style:
!`git log --oneline -8`

Current branch:
!`git branch --show-current`

## Process

1. **Review staged changes**: Read `git diff --cached` to understand what's being committed
2. **Check for problems**:
   - Are there `.env`, credentials, or secrets being committed? STOP and warn.
   - Are there large binaries or generated files? Warn.
   - Is `bun.lock` included if `package.json` changed? If not, warn.
3. **Classify the change**: Is it a feature, fix, refactor, chore, test, docs?
4. **Write the commit message**:
   - First line: concise summary (imperative mood, <72 chars)
   - Format: `type: description` (e.g., `feat: add workspace pagination`)
   - If needed, add a blank line + body explaining "why"
   - End with `Co-Authored-By: Claude <noreply@anthropic.com>` if I wrote the code
5. **Stage any missed files**: If there are unstaged changes that clearly belong with the commit, suggest staging them
6. **Commit**: Use `git commit -m` with a HEREDOC for multi-line messages

## Commit types

- `feat:` — new feature
- `fix:` — bug fix
- `refactor:` — code restructuring, no behavior change
- `chore:` — tooling, config, dependencies
- `test:` — adding or fixing tests
- `docs:` — documentation only
- `style:` — formatting, CSS, no logic change
- `perf:` — performance improvement

If the user provided a hint: $ARGUMENTS
