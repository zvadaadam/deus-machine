# Performance

The app manages tens of repos, hundreds of workspaces, and multiple concurrent agent sessions. Naive patterns compound at this scale.

## Database

- **Index every query pattern** — all indexes in `shared/schema.ts`. Add one for any new query.
- **No N+1** — never subquery per row. Use `sessions.last_user_message_at` directly. Batch or denormalize.
- **Paginate unbounded collections** — messages, file lists. Default 50-100 items.
- **Auto-update triggers** for `updated_at` columns.
- **Column deprecation** — rename with `DEPRECATED_` prefix, never drop.
- **PRAGMA optimize** on startup and graceful shutdown.

## Polling Discipline

- **WebSocket push over polling** — all data resources use WS subscriptions. Never poll data that has a subscription.
- **Budget:** <5 HTTP req/sec steady state. Only pollers: git diffs on working sessions (2-5s).
- **Gate polling on state** — don't poll idle workspaces.

| Frequency | What |
|---|---|
| 2-5s | Git diff hooks (only when session status = "working") |
| 30s+ / on-demand | Settings, repos, config, PR status |
| Never poll | Workspaces, stats, sessions, messages (WS push) |

## Frontend Rendering

- **Virtualize unbounded lists** — anything >30 items uses `@tanstack/react-virtual` (sidebar, messages, file tree)
- **Zustand selector discipline** — never destructure entire store. Always individual selectors:
  ```tsx
  // Bad: const { x, y } = useStore();
  // Good: const x = useStore((s) => s.x);
  ```
  Use `useShallow` for structurally-equal objects/arrays.
- **Memoize list items** — `React.memo()` on components in `.map()` loops
- **Batch queries** — use bulk endpoints (e.g. `useBulkDiffStats`), not per-item hooks

## Git + Subprocess

- Treat git calls as expensive — deduplicate aggressively
- Use bulk endpoints (one call per repo interval), not per-item hooks
- Cache diff results with short TTL (5-10s)
- Cap concurrent git subprocesses to prevent CPU spikes

## Read-Layer Priority

When optimizing, tackle in this order:
1. `GET /workspaces/by-repo` (heaviest — joins repos + workspaces + sessions)
2. `GET /stats` (consolidated count query)
3. `GET /sessions/:id`
4. `GET /sessions/:id/messages` (paginated, cursor-based)
5. On-demand reads (repos, settings, config, PR status)
