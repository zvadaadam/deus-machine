# Workspace Status — Feature Specification & Implementation Guide

> **Context**: This document describes a new `status` column for workspaces that tracks workflow phase (backlog, in-progress, in-review, done, canceled). It was designed on the `seville-v2` branch which uses Tauri + React + Node.js backend + stateless agent-server sidecar. If the app has migrated to Electron, the Tauri-specific parts (IPC, Rust commands) won't apply, but the **data model, backend logic, protocol, and frontend state management are fully portable** since they live in TypeScript (shared/, backend/, src/).

---

## 1. Why We're Doing This

Today we have two status dimensions:

| Concern | Column | Values |
|---------|--------|--------|
| **Lifecycle** | `workspace.state` | `initializing`, `ready`, `archived`, `error` |
| **Agent activity** | `session.status` | `idle`, `working`, `error`, `needs_response`, `needs_plan_response` |

Both are about *what's happening right now*. Neither answers the question a user actually cares about: **"What stage is this work in?"**

A user managing 20+ parallel workspaces needs to see at a glance:
- Which workspaces are parked for later (backlog)
- Which are actively being worked on (in-progress)
- Which have PRs out for review (in-review)
- Which are done (done)
- Which were abandoned (canceled)

This is the same mental model as Linear issue states. OpenDevs (the desktop app we run inside) already shipped this as `derived_status` + `manual_status` — two columns. We're doing it with **one column** and smarter rules.

### Why One Column, Not Two

OpenDevs uses `manual_status` (user override, nullable) + `derived_status` (auto-computed). The effective status is `manual_status ?? derived_status`. The problem: once the user overrides, the system doesn't know when to resume auto-deriving. The two realities diverge silently.

Our approach: **single `status` column** with **sticky vs flow** semantics. Some states resist auto-updates (sticky), others welcome auto-progression (flow). No ghost state, no ambiguity about which column to read.

---

## 2. Data Model

### New Column: `workspaces.status`

```sql
status TEXT NOT NULL DEFAULT 'in-progress'
```

### Status Values

```
backlog → in-progress → in-review → done
                                     canceled
```

| Status | Type | Meaning | Auto-derive behavior |
|--------|------|---------|---------------------|
| `backlog` | **Sticky** | Parked for later | Only user can move it out |
| `in-progress` | **Flow** | Active work (default) | Auto-progresses to `in-review` when PR created |
| `in-review` | **Flow** | PR is open | Auto-progresses to `done` when PR merged |
| `done` | **Terminal** | Work is complete | Auto-set on PR merge or archive |
| `canceled` | **Sticky** | Abandoned | Only user can move it out |

### Sticky vs Flow Rules

**Sticky states** (`backlog`, `canceled`) resist system auto-progression. The user intentionally parked the workspace. Only explicit user action (or archiving, which is definitive) can change them.

**Flow states** (`in-progress`, `in-review`) welcome auto-progression. When a signal arrives (PR created, PR merged), the system moves the workspace forward.

**Terminal state** (`done`) is the end of the flow. Can be set by system (PR merge, archive) or user.

**Archive override**: Archiving a workspace *always* forces `done`, even from sticky states. Archive is a definitive lifecycle event.

### Relationship to Existing Columns

```
state          "initializing" | "ready" | "archived" | "error"
               └─ Is the git worktree usable? (lifecycle)

status         "backlog" | "in-progress" | "in-review" | "done" | "canceled"
               └─ What stage is the work in? (workflow) — NEW

session_status "idle" | "working" | "error" | "needs_response" | "needs_plan_response"
               └─ Is the agent busy right now? (activity, per-session)
```

All three are **orthogonal**. A workspace can be:
- `state=ready` + `status=in-review` + `session_status=working` → agent doing follow-up on an open PR
- `state=ready` + `status=backlog` + `session_status=idle` → parked, no activity
- `state=archived` + `status=done` + `session_status=idle` → completed and archived

### PR URL Persistence

Currently `pr_url` and `pr_number` columns exist in the schema but are **never written** — PR status is fetched on-demand from `gh CLI`. For auto-derive to work, we need to persist `pr_url`/`pr_number` when the frontend fetches PR status and a PR is found. This gives us a reliable DB signal for `in-progress → in-review` transitions.

**Important**: We should NOT make `pr_url` the single source of truth for "has a PR". The `gh CLI` on-demand check remains the authoritative source for detailed PR state (CI, reviews, conflicts). The persisted `pr_url` is just a flag for auto-derive — "at some point, a PR was created for this workspace."

---

## 3. Auto-Derive Rules (Complete Table)

| # | Trigger Event | Where It Fires | Condition | Status Transition |
|---|--------------|----------------|-----------|-------------------|
| 1 | Workspace created | `POST /workspaces` INSERT | Always | → `in-progress` (DB default) |
| 2 | PR detected | When `pr_url` is persisted (see §4.5) | Status is flow state AND not already `in-review`/`done` | `in-progress` → `in-review` |
| 3 | PR merged | When PR status returns `merged` (see §4.5) | Status is flow state | `in-review` → `done` |
| 4 | Workspace archived | `archiveWorkspace` mutation or `PATCH` | **Always (forced)** — archive is definitive | any → `done` |
| 5 | Workspace unarchived | `PATCH /workspaces/:id` with `state=ready` | Status is `done` (set by archive) | `done` → `in-progress` |
| 6 | User manual set | `updateWorkspaceStatus` mutation | **Always** — user intent overrides all | any → any |

### What Does NOT Trigger Auto-Derive

- **Agent session events** (session.started, session.idle, session.error): These are per-session activity signals. A workspace can have multiple sessions. The agent starting/stopping doesn't change the workflow phase.
- **Message events**: New messages don't affect workflow status.
- **Setup status changes**: Dependency install completing is a lifecycle concern, not workflow.

---

## 4. Implementation — File by File

### 4.1 Schema & Types (shared/)

**`shared/enums.ts`** — Add the enum and constants:

```typescript
// ── Workspace Status (workflow phase) ────────────────────────────────
/** Linear-style workflow states for workspaces. */
export const WorkspaceStatusSchema = z.enum([
  "backlog",
  "in-progress",
  "in-review",
  "done",
  "canceled",
]);
export type WorkspaceStatus = z.infer<typeof WorkspaceStatusSchema>;

/** Sticky states resist auto-progression. Only user action (or archive) can exit. */
export const STICKY_STATUSES: ReadonlySet<WorkspaceStatus> = new Set(["backlog", "canceled"]);

/** Ordered progression for preventing regression (in-review won't go back to in-progress). */
export const STATUS_ORDER: readonly WorkspaceStatus[] = [
  "backlog", "in-progress", "in-review", "done", "canceled"
];
```

**`shared/types/workspace.ts`** — Add field to `Workspace` interface:

```typescript
import type { WorkspaceStatus } from "../enums";

export interface Workspace {
  // ... all existing fields stay unchanged ...
  status: WorkspaceStatus;  // NEW — workflow phase
}
```

**`shared/schema.ts`** — Add column to CREATE TABLE + index + migration:

In the `workspaces` CREATE TABLE (for fresh installs):
```sql
status TEXT NOT NULL DEFAULT 'in-progress',
```

New index:
```sql
CREATE INDEX IF NOT EXISTS idx_workspaces_status ON workspaces(status);
```

In the MIGRATIONS array (for existing databases):
```typescript
export const MIGRATIONS: string[] = [
  `ALTER TABLE sessions ADD COLUMN error_category TEXT`,
  // NEW: workspace workflow status
  `ALTER TABLE workspaces ADD COLUMN status TEXT NOT NULL DEFAULT 'in-progress'`,
];
```

**`shared/events.ts`** — Add mutation name:

```typescript
export const MUTATION_NAMES = [
  "archiveWorkspace",
  "updateWorkspaceTitle",
  "updateWorkspaceStatus",  // NEW
] as const;
```

### 4.2 Backend DB Layer (backend/src/db/)

**`backend/src/db/types.ts`** — Add `status` to both row types:

```typescript
export interface WorkspaceRow {
  // ... existing fields ...
  status: string;  // NEW
}

export interface WorkspaceWithDetailsRow {
  // ... existing fields ...
  status: string;  // NEW (from workspaces table, not session)
}
```

**`backend/src/db/queries.ts`** — Add `w.status` to ALL workspace SELECT statements:

In `WORKSPACE_DETAILS_SELECT` (the canonical SELECT):
```sql
SELECT
  w.id, w.repository_id, w.slug, w.title, w.git_branch,
  w.git_target_branch, w.state, w.status,  -- ADD w.status
  w.current_session_id,
  w.pr_url, w.pr_number,
  -- ... rest unchanged ...
```

In `getWorkspacesByRepo` (has its own inline SELECT):
```sql
SELECT
  w.id, w.repository_id, w.slug, w.title, w.git_branch,
  w.git_target_branch, w.state, w.status,  -- ADD w.status
  w.current_session_id,
  w.pr_url, w.pr_number,
  -- ... rest unchanged ...
```

In `getWorkspacesBySessionIds` (if it has its own SELECT, same treatment).

In `getStats()` — add status breakdown counts:
```sql
(SELECT COUNT(*) FROM workspaces WHERE status = 'in-progress' AND state != 'archived') as workspaces_in_progress,
(SELECT COUNT(*) FROM workspaces WHERE status = 'in-review' AND state != 'archived') as workspaces_in_review,
(SELECT COUNT(*) FROM workspaces WHERE status = 'backlog' AND state != 'archived') as workspaces_backlog,
```

Update `StatsRow` type accordingly.

Add a **backfill function** for existing databases (called once after migration):
```typescript
export function backfillWorkspaceStatus(db: Database.Database): void {
  // Archived with commits → done (work was completed)
  db.prepare(`
    UPDATE workspaces SET status = 'done'
    WHERE state = 'archived' AND archive_commit IS NOT NULL AND status = 'in-progress'
  `).run();
  // Archived without commits → canceled (abandoned)
  db.prepare(`
    UPDATE workspaces SET status = 'canceled'
    WHERE state = 'archived' AND archive_commit IS NULL AND status = 'in-progress'
  `).run();
  // Has PR URL → in-review (if still active)
  db.prepare(`
    UPDATE workspaces SET status = 'in-review'
    WHERE pr_url IS NOT NULL AND state = 'ready' AND status = 'in-progress'
  `).run();
}
```

### 4.3 Backend Service: Auto-Progression Logic

**NEW FILE: `backend/src/services/workspace-status.service.ts`** (~40 lines)

This is the core logic. Two functions, one file, no external dependencies beyond DB and enums.

```typescript
import { STICKY_STATUSES, STATUS_ORDER, type WorkspaceStatus } from "@shared/enums";
import { getDatabase } from "../lib/database";
import { getWorkspaceRaw } from "../db";

/**
 * Auto-progress a workspace's workflow status.
 *
 * Rules:
 * - Sticky states (backlog, canceled) resist auto-progression unless forced
 * - Won't regress (in-review won't go back to in-progress)
 * - Force mode (used by archive) overrides both guards
 *
 * IMPORTANT: Does NOT call invalidate(). The caller is responsible for
 * invalidation after its own DB writes. This prevents double WS pushes.
 */
export function autoProgressStatus(
  workspaceId: string,
  target: WorkspaceStatus,
  opts: { force?: boolean } = {},
): void {
  const db = getDatabase();
  const ws = getWorkspaceRaw(db, workspaceId);
  if (!ws) return;

  const current = ws.status as WorkspaceStatus;

  // Sticky states resist auto-progression unless forced (e.g., archive)
  if (!opts.force && STICKY_STATUSES.has(current)) return;

  // Don't regress in the flow (in-review → in-progress is wrong)
  if (!opts.force) {
    const currentIdx = STATUS_ORDER.indexOf(current);
    const targetIdx = STATUS_ORDER.indexOf(target);
    if (targetIdx <= currentIdx) return;
  }

  db.prepare("UPDATE workspaces SET status = ? WHERE id = ?").run(target, workspaceId);
}

/**
 * Explicitly set workspace status (user override). No sticky/flow guards.
 * Used by the updateWorkspaceStatus mutation.
 */
export function setWorkspaceStatus(workspaceId: string, status: WorkspaceStatus): void {
  const db = getDatabase();
  db.prepare("UPDATE workspaces SET status = ? WHERE id = ?").run(status, workspaceId);
}
```

**Critical design decision**: `autoProgressStatus` does NOT call `invalidate()`. Every call site already calls `invalidate()` after its own DB writes. If autoProgressStatus also called it, subscribers would get two pushes per event. The caller is responsible for invalidation.

### 4.4 Backend Routes & Mutations

**`backend/src/lib/schemas.ts`** — Update PatchWorkspaceBody:

```typescript
import { WorkspaceStateSchema, WorkspaceStatusSchema } from "@shared/enums";

export const PatchWorkspaceBody = z.object({
  state: WorkspaceStateSchema.optional(),
  status: WorkspaceStatusSchema.optional(),  // NEW — manual status override
});
```

**`backend/src/routes/workspaces.ts`** — Hook auto-derive into PATCH:

```typescript
import { autoProgressStatus, setWorkspaceStatus } from '../services/workspace-status.service';

app.patch('/workspaces/:id', async (c) => {
  const db = getDatabase();
  const { state, status } = parseBody(PatchWorkspaceBody, await c.req.json());
  const id = c.req.param('id');

  // Manual status override (user action via PATCH)
  if (status) {
    setWorkspaceStatus(id, status);
  }

  if (state) {
    db.prepare('UPDATE workspaces SET state = ? WHERE id = ?').run(state, id);

    if (state === 'archived') {
      autoProgressStatus(id, 'done', { force: true });
      // ... existing archive lifecycle hook (unchanged) ...
    }

    if (state === 'ready') {
      // Unarchive: if status was set to 'done' by archive, restore to in-progress
      const ws = getWorkspaceRaw(db, id);
      if (ws?.status === 'done') {
        autoProgressStatus(id, 'in-progress', { force: true });
      }
    }
  }

  const updated = getWorkspaceRaw(db, id);
  invalidate(['workspaces', 'sessions', 'stats']);
  return c.json(updated);
});
```

**`backend/src/services/query-engine.ts`** — Add `updateWorkspaceStatus` mutation to `runMutation()`:

```typescript
.with("updateWorkspaceStatus", () => {
  const workspaceId = readStringParam(params, "workspaceId");
  const status = readStringParam(params, "status");
  if (!workspaceId || !status) {
    throw new Error("updateWorkspaceStatus requires workspaceId and status");
  }
  setWorkspaceStatus(workspaceId, status as WorkspaceStatus);
  invalidate(["workspaces", "stats"]);
  return { success: true };
})
```

Also update the existing `archiveWorkspace` mutation:

```typescript
.with("archiveWorkspace", () => {
  // ... existing archive logic (db.prepare, invalidate) ...
  autoProgressStatus(workspaceId, 'done', { force: true });
  invalidate(["workspaces", "stats"]);
  return { success: true };
})
```

### 4.5 PR URL Persistence & Auto-Derive Trigger

Currently `pr_url`/`pr_number` are in the schema but never written. We need to persist them when the frontend fetches PR status and a PR is found.

**Option A (recommended): Backend persists on PR status fetch**

In `backend/src/routes/workspaces.pr.ts`, after getting PR status from `gh CLI`, persist the URL:

```typescript
app.get('/workspaces/:id/pr-status', withWorkspace, async (c) => {
  const workspace = c.get('workspace');
  const workspacePath = c.get('workspacePath');
  const result = await getPrStatus(workspacePath);

  // Persist PR URL when we first discover a PR (enables auto-derive)
  if (result.has_pr && result.pr_url && result.pr_url !== workspace.pr_url) {
    const db = getDatabase();
    db.prepare('UPDATE workspaces SET pr_url = ?, pr_number = ? WHERE id = ?')
      .run(result.pr_url, result.pr_number ?? null, workspace.id);
    autoProgressStatus(workspace.id, 'in-review');
    invalidate(['workspaces', 'stats']);
  }

  // Auto-derive done on merge
  if (result.merge_status === 'merged' && workspace.status !== 'done') {
    autoProgressStatus(workspace.id, 'done');
    invalidate(['workspaces', 'stats']);
  }

  return c.json(result);
});
```

This is clean because:
- PR status is already fetched on-demand by the frontend (5s polling while session is working)
- We just add a side-effect to persist the URL and trigger auto-derive
- No new polling, no webhooks, no new endpoints

### 4.6 Database Initialization

**`backend/src/lib/database.ts`** — Call backfill after migrations:

```typescript
import { backfillWorkspaceStatus } from '../db/queries';

// After running MIGRATIONS loop:
try {
  backfillWorkspaceStatus(db);
} catch {
  // Backfill is idempotent (WHERE status = 'in-progress') — safe to run repeatedly
}
```

### 4.7 Frontend Types & Status Config

**`src/features/sidebar/lib/status.ts`** — Add workflow status config (alongside existing DisplayStatus):

```typescript
import type { WorkspaceStatus } from "@shared/enums";

/**
 * Visual configuration for Linear-style workflow status.
 * Rendered as a small icon to the left of the workspace title.
 * Separate from DisplayStatus which shows real-time agent activity.
 */
export const WORKFLOW_STATUS_CONFIG: Record<WorkspaceStatus, {
  label: string;
  color: string;
  iconColor: string;
}> = {
  "backlog":     { label: "Backlog",     color: "text-muted-foreground", iconColor: "text-muted-foreground" },
  "in-progress": { label: "In Progress", color: "text-amber-500",       iconColor: "text-amber-500" },
  "in-review":   { label: "In Review",   color: "text-purple-500",      iconColor: "text-purple-500" },
  "done":        { label: "Done",        color: "text-green-500",       iconColor: "text-green-500" },
  "canceled":    { label: "Canceled",    color: "text-muted-foreground", iconColor: "text-muted-foreground" },
};
```

**No changes to `getDisplayStatus()`** — it stays focused on agent activity (idle/working/error/unread). The new workflow status is a separate visual element rendered in a different position.

### 4.8 Frontend Mutation Hook

```typescript
// In workspace queries/mutations file
export function useUpdateWorkspaceStatus() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ workspaceId, status }: { workspaceId: string; status: WorkspaceStatus }) =>
      apiClient.patch(`/api/workspaces/${workspaceId}`, { status }),
    onSuccess: () => {
      // WS subscription handles cache updates, but invalidate as fallback
      queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.all });
    },
  });
}
```

Alternatively, this can use the WebSocket mutation protocol once `sendMutation` is wired:
```typescript
sendMutation("updateWorkspaceStatus", { workspaceId, status })
```

### 4.9 Frontend UI (WorkspaceItem)

The sidebar `WorkspaceItem` component needs a small status icon (Linear-style circle variants) rendered to the left of the workspace title. Clicking the icon opens a dropdown to change status manually.

**Icon mapping** (using Lucide icons or custom SVGs):
- `backlog` → hollow circle (○)
- `in-progress` → half-filled circle (◐) — yellow/amber
- `in-review` → filled circle (●) — purple
- `done` → checkmark circle (✓) — green
- `canceled` → x circle (✕) — gray

This is UI/design work that depends on the specific component library and design system in use.

---

## 5. What We're NOT Doing

1. **No two-column split** — No `manual_status` + `derived_status`. Single `status` column with sticky/flow semantics.
2. **No agent event handler changes** — Session lifecycle events (session.started, session.idle) don't trigger workflow status changes. Agent activity ≠ workflow phase.
3. **No new WebSocket event types** — Status flows through existing `q:snapshot`/`q:delta` workspace subscription pushes.
4. **No new Tauri/Electron events** — Data flows through the WS protocol.
5. **No sidecar changes** — The sidecar is stateless and doesn't know about workflow status.
6. **No separate status polling** — PR status is already fetched on-demand; we just add a persist side-effect.
7. **No GitHub webhooks** — Auto-derive is triggered by the existing PR status fetch path.

---

## 6. What OpenDevs Does (Reference)

For context, here's how OpenDevs (the production app we run inside) implements this:

**Database columns:**
- `derived_status TEXT DEFAULT 'in-progress'` — auto-computed
- `manual_status TEXT` — nullable user override
- `pr_title TEXT`, `pr_description TEXT` — PR draft metadata (no `pr_url`)
- `archive_commit TEXT` — hash of last commit when archived

**Values observed in production (687 workspaces):**
- `derived_status`: `in-progress` (492), `done` (181), `in-review` (14)
- `manual_status`: `NULL` (671), `backlog` (10), `in-progress` (1), `canceled` (1)

**Inferred heuristics:**
- PR title set → `derived_status = 'in-review'`
- Archived with `archive_commit` → `derived_status = 'done'`
- Default → `derived_status = 'in-progress'`
- Effective status = `manual_status ?? derived_status`

**Why we're doing it differently:**
- Two columns creates ghost state (derived keeps computing while ignored)
- `COALESCE(manual_status, derived_status)` is confusing in queries
- No clear rule for when to clear `manual_status` after override
- Our sticky/flow model is simpler and handles the same cases

---

## 7. Migration Notes (Tauri → Electron)

If the app has migrated from Tauri to Electron:

**Fully portable (no changes needed):**
- `shared/` — All types, enums, schema, events (pure TypeScript)
- `backend/` — All routes, services, DB queries, query engine (Node.js)
- `src/features/`, `src/shared/` — React components, hooks, state management
- WebSocket query protocol — Transport-agnostic

**May need adaptation:**
- `src-tauri/` → Not applicable in Electron. Git operations and file scanning that were in Rust would need equivalent implementations.
- Process lifecycle — How the backend and sidecar are started/managed would differ.
- Database path — `~/Library/Application Support/com.opendevs.app/opendevs.db` may be different.

**The workspace status feature does not touch any Tauri-specific code.** All changes are in shared/, backend/, and src/ — fully portable.

---

## 8. Complete File Manifest

| # | File | Action | Estimated Lines | Description |
|---|------|--------|----------------|-------------|
| 1 | `shared/enums.ts` | Edit | +15 | Add `WorkspaceStatusSchema`, `STICKY_STATUSES`, `STATUS_ORDER` |
| 2 | `shared/types/workspace.ts` | Edit | +2 | Add `status: WorkspaceStatus` to `Workspace` interface |
| 3 | `shared/schema.ts` | Edit | +4 | Add column to CREATE TABLE + index + migration entry |
| 4 | `shared/events.ts` | Edit | +1 | Add `"updateWorkspaceStatus"` to `MUTATION_NAMES` |
| 5 | `backend/src/db/types.ts` | Edit | +2 | Add `status: string` to `WorkspaceRow` and `WorkspaceWithDetailsRow` |
| 6 | `backend/src/db/queries.ts` | Edit | +20 | Add `w.status` to all SELECTs + stats counts + backfill function |
| 7 | `backend/src/lib/schemas.ts` | Edit | +2 | Add `status` to `PatchWorkspaceBody` |
| 8 | `backend/src/lib/database.ts` | Edit | +5 | Call backfill after migrations |
| 9 | `backend/src/services/workspace-status.service.ts` | **New** | ~45 | `autoProgressStatus()` + `setWorkspaceStatus()` |
| 10 | `backend/src/routes/workspaces.ts` | Edit | +15 | Hook auto-derive into PATCH (archive, unarchive, manual) |
| 11 | `backend/src/routes/workspaces.pr.ts` | Edit | +12 | Persist `pr_url` + trigger auto-derive on PR discovery/merge |
| 12 | `backend/src/services/query-engine.ts` | Edit | +12 | Add `updateWorkspaceStatus` mutation + archive hook |
| 13 | `src/features/sidebar/lib/status.ts` | Edit | +15 | Add `WORKFLOW_STATUS_CONFIG` |
| 14 | `src/features/workspace/api/*.ts` | Edit | +12 | Add `useUpdateWorkspaceStatus` hook |
| 15 | `src/features/sidebar/ui/WorkspaceItem.tsx` | Edit | ~20 | Render status icon + dropdown |

**Total: ~180 lines across 15 files (1 new, 14 edits)**

---

## 9. Testing Strategy

**Backend unit tests:**
- `workspace-status.service.test.ts` — Test autoProgressStatus with all combinations:
  - Flow state + valid progression → updates
  - Flow state + regression → no-op
  - Sticky state + auto-progress → no-op
  - Sticky state + forced → updates
  - Non-existent workspace → no-op
- Test setWorkspaceStatus always writes regardless of current state

**Integration tests:**
- Archive mutation sets status to `done`
- Unarchive restores `done` → `in-progress`
- PR discovery sets `in-progress` → `in-review`
- PR merge sets `in-review` → `done`
- Manual override from any state to any state

**Frontend:**
- Verify `WORKFLOW_STATUS_CONFIG` covers all `WorkspaceStatus` values
- Mutation hook sends correct payload
- Status icon renders for each status value
