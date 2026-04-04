---
name: deus-code-style
description: "Deus Machine internal code style and conventions. Use when writing, reviewing, or modifying code in this project. Covers Tailwind v4, component patterns, animations, and performance. Triggers on: writing code, styling, components, CSS, tailwind, shadcn, animation, performance, database query, polling, rendering, zustand, react query."
---

# Deus Code Style

Internal conventions for writing code in the Deus Machine codebase.

## Quick Reference

| Topic | Guide | When to use |
|---|---|---|
| [Tailwind & Styling](tailwind.md) | Tailwind v4 gotchas, global CSS rules, color system | Writing any CSS or styling |
| [Components](components.md) | Shadcn, file locations, architecture patterns | Creating or modifying UI components |
| [Animations](animations.md) | Easing defaults, CSS vs Framer Motion, performance | Adding motion or transitions |
| [Performance](performance.md) | DB rules, polling, rendering, git subprocess | Backend queries, frontend lists, data fetching |

## Core Conventions

### ts-pattern for Discriminated Unions

Use `ts-pattern` instead of switch/case or if/else chains on `.type`, `.status`, `.state` fields:

```tsx
import { match, P } from "ts-pattern";

return match(block)
  .with({ type: "text" }, (b) => <TextBlock block={b} />)
  .with({ type: "tool_use" }, (b) => <ToolUseBlock block={b} />)
  .exhaustive(); // catches missing cases at compile time
```

- `.exhaustive()` — all cases must be handled
- `.otherwise()` — intentional fallback for open-ended matching

### State Management Split

- **Zustand** — UI state only (modals, selections, layout, sidebar)
- **TanStack Query v5** — Server state (workspaces, sessions, repos, messages, settings)

Feature hooks: `src/features/{feature}/api/{feature}.queries.ts` and `.service.ts`. Never put server data in Zustand.

### File Organization

```text
src/features/{feature}/ui/    # Feature-scoped components (default)
src/shared/components/         # Cross-feature reusable compositions
src/components/ui/             # Shadcn base primitives (edit freely)
src/platform/                  # Platform abstraction (Electron IPC, socket)
```

Default to feature-scoped. Only promote to `shared/` when a second feature needs it.

### Git Diff Semantics

- Branch resolution always prefers **remote** (`origin/{branch}`) over local — never change to local-first
- Diffs use git CLI against **working directory** (committed + staged + unstaged) — `diff_tree_to_tree` would miss uncommitted changes
- All git calls use `spawn()` with timeouts (5s short ops, 15s diffs)
