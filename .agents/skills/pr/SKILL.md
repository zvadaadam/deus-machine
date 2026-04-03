---
name: pr
description: Create a pull request with proper title, description, and risk assessment. Analyzes all commits on the branch, computes risk tier, and creates the PR via gh CLI. Use when ready to open a PR.
disable-model-invocation: true
argument-hint: "[base-branch, default: main]"
---

Create a pull request for the current branch.

## Context

Current branch:
!`git branch --show-current`

Commits on this branch (vs main):
!`git log --oneline main..HEAD 2>/dev/null || echo "No commits ahead of main"`

Changed files (vs main):
!`git diff --name-only main...HEAD 2>/dev/null || echo "No changes"`

Diff stats:
!`git diff --stat main...HEAD 2>/dev/null || echo "No diff"`

## Process

1. **Check prerequisites**:
   - Is the branch pushed to remote? If not, push with `git push -u origin $(git branch --show-current)`
   - Are there uncommitted changes? Warn the user.
   - Is there at least one commit ahead of main?

2. **Analyze ALL commits** (not just the latest):
   - Read `git log main..HEAD` for full commit history
   - Read `git diff main...HEAD` for the complete diff
   - Understand the full scope of changes

3. **Classify risk tier**:
   - **Tier 1 (Critical)**: schema.ts, database.ts, agent-server core, Rust main/lib
   - **Tier 2 (High)**: routes, services, agents, git.rs, platform layer
   - **Tier 3 (Medium)**: UI features, stores, global.css
   - **Tier 4 (Low)**: docs, config, tests, Shadcn components

4. **Create the PR**:
   - Title: short (<70 chars), describes the "what"
   - Body: structured summary with risk tier and test plan

5. **Use `gh pr create`** with this format:

```bash
gh pr create --title "title here" --body "$(cat <<'EOF'
## Summary
- Bullet point 1
- Bullet point 2

## Risk tier
Tier X — [Critical|High|Medium|Low]

Changed areas: [list]

## Test plan
- [ ] `bun run typecheck`
- [ ] `bun run test:backend` (if backend changed)
- [ ] `bun run test:agent-server` (if agent-server changed)
- [ ] `cargo test` (if Rust changed)
- [ ] Visual verification (if UI changed)

## Changes
[Brief description of key changes by file/area]
EOF
)"
```

Base branch: $ARGUMENTS (default: main)
