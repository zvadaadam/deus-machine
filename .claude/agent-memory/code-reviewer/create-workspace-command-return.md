---
name: createWorkspace command return value pre-existing bug
description: workspace.id is undefined after createWorkspace mutation because the command ack only returns commandId, not a full Workspace object
type: project
---

`WorkspaceService.create()` returns `result as unknown as Workspace`, but `result` is actually `{ accepted: boolean; commandId?: string; error?: string }` — the WS command ack shape. The callsite does `workspace.id` which reads `.id` on that object (undefined). `selectWorkspace(undefined)` ends up being called, which no-ops.

**Why:** This is pre-existing (since the protocol unification in bad96ad4). The workspace still appears in the sidebar because the WS subscription pushes a snapshot after DB creation. The auto-select feature is effectively broken but not visibly so since workspace creation also opens the first workspace via the subscription.

**How to apply:** Flag if any new code adds callsites of `workspace.id` after `createWorkspaceMutation.mutateAsync()` expecting a real workspace object. The fix would be to return the workspace from the command ack (add it to the `q:command_ack` payload in query-engine.ts) or use a q:response pattern instead.
