# agent-ports — findings

A prototype package that reads sessions from other coding agents (Claude Code,
Codex, Cursor) into Deus's canonical message model (`shared/messages/types.ts`:
TEXT / REASONING / TOOL / COMPACTION parts, 4-state tool lifecycle). Same idea
as Cursor's internal `packages/claude-code-import`, but for all three sources.

Run the empirical probe against the real data on your machine (read-only; DB
copies go to `/tmp`):

```bash
bun packages/agent-ports/probe/run-probe.ts            # full parse
bun packages/agent-ports/probe/run-probe.ts --heads-only
```

## Architecture

Each provider exposes the same three-stage shape:

1. **`scan(opts)`** → `PortableSessionHead[]` — cheap listing via _head-parse only_
   (Claude/Codex read the first 64–128KB; Cursor reads header rows). Never reads
   whole transcripts. Produces stable `SessionIdentity {provider, cwd, sessionId}`
   for dedupe + idempotent re-sync.
2. **`fullParse(head)`** → `PortableSession` — full reconstruction into canonical
   messages/parts, ready to insert into `sessions`/`messages`/`parts`.
3. Stats on every parse: unmatched tool results, orphan calls, skipped record
   types, tool-name histogram, parse errors, throughput.

## Empirical results (this machine, 2026-08-12)

| Provider    | Sessions | Bytes   | Full-parse | Unmatched tools | Orphans | JSON errs |
| ----------- | -------- | ------- | ---------- | --------------- | ------- | --------- |
| Claude Code | 136      | 203 MB  | 0.4 s      | 0               | 0       | 0         |
| Codex       | 1230     | 1.57 GB | 3.9 s      | 0               | 3       | 0         |
| Cursor      | 43 / 617 | 35 MB   | 0.2 s      | 0               | 0       | 0         |

Throughput ~400–580 MB/s streamed. Reconstructing a full 200MB history is
sub-second; this can run synchronously on import with no worker.

### Claude Code — highest fidelity, resumable

- Files: `~/.claude/projects/<cwd-slug>/<sessionId>.jsonl`.
- 7,652 messages / 6,622 tool calls recovered with **zero** unmatched results.
- tool_use↔tool_result pairing by id; streamed assistant records regrouped by
  `message.id`; `isCompactSummary` → COMPACTION; subagent (`isSidechain`) records
  linked to their `Task` tool call by prompt-matching.
- Self-test reconstructs the _current_ Deus conversation from its transcript.
- **Resume advantage:** Deus runs the real Claude SDK, so `agent_session_id` +
  matching cwd = native resume — Cursor can only fork.

### Codex — excellent, broadest capture

- Files: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`. No per-project dirs, so
  scan by date + filter on `session_meta.cwd`.
- Captures **every** Codex surface: `codex_exec`, `codex_sdk_ts`, `codex-tui`,
  `Codex Desktop`, `codex_vscode`, and Deus's own `agent-server` rollouts.
- Durable content is in `response_item` (message / reasoning / function_call /
  function_call_output / local_shell_call / web_search_call). `event_msg` is
  ephemeral UI telemetry — skipped (145k `token_count`, 31k `agent_message`…);
  worth mining later only for token usage.
- `compacted` records → COMPACTION (663 seen).

### Cursor — recoverable for real conversations, best-effort overall

Storage: `…/globalStorage/state.vscdb` (SQLite). Three eras coexist:

- **inline** — `composerData.conversation[]` (ancient).
- **bubbles** — `composerData.fullConversationHeadersOnly[]` + `bubbleId:<c>:<id>`
  rows (readable JSON: text, `thinking`, `toolFormerData`).
- **blob** (modern glass) — `conversationState` = `~` + base64 protobuf listing
  32-byte SHA256 refs into `agentKv:blob:<hash>`. **The blobs are plaintext
  AI-SDK JSON** (`{role, content:[{type:'text'|'reasoning'|'redacted-reasoning'|
'tool-call'|'tool-result'…}]}`) — fully recoverable, not opaque. `blobRefs()`
  varint-parses the protobuf; `mapBlobMessage()` maps the blocks.

What we actually recovered: 43 composers, 4,396 messages, 2,152 tool calls, 0
errors. Of Cursor's 126 real headers, **all 12 named conversations recovered**;
the other ~574 `composerData` rows are unused draft stubs (New Chat, never used)
— correctly classified `empty`.

## Limitations found (the point of the exercise)

1. **Cursor cwd is partial** — only 316/617 composers map to a folder (via
   `workspaceStorage/<hash>/{workspace.json, state.vscdb}`). The rest import
   "unassigned" and can't auto-attach to a Deus workspace.
2. **Cursor format churn** — `_v` spans 10→17, undocumented, changes per release.
   Bubble/blob schemas can shift; the port needs era-versioned tolerance and will
   need maintenance. Treat Cursor as best-effort, labeled as such in the UI.
3. **Cursor content is genuinely gone for some old chats** — Cursor keeps bubbles
   for real conversations across a wide date range (verified 2025-12 → 2026-06),
   but a stub-only header with no bubbles/blob means the body isn't local
   (server-side or GC'd). Unrecoverable by any file reader.
4. **Cursor dual-format** — 9 conversations have BOTH bubbles and blobs; we take
   the bubble path (richer UI metadata). Fine, but a choice to be aware of.
5. **Slug-derivation bug (Cursor's own importer, avoided here)** — Cursor derives
   the Claude project dir as `cwd.replaceAll("/", "-")`, but Claude Code also
   escapes `.` and `_`. 8/136 local sessions (every `.conductor/` and `.deus/`
   worktree) would be silently missed. **We match on the `cwd` field parsed from
   the transcript instead of deriving the slug**, dodging this entirely.
6. **Codex assistant turns are coarse** — we start a new assistant message only at
   a user turn, so one assistant "message" can accrue hundreds of tool parts.
   Structurally valid (parts belong to the turn) but may want turn-splitting on
   `turn_context` for nicer rendering.
7. **Codex token usage dropped** — `event_msg:token_count` (145k records) is
   skipped; a production port should fold these into `sessions.context_token_count`.
8. **Live DB safety** — never open Cursor's `state.vscdb` in place; copy it (+WAL
   sidecar) first, as the probe does. Claude/Codex JSONL are safe to stream.

## Mapping to Deus (production shape, not built here)

- Backend scanner service (backend owns the DB) → new WS resource
  `importable_sessions` for the picker (head-parse only). Full-parse on open.
- Insert into existing `sessions`/`messages`/`parts`; set `agent_harness`,
  `agent_session_id`, stable identity for idempotent re-sync (mtime-keyed).
- Unknown tools already round-trip as generic TOOL parts (kind `other`/`mcp`).
- Continue = fork via the existing chat-promotion machinery (`pending_primer` +
  context-bridge handoff) OR, for Claude with matching cwd, real SDK resume.

## Update: full app integration (same branch, 2026-08-13)

The ports are now wired into Deus end-to-end and e2e-verified in `dev:web`:

- **Shared contract**: `importable_sessions` resource + `importExternalSession`
  command (`shared/events.ts`), DTOs in `shared/types/session-import.ts`,
  `sessions.origin_key` column (+index) for idempotent dedupe.
- **Backend**: `apps/backend/src/services/session-import.service.ts` — cached
  scanner (30s TTL, rescan kicked from runQuery, snapshot pushed via
  invalidate), cwd→repo/workspace matching (`agent-ports/src/match.ts`),
  deus-owned session exclusion (originator + worktree-path checks), transaction
  insert into sessions/messages/parts as canonical Part JSON (tool payloads
  capped at 16KB), sets `workspaces.current_session_id` so the import is
  immediately visible. Runs under Node+tsx; the Cursor provider auto-selects
  bun:sqlite / better-sqlite3 / node:sqlite (`agent-ports/src/sqlite.ts`).
- **Frontend**: home-screen banner (`HomeView`) → `ImportSessionsModal`
  (grouped by matched project, provider icons, per-row Import with
  imported-state), `useImportableSessions` subscription hook, uiStore modal
  state, wired through MainLayout/MainContent.
- **E2E (browser-verified)**: scan of 283 real sessions grouped into 68
  projects; "matched project" badge appears for repos known to Deus (groups
  sort matched-first); imported Claude Code and Cursor sessions render in the
  native chat UI including turn summaries ("6 messages · 2 subagents · 7 tool
  calls"), reasoning parts, and markdown. 655 backend tests + typecheck green.

Gaps found while testing (deliberate v1 scope):

1. Modal rescan happens on subscribe only — reopening refreshes; an open modal
   doesn't see newly added repos (add a refresh button later).
2. No session-history UI exists in the workspace view, so imports rely on the
   `current_session_id` fallback to be visible; a proper session list/picker
   is the right long-term home.
3. Toast "Open" action can expire before it's clicked (sonner default TTL).
4. Session titles for wrapper-prefixed prompts (`<system_instruction>…`) fall
   back to a generic label; smarter preamble-stripping would help.

## Update: import modal v2 (2026-08-13, afternoon)

Per Adam's feedback on the long flat list:

- Provider filter chips (Claude Code / Codex / Cursor) with counts — deselect
  to hide a provider; last active chip can't be deselected (resets to all).
- Project groups are **collapsed by default**; header shows name, match badge,
  cwd, session count, and a per-group "Import N" bulk button.
- Footer: totals + "Import all (N)" running sequential imports with i/N
  progress; failures collected into one summary toast. Idempotent backend
  (origin_key) makes bulk safe to re-run.
- Verified live: chip filtering (283 → 163 sessions with Codex off), group
  bulk import of 9 echo-backend sessions (incl. 961- and 601-message Cursor
  conversations) in ~2s, footer/count live updates via snapshot push.
- Env note: parallel Conductor workspaces run their own Vite on 1420+ — always
  read the "Local:" port from your own dev output, never assume, and never
  pkill by pattern (kills sibling workspaces' dev servers).
