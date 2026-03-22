---
name: HTTP vs WS query parity gap
description: HTTP fallback routes for WS resources must be kept in sync with the query-engine implementation
type: feedback
---

The `GET /workspaces/by-repo` HTTP route and the `runQuery("workspaces", ...)` arm in query-engine.ts implement the same grouping logic independently. Fields added to one must be added to both.

**Why:** When the WS connection hasn't established yet, the frontend falls back to HTTP for initial data. Missing fields in the HTTP path cause UI state that depends on those fields (e.g., `repository.git_origin_url` for the GitHub picker button) to show incorrectly until WS connects and pushes a snapshot.

**How to apply:** Whenever a new field is added to the `RepoGroup` shape in the query engine's `runQuery("workspaces")` arm, also add it to:

1. `GET /workspaces/by-repo` route in `workspaces.ts` — both the workspace-grouped branch and the backfill (all-repos) branch.
2. Verify `AllRepositorySummaries` returns the field for the backfill branch.

Confirmed pattern: `git_origin_url` was added to query-engine but NOT to the HTTP route group object — missing from the HTTP fallback path.
