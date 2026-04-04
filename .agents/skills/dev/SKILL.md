---
name: dev
description: Implement a feature or fix using test-driven development. Use when you need methodical, step-by-step implementation with tests written first. Triggers on "implement", "build feature", "TDD", "write tests first".
context: fork
agent: dev
argument-hint: "[feature description or task]"
---

Implement the following using test-driven development:

$ARGUMENTS

## Context

Current git status and branch:
!`git status --short`
!`git branch --show-current`

Recent commits for style reference:
!`git log --oneline -5`

## Your task

1. Understand what needs to be built from the description above
2. Explore the relevant area of the codebase to understand existing patterns
3. Break the work into small testable increments
4. For each increment: write a failing test → make it pass → refactor
5. Run the full relevant test suite after all increments
6. Run `bun run typecheck` to verify no type errors
7. Provide a summary of what was implemented, tests added, and decisions made
