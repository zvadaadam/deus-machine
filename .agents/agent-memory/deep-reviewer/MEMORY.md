# Deep Reviewer Memory

## Browser Automation Architecture

- Inject scripts live in `src/features/browser/automation/inject/` (TypeScript source)
- Compiled via esbuild to `dist-inject/` (IIFE format, gitignored)
- Consumer files import compiled output via Vite `?raw` imports
- Three independent scripts: `browser-utils` (`__deusBrowserUtils`), `visual-effects` (`__deusVisuals`), `inspect-mode` (`__deusInspect`)
- Title-channel protocol uses `\x01` (SOH) prefix bytes -- verify hex dump, not text grep
- Build command: `bun run build:inject` (runs before dev/build)

## Common Patterns to Watch

- `waitForDomSettle` timer cleanup: ensure all timers are cleared on all exit paths
- Dead parameters: `slowly` in `buildTypeJs` is accepted but never used
- `data-deus-ref` is used for both tree snapshots and inspect mode element refs

## WebSocket Query Protocol Architecture (Post-Migration)

- All data subscriptions (workspaces, stats, sessions, session, messages) now use WS q:subscribe/q:snapshot/q:delta
- HTTP queryFn remains as fallback for initial load before WS connects
- `staleTime: Infinity` on all WS-subscribed queries -- relies on WS for freshness
- `useQuerySubscription` now tracks `wsConnected` state via `onConnectionChange` and re-runs effect on connect (fixed)
- Workspace cache updated by: onMutate (optimistic), WS q:snapshot/q:delta, useWorkspaceInitEvents (IPC event for init progress)
- useGlobalSessionNotifications now observes React Query cache, not IPC events
- query-engine.ts now uses snake_case (has_older/has_newer) consistently (fixed)
- `q:mutate` / `q:mutate_result` protocol fully wired -- frontend uses `sendMutate` for some mutations (createSession, etc.)
- `sendCommand` and `onEvent` in WS client are exported and consumed (PTY commands use sendCommand, tool relay uses onEvent)

## Electron Desktop Layer (Post-Tauri Migration)

- Electron 35 in use; `BrowserView` deprecated since Electron 30 -- migration to `WebContentsView` needed
- Preload uses ESM (.mjs output) requiring `sandbox: false` -- this is expected
- Preload allowlist pattern: ALLOWED_INVOKE_CHANNELS + ALLOWED_EVENT_CHANNELS gate all IPC
- Duplicate ipcMain handlers exist (snake_case + native: prefix) for migration compat -- should be consolidated
- `browser:network-request` emitted by main process but no consumer or allowlist entry exists
- `browser:console-message` sent from browser preload but no ipcMain handler buffers it
- `clear_file_cache` and `invalidate_file_cache` in allowlist but no handler or caller
- No test coverage for apps/desktop/ (8 files, ~800 lines)
- Backend process management: exponential backoff restart, port-changed IPC to renderer, WS reconnect chain
- Agent-server spawned by backend (not Electron main), tracked in server.ts module scope

## Review Infrastructure

- Reviews go to `.context/reviews/review-NN.md`
- review-01: 2026-02-21, review-02: 2026-03-03 (session cache/event review), review-03: 2026-03-15 (WS query protocol migration), review-04: 2026-03-20 (Tauri-to-Electron migration pre-merge review), review-05: 2026-04-01 (Start New Project feature pre-merge), review-06: 2026-04-10 (AI-generated complexity reduction refactors -- APPROVED), review-07: 2026-04-11 (Message system deep audit -- REQUEST_CHANGES), review-08: 2026-04-11 (Unified Parts transformation layer -- REQUEST_CHANGES)

## Recurring Patterns

- `useCreateWorkspace` mutationFn manually lists option fields instead of spreading -- any new field added to CreateWorkspaceParams type must ALSO be added to the mutationFn destructuring, otherwise it is silently dropped
- `workspace-init.service.ts` cleanup stages don't guard against isRootWorkspace -- any new init stage with cleanup must check ctx.isRootWorkspace to avoid deleting repo root
- Endpoint URL validation is inconsistent: /repos/clone has SAFE_GIT_URL_PATTERN but /repos/init does not -- always check new endpoints that accept URLs

## Message System Known Issues (review-07)

- `turn_id` column in messages table is indexed but never populated by any write path
- `context_token_count` and `context_used_percent` on sessions table are always 0 -- never updated
- `handleStopSession` in commands.ts races with agent event pipeline -- both write idle status
- `parseContent` (JSON.parse of message content string) is called 3-4x per message per render cycle -- memoization opportunity
- Optimistic messages use `seq: MAX_SAFE_INTEGER` which can break scroll restoration logic
- No Zod validation at the backend boundary for incoming agent events (only ts-pattern type matching)
- `EventBroadcaster.requireTunnel()` always picks first tunnel for RPC requests -- no session routing

## Unified Parts System (review-08, branch gnhf/i-would-love-to-impr-9017a3)

- Reference project: abuja-v2 at `/Users/zvada/conductor/workspaces/agnt/abuja-v2/`
- Parts types live in `shared/messages/types.ts`, factories in `apps/agent-server/messages/parts.ts`
- Three adapters: claude-adapter (streaming), codex-adapter (CLI begin/end), codex-sdk-adapter (ThreadEvent lifecycle)
- Dual-write: handlers emit `message.parts` + `message.parts_finished` alongside legacy events
- Backend accumulates via `PartsAccumulator` (Map<messageId, Map<partId, Part>>), flushes on `parts_finished`
- `persistMessagePartsFinished` targets "most recent assistant row by seq" -- no direct messageId correlation (known issue)
- Single messageId per query lifecycle (not per turn) -- diverges from reference, will need fixing for Parts-first rendering
- Frontend: `partsMap` (Map<string, MessagePartsEnvelope>) in SessionContext, parsed via `parseMessageParts()` with Zod validation
- `parts TEXT` column added to messages table via migration in `shared/schema.ts`
- `TerminalContent` in ToolOutputContent union is novel to chengdu-v3, not in reference, currently unused
- `prevText` map in codex-sdk-adapter is dead code (populated but never read)
