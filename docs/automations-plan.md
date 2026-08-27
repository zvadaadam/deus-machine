# Automations — design & build plan

_Drafted 2026-08-27. Exploration: AGNT platform (branch `zvadaadam/automations-crud-sdk-audit`,
automations landed in agnt #148), ChatGPT desktop app bundle (the `automation_update` tool +
local scheduler, read out of app.asar), Cursor app bundle (trigger/action protobuf enums read
out of workbench JS), and this repo's session/cloud seams. Design boards: `design/deus.pen`
`46a`–`46d` + references on `46x`._

## DECIDED 2026-08-27: cloud-only (supersedes the two-lane plan below)

The local lane was built (scheduler + runner + turn.ended settle, all green), then
**removed the same day** in favor of cloud-only — one system, one scheduler, the true
"fires with the Mac closed" promise. The agnt automations API is live in production
(verified: `api.deusmachine.ai/automations` → 401 auth-gated) and the pinned
`@deus-hq/sdk` 1.2.0 ships the full surface, so deus consumes instead of building:

- **The platform is the source of truth.** agnt schedules (Automation DO: alarms,
  jitter, sweeper), executes (sandbox runs from the repo's derived environment),
  settles, derives the failure streak and auto-pauses. Deus never schedules.
- **Deus mirrors into a cache** (`automations` + `automation_runs` in SQLite — the WS
  query layer stays synchronous). Sync: boot + credentials-arrival
  (`services/automations/service.ts initAutomations`), view mount/focus, after every
  mutation, and a 10s scoped poll while a run is live in the detail view.
  `services/automations/platform.ts` is the SDK boundary; the wire→row mapping keeps
  the deus-local columns (created_by, adopted workspace) across upserts.
- **Naming**: the platform `name` is org-unique/immutable, so deus stores a derived
  slug there and keeps the display name in the mutable `description`.
- **Repo link**: spec.environment = `repo-<slug>-<hash8>` (derived both sides);
  create lazily provisions a minimal named environment (base image + repo clone)
  when the agent-authored one doesn't exist yet. Repos need a git remote.
- **Runs open via adoption** (`openAutomationRun`): run → agnt session →
  `getSession()` → find-or-create deus workspace (`provider_workspace_id`) +
  session (`provider_session_id`) rows, attach the live channel, and **backfill
  the transcript** from `SessionDetail.messages` — the platform stores the
  engine vocabulary, so it's a row copy (`backfillSessionTranscript`,
  INSERT OR IGNORE, idempotent; an adopted-but-empty session heals on reopen).
  E2E-verified 2026-08-27 against the local platform + a real E2B run: prompt,
  thinking, tool call and final answer all render after adoption. The general
  reconnect path (driver `session.snapshot` also carries `messages` and today
  only reads `status`) is the follow-up that would extend the same heal to
  every cloud session.
- **Model**: automation runs are Claude sandboxes today (the platform dispatch
  carries model, not harness) — the editor offers claude-code models only.
- Known platform-side limit: env-scoped GitHub App tokens are 1-hour mints refreshed
  by desktop paths; server-side fires rely on the org PAT / public repos until agnt
  grows re-mint-on-provision (recorded in the cloud plan).

The two-lane design below is kept as the exploration record; its local-scheduler
sections describe code that no longer exists.

---

## What an automation is

**A prompt on a schedule, aimed at a repo, that produces normal workspaces and sessions.**
"Review new PRs every morning." "Nightly dependency audit." The run is a real agent session —
it shows up in the sidebar, has a transcript, diffs, maybe a PR. Nothing about the run is a
new kind of thing; only the _trigger_ is new.

Two execution lanes, one concept:

|           | **Local**                                      | **Cloud**                                          |
| --------- | ---------------------------------------------- | -------------------------------------------------- |
| Runs on   | this Mac, while Deus is open                   | agnt sandboxes, Mac can be closed                  |
| Scheduler | new: deus backend interval loop                | **shipped**: agnt Automation DO (alarms + sweeper) |
| Store     | deus SQLite (`automations`, `automation_runs`) | agnt Postgres (same-named tables), deus caches     |
| Requires  | nothing                                        | Deus Cloud sign-in (device key, D1)                |

ChatGPT ships exactly this split (device vs. cloud scheduled tasks, with a quit-warning
"Scheduled tasks won't run while the app is closed"); Cursor is cloud-only. We get the cloud
lane nearly free because the platform primitive already exists.

## What AGNT already ships (verified, agnt #148)

- Tables `automations` + `automation_runs` (Postgres). Spec is a JSON blob:
  `{triggers: [{type:"cron", cron, timezone} | {type:"webhook"}], prompt, environment,
model?, thinkingLevel?, mcpServers?, sessionPolicy: "fresh_session"|"same_session",
overlapPolicy: "skip"|"queue", delivery?: {webhook}}`.
- One **Durable Object per automation**: alarm-driven fires with deterministic per-automation
  jitter (120 s window), ≥5-min interval floor, missed ticks dropped not backfilled, a 15-min
  cron sweeper as backstop, 30/90-day run retention.
- Runs: `queued|running|succeeded|failed|skipped`, idempotency keys, overlap skip/queue,
  settle push from the AgentSession + a 2-min reconciler, cancel-then-grace timeout,
  **auto-pause after 5 consecutive failures** (streak derived, never stored; resume of an
  auto-pause forgives, resume of a manual pause doesn't).
- **Held runtime**: an automation reuses ONE platform workspace across runs
  (`workspace_id`/`session_id`/`generation` on the row); `fresh_session` mints a new session
  per run with `sessionId === runId === turnId` (deterministic recovery); `same_session` is
  the heartbeat shape (one long-lived session).
- Runs execute with `permissionMode: "bypassPermissions"`, trigger payload fenced into the
  prompt preamble.
- API `/automations/*` (CRUD + trigger + runs + webhook-key rotation), **`agnt_sk_*` keys
  only** — the per-device key Deus mints at D1 sign-in is exactly this. Full
  `@deus-hq/sdk` surface: `createAutomation … listAutomationRuns` (cron+timezone sugar).
- Delivery: signed outbound webhook per terminal run (incl. `skipped`). No email/push.
- **No product UI** (dashboard has none; only the SDK playground) and **no agent-facing tool**
  to create automations — both are ours to build.
- Max 10 automations/org (soft), webhook trigger type shipped, GitHub/Slack/Linear triggers
  designed as future spec-union members but not built.

## What ChatGPT/Cursor teach us (read out of their bundles)

- ChatGPT's model tool is ONE tool, `automation_update`, mode-discriminated:
  `view|create|suggested_create|update|suggested_update|delete`. `suggested_*` renders a
  review card instead of committing — the escape hatch for anything anchored/ambiguous.
  Guardrails in the schema descriptions: never show raw schedule strings to the user; prompt
  describes ONLY the task ("schedule, workspace, thread details are provided separately");
  prefer updating an existing automation over creating a duplicate; mute = a notification
  policy (`failed_runs_only`), never prompt text.
- ChatGPT's two kinds map 1:1 onto agnt's `sessionPolicy`: _heartbeat_ (default; follow-ups
  in the same thread) = `same_session`; _cron_ (standalone runs against a project) =
  `fresh_session`. Their scheduler is a 60 s unref'd interval over `nextRunAt`, exactly the
  shape our local lane needs; on boot it "settles interrupted runs".
- Cursor: cron trigger = 5-field cron + IANA timezone (same as agnt); trigger enum also has
  webhook/Slack/GitHub/Linear/PagerDuty/Sentry (matches agnt's planned union); automations
  are org/team-scoped with a template gallery. Their editor anatomy: title · active toggle ·
  repo picker · Triggers · Agent Instructions (with model picker) · Tools · Run History.

**Schedule format decision: 5-field cron + IANA timezone** (agnt-compatible, croner on both
sides). The UI and the agent tool are the translation layers — presets ("Every morning at
9:00", weekday pickers) and model intent → cron; raw cron shown only under "Custom".

## Deus-side model

### Schema (append to `SCHEMA_SQL`, pre-launch rules apply)

```sql
automations (
  id TEXT PK,                    -- uuid7
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  cron TEXT NOT NULL, timezone TEXT,
  lane TEXT NOT NULL DEFAULT 'local',            -- 'local' | 'cloud'
  status TEXT NOT NULL DEFAULT 'active',         -- 'active' | 'paused'
  paused_reason TEXT,                            -- 'manual' | 'auto_failures'
  session_policy TEXT NOT NULL DEFAULT 'fresh_session',
  model TEXT, agent_harness TEXT NOT NULL DEFAULT 'claude-code',
  notification_policy TEXT NOT NULL DEFAULT 'all',   -- 'all' | 'failures_only'
  workspace_id TEXT,                             -- held workspace (one per automation)
  provider_automation_id TEXT,                   -- cloud lane: agnt automation id
  next_run_at TEXT, last_run_at TEXT,
  created_by TEXT NOT NULL DEFAULT 'user',       -- 'user' | 'agent'
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)
automation_runs (
  id TEXT PK,                    -- uuid7 (= agnt run id on cloud)
  automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  status TEXT NOT NULL,          -- 'running' | 'succeeded' | 'failed' | 'skipped'
  trigger TEXT NOT NULL DEFAULT 'cron',          -- 'cron' | 'manual'
  session_id TEXT, workspace_id TEXT,
  started_at TEXT, completed_at TEXT,
  stop_reason TEXT, error_message TEXT, cost REAL, summary TEXT
)
```

The SQLite rows are a **cache** of the agnt ledger (refreshed on subscribe/focus and after
mutations); the platform is the source of truth (see the cloud-only decision below). One
workspace per automation (held, like agnt); sessions follow the policy — `fresh_session`
creates one per run, `same_session` reuses one across runs. The workspace row carries the
automation's name and sits under its repo in the sidebar; runs open as session tabs inside
it. Notifications come free: `useGlobalSessionNotifications` already fires on those
sessions' status transitions.

### Local scheduler (new, small)

`services/automation/scheduler.ts`, started from `server.ts onListening()` beside
`startLocalServerDiscovery()`, stopped in `shutdown()`:

- 60 s `setInterval` (`.unref()`); each tick: `SELECT … WHERE status='active' AND lane='local'
AND next_run_at <= now`.
- `croner` computes next occurrences (same lib as agnt). Fire-time math from the _scheduled_
  time, not `now`; missed fires while the app was closed are **dropped, then rescheduled** —
  never backfilled (agnt + ChatGPT both).
- On boot: settle interrupted `running` rows (mark `failed` with "interrupted"), recompute
  `next_run_at` for every active local automation.
- Enforce agnt's floor locally too: ≥5-min interval (validated at save).

### Local runner

`services/automation/runner.ts` — composition, no new machinery:

1. Ensure the held workspace exists and is `ready` (create via the existing local
   workspace-create path on first run; worktree reused thereafter).
2. `createSession` on it (fresh_session) or reuse `current_session_id` (same_session).
3. Insert `automation_runs` row, mint `turnId`, `agentService.startTurn(...)` with the
   automation prompt behind a short preamble (name, run id, trigger, last-run — mirroring
   agnt's `buildRunPrompt`).
4. Settle from the existing turn-end seam (`event-handler` already knows `turn.ended` +
   stop reason): update the run row, `last_run_at`, failure streak → auto-pause at 5,
   `invalidate(["automations", "automation_runs"])`.
5. Overlap: `skip` — if the automation's previous run is still `running`, insert a
   `skipped` row and return.

### Cloud lane (consume, don't build)

- Create/update/pause/resume/delete/trigger → `@deus-hq/sdk` with the device key
  (`getCloudConfig()`); `environment` = the repo-derived name `repo-<slug>-<hash8>` when the
  agent-authored environment exists, else the inline recipe path already used by
  `createCloudWorkspace`. Store `provider_automation_id`.
- Runs: `listAutomationRuns` → upsert the cache; opening a run adopts it through its
  SESSION — `getSession(provider_session_id)` yields the platform `workspaceId`, and deus
  finds-or-creates the workspace row (`provider_workspace_id`) and session row
  (`provider_session_id`) from that, so transcripts open in the normal UI.
- No cloud sign-in → lane disabled in UI with the same nudge Settings → Cloud uses.
- v1 keeps polling (subscribe/focus refresh); the agnt delivery **webhook → deus-cloud →
  push** channel is the later real-time path. Webhook _triggers_ (agnt has them) surface in
  the UI as a later "Advanced" trigger type.

### WS protocol (the `apps`/`running_apps` pattern, verbatim)

- `QUERY_RESOURCES += "automations"`, `"automation_runs"` (runs param'd by automationId).
- `MUTATION_NAMES += "saveAutomation" | "deleteAutomation" | "toggleAutomation"`.
- `COMMAND_NAMES += "runAutomationNow"`.
- The four `.exhaustive()` matches light up every required arm; service calls
  `invalidate(["automations"])` after every write and every settle.

### Agent tool ("just tell the agent to schedule it")

The `deus` in-process MCP server grows an `automations.ts` tool family (the ChatGPT shape,
adapted):

- **One tool, `automation_update`**, modes `view|create|update|delete|list` — as SHIPPED,
  create takes `{name, prompt, cron, timezone?, sessionPolicy?, model?}` and update
  additionally takes `status` (pause/resume); there is no `lane` (cloud-only), no
  `notificationPolicy`, no `repositoryId` on update (the repo rides the environment and is
  immutable per automation), and no `status` on create (born active). Repo defaults to the
  calling session's repo (resolved from `sessionId` backend-side, the AAP doctrine — the
  agent never guesses ids).
- Wire: `SIDE_CHANNEL += deus/automation/*` → `rpc-schemas` → `HostRpc` →
  `TOOL_REQUEST_METHODS` → an `automation/` branch in `handleToolRequest` **before** the
  relay fallthrough → the same service the mutations use. One service, two callers.
- Tool description carries the ChatGPT guardrails: never show raw cron to the user; prompt is
  the task only; prefer update over duplicate; mute = notification policy.
- The chat renders the result as an **automation card** (new tool renderer, archetype G):
  name · humanized schedule · lane chip · repo · View / Pause. Deliberate v1 simplification
  vs ChatGPT: direct create + a prominent card (undo = pause/delete on the card), no
  suggested\_\* approval mode yet.
- Cloud sandbox agents can't call `deus/*` (no side channel there). Later, agnt grows a
  sidecar MCP tool (`agnt_create_automation`) next to `agnt_configure_environment` — that is
  the one **AGNT-repo work item** this feature eventually wants; v1 needs nothing from agnt.

### Surfaces (designed on `46a`–`46d`)

- **Entry**: sidebar footer row "Automations" (zap glyph, 32 px rhythm, beside Add project) +
  a ⌘K command. The view fills the main area like Home; the app sidebar stays.
- **`46a` list**: title + "New automation"; All/Active/Paused chips + search; rows = status
  glyph · name · "Daily at 9:00 · Next run in 2 h" · repo · lane chip · last-run dot ·
  overflow. Suggestions row beneath (Deus-flavored templates: PR review sweep, nightly
  audit, changelog draft).
- **`46b` create/edit dialog**: prompt-first textarea, name, repository select, schedule
  (preset repeat · time · custom cron reveal), Runs-on segmented (Cloud / This Mac + honesty
  copy "runs only while Deus is open"), per-run policy (fresh vs continue), model,
  notifications. Footer Cancel / Create.
- **`46c` detail**: header (name, Active switch, schedule line, repo, lane) · Run history
  rows (status · started · duration · cost · summary → opens the run's session) · auto-pause
  banner ("Paused after 5 failed runs — Resume") · Run now.
- **`46d` chat cards**: the `automation_update` tool row + created-card, and the run-session
  provenance chip ("⚡ Nightly audit · run #12 · scheduled") shown at the top of automation
  transcripts.

## Build order

1. **Backend local lane** — schema, service (CRUD + validation), scheduler, runner, settle,
   WS resources/mutations/command. Tests: scheduler tick math, settle/auto-pause, runner
   composition (mock agentService).
2. **Frontend** — `features/automations/` (list view + dialog + detail per the boards),
   sidebar entry, ⌘K command, unread/toast on run completion.
3. **Agent tool** — side-channel family + deus-tools + card renderer.
4. **Cloud lane** — SDK proxy + run adoption + lane toggle in the dialog (needs a signed-in
   device; feature-detect via `getCloudConfig()`).
5. **Later / agnt-side**: sidecar `agnt_create_automation` tool, delivery-webhook push
   channel, webhook/GitHub/Slack triggers in the UI, templates gallery.
