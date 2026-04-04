---
name: debug
description: Debug a failing test, error, or unexpected behavior. Analyzes the error, traces root cause through the codebase, and suggests or applies a fix. Use when something is broken.
argument-hint: "[error message, test name, or file path]"
---

Debug the following issue:

$ARGUMENTS

## Context

Recent test output (if relevant):
!`cat /tmp/test-output.log 2>/dev/null || echo "No recent test output captured"`

Current git status:
!`git diff --stat`

## Process

1. **Understand the error**: Parse the error message or test failure output
2. **Locate the source**: Find the failing test or error origin in the codebase
3. **Trace the code path**: Follow the execution from the error back to the root cause
4. **Check common causes**:
   - Import path wrong after file move?
   - Mock setup missing or outdated? (check `vi.mock()` and `vi.hoisted()` patterns)
   - Database schema mismatch between backend and agent-server?
   - Tauri IPC command name mismatch between Rust and frontend?
   - Event name mismatch between emitter and listener?
   - Missing index causing slow/failing query?
   - Type error from stale interface after refactor?
5. **Form hypothesis**: State what you think the root cause is
6. **Verify**: Read surrounding code to confirm
7. **Fix**: Apply the minimal fix
8. **Verify fix**: Run the specific failing test to confirm it passes
9. **Run broader tests**: Run the full test suite for the affected layer

## Architecture-aware debugging

| Error location     | Common causes                                                      |
| ------------------ | ------------------------------------------------------------------ |
| Backend route test | Mock not matching actual DB schema, missing `vi.mock()`            |
| Agent-server test  | `vi.hoisted()` needed for mock variables, Claude SDK mock stale    |
| Frontend           | TanStack Query key mismatch, Zustand selector returning stale data |
| Rust               | Borrow checker, missing `Clone`/`Send`, libgit2 path issues        |
| Cross-layer        | Event name typo, IPC command name mismatch, socket message format  |
