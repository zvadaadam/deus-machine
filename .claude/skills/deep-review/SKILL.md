---
name: deep-review
description: Perform a thorough code review with written findings saved to .context/reviews/. Produces structured review documents with iteration tracking. Use for pre-merge audits or when you need actionable written feedback. Triggers on "deep review", "thorough review", "audit", "pre-merge review".
context: fork
agent: deep-reviewer
argument-hint: "[branch or --staged]"
---

Perform a thorough code review and write findings to `.context/reviews/`.

## Scope

Determine what to review from the arguments:
- No arguments: review all changes on current branch vs main (`git diff main...HEAD`)
- A branch name: review changes vs that branch
- `--staged`: review only staged changes

## Context

Current branch and recent changes:
!`git branch --show-current`
!`git log --oneline main..HEAD 2>/dev/null || echo "No commits ahead of main"`
!`git diff --stat main...HEAD 2>/dev/null || git diff --stat`

Previous reviews:
!`ls .context/reviews/review-*.md 2>/dev/null || echo "No previous reviews"`

## Your task

1. Read every changed file thoroughly
2. Check against the full review checklist (security, performance, architecture, conventions)
3. Trace code paths end-to-end to verify they actually work
4. Write a structured review document to `.context/reviews/review-NN.md`
5. Output the verdict and key findings summary

$ARGUMENTS
