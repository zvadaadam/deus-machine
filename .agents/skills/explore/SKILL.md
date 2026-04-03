---
name: explore
description: Deep-dive into a feature area of the codebase. Traces the full stack from frontend to backend to database. Use when onboarding to an area, understanding a feature, or preparing to modify something.
context: fork
agent: Explore
argument-hint: "[feature area or question]"
---

Explore and explain the following area of the codebase:

$ARGUMENTS

## What to investigate

1. **Find the entry point**: Locate the frontend component, route handler, or Tauri command
2. **Trace the full stack**:
   - Frontend: component → query hook → service → HTTP/IPC call
   - Backend: route → middleware → service → database query
   - Agent-server: RPC handler → agent → SDK → canonical event → backend persists → frontend notification
   - Rust: command → core module → system call
3. **Map the data flow**: How does data move through the system?
4. **Identify the database tables**: Which tables and columns are involved?
5. **Note the state management**: What's in Zustand vs TanStack Query?
6. **Find the tests**: Where are the tests for this area?

## Architecture reference

```
Frontend (src/features/{feature}/)
├── api/{feature}.queries.ts    ← TanStack Query hooks
├── api/{feature}.service.ts    ← HTTP/IPC calls
├── ui/                         ← React components
└── store/                      ← Zustand (UI state only)

Backend (backend/src/)
├── routes/{feature}.ts         ← REST endpoints
├── services/{feature}.ts       ← Business logic
└── middleware/                  ← Request context

Agent-server (agent-server/)
├── agents/                     ← Agent handlers (stateless — no DB access)
├── event-broadcaster.ts        ← Canonical event emission → backend persists
└── rpc-connection.ts           ← JSON-RPC 2.0 transport to backend

Rust (src-tauri/src/)
├── commands/{feature}.rs       ← Tauri IPC handlers
└── {feature}.rs                ← Core logic
```

## Output format

Produce a clear explanation with:

- A brief overview of what this feature does
- The full data flow (ideally as a sequence)
- Key files and their responsibilities
- Database tables/queries involved
- Known patterns, gotchas, or technical debt
- Where tests live and what they cover
