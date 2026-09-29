# Project inspection tools — live-use follow-up

Root's live coordinator run could not locate contributor checkouts from `get_agent_status`, and `read_agent_transcript` produced empty assistant rows when messages contained only tools. The bounded service/contract change makes both useful for integration and diagnosis without changing execution or authorization.

- `apps/backend/src/services/projects/service.ts:454` adds each allowed Agent's `execution: { kind: "local", workspacePath, branch }`. A single workspace/repository query supplies backend metadata; path calculation reuses the existing `computeWorkspacePath` helper. The path and branch are reserved/configured references, not a new filesystem probe. Missing local paths return null.
- `service.ts:489` reads persisted text and tool parts. Tool names/states, bounded input (1,000 characters), and output/error (2,000) make tool-only messages useful. Reasoning remains excluded; messages with no text/tools are labeled. Each message is capped at 12,000 characters and the full page at 48,000, with explicit abbreviation markers.
- The transcript accepts `beforeMessageId`, validates it against the target's current session, then uses the existing indexed `messages.seq` ordering. `nextBeforeMessageId` points to the oldest included message when more remain. Page construction keeps whole message rows so the character limit does not skip older messages. Excerpts cannot be paged within a message; this is documented.
- `shared/projects.ts` has two tool response interfaces. `apps/agent-server/agents/deus-tools/projects.ts:62` documents the status reference and exposes the optional cursor. `docs/local-projects.md` records limits, cursor behavior, and access policy. No schema or frontend changes.

Authorization is unchanged: exact active source turn/current conversation checks run first, cross-Project targets reject, and contributors can only read their own transcript/status. Cursors copied from another conversation or a superseded target session reject.

Verification: 9 new tests in `apps/backend/test/unit/services/projects-tool-inspection.test.ts` pass, covering backend metadata, tool failures and running/pending/completed states, hidden reasoning, stable pagination under new arrivals, whole-message character caps, excerpt limits, foreign/stale cursors, source/target scope, and limit validation. Existing 16 boundary, 4 wire integration, and 3 MCP source tests pass. Backend typecheck and diff check pass. Wire tests use their isolated fixture and fake engine; no live app or model processes were started by this subtask.

Production files were reported final/safe to restart to root after focused validation. Root owns the live browser and final corrected-engine qualification.
