# Cloud Workspaces — design & build plan

_Settled 2026-08-18. Sprint 1 + 1.5 shipped on `zvadaadam/cloud-workspaces-phase1`
(PR #310). This is the durable copy of the plan; the exploration history that
produced it (Conductor/t3code/Cursor teardowns, the sync-engine debate) lived in
the session's `.context/` and is summarized here where it drives a decision._

## The model

**A cloud workspace is a branch that is always pushed, with a restore point
every turn, and — on desktop, later — a local folder that mirrors it on
demand.** Git carries everything durable; the session WebSocket carries
everything live; there is exactly one writer at any moment. Deus's existing
fold/persistence/UI consume cloud sessions unchanged because agnt emits the
same `@zvada/agent-server` protocol deus speaks natively.

Prior-art triangulation (all verified by direct inspection): Cursor's cloud
agents, Conductor, and t3code all run a daemon in the VM and move results as
git; none use an off-the-shelf file-sync library; hidden-git-ref checkpoints
appear in all three. Byte-level working-tree sync (mutagen-style) was evaluated
and rejected: it doesn't move git history, re-imports conflict/transport
lifecycle problems, and breaks the Mac-off story.

## Layering rule (which repo owns what)

- **agnt platform (`apps/backend`, `@deus-hq/sdk`) — general, integrator-neutral.**
  Sandboxes, sessions, secrets, the git-auth step that _consumes_ a token,
  diffs/checkpoints channels. Nothing deus-specific; any product could build on
  it. Closed source.
- **deus-cloud (`apps/deus-cloud`) — the deus product layer.** Identity (WorkOS),
  per-user orgs, API-key minting, and the **GitHub App** (install callback,
  installation↔org mapping, token minting). Policy and identity live here.
  Closed source.
- **deus-machine (this repo) — open source.** Holds no secrets: the cloud driver,
  UI, and public identifiers only (app slug, OAuth client id, backend URLs).
  Anything that could mint or decrypt for other users must stay server-side.

## What is shipped (Sprint 1 + 1.5, PR #310)

- Schema: `workspaces.kind` (`worktree`|`cloud`) + `provider_workspace_id`,
  `sessions.provider_session_id`; `resolveWorkspaceTarget()` at the
  workspace-loader chokepoint.
- Cloud create pipeline (row now, agnt workspace+session in background,
  `workspace.state` → `init_stage`); ssh→https origin normalization.
- Cloud session driver: one raw session socket per cloud session; engine
  lifecycle frames feed the same fold as local (synthetic per-session seq,
  deus session id); platform frames become effects (workspace row, error
  mapping, AskUserQuestion relay, permission auto-allow, snapshot gap-heal).
  Client turnId passthrough (AGNT #142) keeps optimistic-bubble ↔ echo
  correlation intact.
- Changes panel via the live diff channel (`diff.request` SUMMARY/FILE over the
  session socket; routes branch on kind; paused sandbox = empty shape).
- Lifecycle: archive stops the sandbox; sidebar cloud icon is a liveness dot
  (green online / dimmed asleep, driver mirrors agnt state into `init_stage`)
  with click-to-wake (`POST /workspaces/:id/cloud-wake`); sends auto-wake.
- UI: Home composer is the creation surface (repo+branch left, Cloud switch
  off-by-default right); sidebar "+" opens the prompt-first modal (composer in
  a modal, repo preselected, prompt rides as turn one); cloud icons in sidebar/
  recents/header; Files tab shows an honest placeholder for cloud.
- Settings → Cloud: connection + key status, GitHub **PAT** field (stored as
  the org `github_token` secret on the platform; private repos work end to end).
- Config v1 is env-driven (`DEUS_CLOUD_AGNT_URL`, `DEUS_CLOUD_AGNT_API_KEY`,
  BYOK `ANTHROPIC_API_KEY`) — replaced by D1.
- Tests: 741 backend incl. a 10-case driver contract suite; e2e proof drives
  the real REST+`q:` surface against a live sandbox (create → provision →
  chat → echo-matches-turnId → diff routes serve an agent-written file).

### Also shipped (post-review hardening, same PR)

- **Environment story in the chat** (`cloud:env`): the driver passes
  `workspace.state` through as an ephemeral `q:event`; the chat splices the
  events into the timeline chronologically (compaction-marker mechanism) as a
  collapsed, tool-call-style group — live step spinning, expandable checklist,
  sticky like transcript history, gone on refresh. Contract:
  `CloudEnvStateSchema` in `shared/events.ts` is deliberately LOOSE (open
  status set, unknown fields pass through) with a contract test pinning the
  superset + tolerant-reader properties against the pinned `@deus-hq/api`.
- **Asleep/wake truth**: opening a cloud workspace attaches the session
  channel (DO-side, never wakes the VM); the connect snapshot's session
  status syncs paused/stopped/provisioning into the row AND the chat.
  `wakeCloudWorkspaceWithFeedback` (service layer) reads platform status
  first: paused → optimistic "resuming" + resume (honest revert on failure);
  stopped → no doomed resume, "send a message to restart it" (agnt's resume
  API only accepts PAUSED; message-send re-provisions). One presence
  vocabulary (`cloudPresence`: awake/asleep/waking) drives the sidebar icon
  and the header chip (dashed "Asleep" click-to-wake / spinning "Waking").
- **Sessions**: new chat tabs lazily create the agnt twin on first cloud
  contact (deus session id = client-supplied id, retry-safe). Codex is
  REJECTED up front for cloud — the sidecar pins the claude-code harness and
  never installs the Codex SDK — with lane validation ordered BEFORE any
  state write (harness persist, working flip) so a rejection touches nothing.
- **Model passthrough**: the composer's pick rides `message.send`
  options.model (the sidecar honors it); socket hardening (handshake + ready
  deadlines); shared composer controls (`ModelPicker`/`CloudToggle`/
  `BranchPickerButton`) used by HomeView and the prompt-first modal.

## Work packages

### D1 — Deus Cloud auth handshake (next)

Desktop: route the existing WorkOS PKCE token (deus-cloud-auth.ts, currently
consumed by nothing) to the backend → `POST /auth/desktop/exchange` (already
deployed; `"deus-machine-desktop"` already whitelisted in the JWT schema) →
first login auto-creates the org → mint a **per-device** agnt API key
(`POST /dashboard/api-keys`; label = hostname, revocable) → keychain. Replaces
the env vars; unlocks production `api.deusmachine.ai`.

### D1.5 — GitHub App (bundled with D1; same identity plumbing)

Two options side by side in Settings (Conductor's model): **Deus GitHub App
(recommended)** and PAT (shipped, stays as fallback).

- Register the App (Contents R/W, Metadata R; webhook → deus-cloud). Public
  identifiers may live in this repo; the **private key never leaves deus-cloud**
  (an OSS desktop binary cannot hold a key that mints tokens for every
  installation).
- deus-cloud: install callback, `installations` table (installation_id ↔ org),
  mint endpoint (App JWT → 1h installation token), service-to-service auth to
  agnt via the existing shared JWT_SECRET pattern.
- agnt `git-auth`: accept a _fetched_ token (mint per provision/resume) in
  addition to the stored-secret path. Nothing long-lived is stored.
- Later refinement: a git credential helper in the sandbox that calls
  sidecar → backend → deus-cloud for a fresh token on demand, so >1h-old
  workspaces never push with expired credentials.

### Sprint 2 — durability rails (agnt-heavy)

Universal git mirror for every deus cloud workspace (managed mirror remote even
for GitHub-sourced repos); rolling-wip autosave (ONE amended commit at the tip,
force-push-with-lease **only to the agnt mirror**, paused while a PR is open);
hidden checkpoint refs (`refs/agnt/checkpoints/<turnId>`, invisible to GitHub)
pushed at turn end; size guard (~25MB/file, event + .gitignore suggestions);
tiered GC (20 turns / daily 30d / pinned); `turn.ended.gitSync` gains
`checkpoint: pushed|pending|skipped`.

### Sprint 3 — the handoffs (deus-heavy)

One fetch+checkout primitive → per-turn **Restore** (checkout checkpoint + gray
reverted turns + one systemPromptAppend note — no native-session surgery),
**Open files** (materialize), **Send to cloud** (local edits as a `{patch,
baseCheckpoint}` entry in agnt's execute queue — serialized with turns, `git
apply --3way`, conflicts surfaced scoped), **Continue locally / Send back**
(kind flip; the home moves, never syncs). Committed content then serves diffs
from local objects (latency win); the opt-in folder auto-mirror later is this
primitive + a timer.

### Sprint 4 — the reach

Web/phone direct-to-agnt mode (deus SQLite becomes a projection of agnt PG for
cloud sessions — reconnect = snapshot diff by engine ids + idempotent upserts);
ACP-shaped `fs/*` + `terminal/*` on the sidecar (tmux-backed); `fs/list` file
tree; port forwarding for localhost previews.

### Codex in the cloud (agnt-side, whenever wanted)

Three parts, all mechanisms exist: unpin the sidecar's `HARNESS =
"claude-code"` (the `@zvada/agent-server` engine already ships the codex
adapter — mostly installing `@openai/codex-sdk` in the E2B template), thread
an OpenAI key through the same secret/turn-option plumbing as the Anthropic
key, and have deus pass `agent: "codex"` on session create (the API field
already exists). Until then deus rejects codex sends to cloud workspaces up
front with an honest message.

## Weakness register → resolutions

1. Restore semantics → files + grayed turns + prompt note (seam exists);
   engine `resumeSessionAt` rewind only if ever needed.
2. Rolling-wip vs shared remotes → wip/checkpoints only to the agnt mirror;
   GitHub gets intentional + PR-time pushes.
3. Multi-client edit races → sends-as-queued-patch (single writer by queue
   position, not by lock).
4. Checkpoint growth → size guard + tiered GC + honest push states.
5. Keys/spend → per-device scoped keys (D1); org daily spend cap enforced at
   turn admission (+80% warning); lower cloud maxTurns; invite-only until
   quotas exist.
6. Latency → committed content from locally fetched objects; prefetch on
   `diff.update`; `(checkpointSha, path)` cache for web.
7. Two-kind test tax → driver conformance suite (10 cases shipped), capability
   × kind table test (todo), deus CI cloud smoke via agnt `USE_MOCK_SANDBOX`.
8. Dual truth (phone phase) → agnt PG is sole truth for cloud sessions; deus
   SQLite written only from agnt-sourced events; set-union by engine id.

## Open decisions

- BYOK vs platform-billed Anthropic key for launch (BYOK shipped; agnt's
  turn-scoped proxy makes switching a config change).
- Idle-TTL default for IDE dwell (agnt-side; 5min is CI-tuned).
- Marketplace listing for the GitHub App vs private install link.
