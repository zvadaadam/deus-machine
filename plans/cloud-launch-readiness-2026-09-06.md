# Cloud launch readiness — 2026-09-06

This is a review of the current system, not another review of the reliability PR diff.

**Verdict:** the reliability work was worth shipping. The architecture has sensible owners and the recovery path is substantially safer. I would continue internal use, but would not yet describe the whole cloud product as ready for unrelated customers. A focused desktop-first, Claude-first invited beta is a realistic next step after the blockers below. Open signup needs additional onboarding and resource controls.

Reviewed Deus `1766aa56d`, AGNT `47d98fdf`, the linked agent-server checkout, and the installed engine `0.3.2`. Engine core matches the linked upstream checkout. Findings refer to these versions. No source implementation, deployment, or paid-provider test was performed in this audit.

## What is already sound

The intended ownership split is worth keeping:

| Owner                            | Responsibility                                                               |
| -------------------------------- | ---------------------------------------------------------------------------- |
| Deus desktop main                | Native application and authentication integration                            |
| Deus local backend               | Product actions, local transcript projection, frontend subscriptions         |
| `deus-cloud` Worker              | Account/org policy and GitHub installation/token authority                   |
| AGNT Workspace Durable Object    | VM lifecycle, provisioning recipe, save barriers, recovery, resource cleanup |
| AGNT AgentSession Durable Object | Turn admission, canonical conversation and live session channel              |
| AGNT sidecar + agent-server      | Run the native harnesses and expose supported runtime tools                  |

Pause preserves a retained VM. Recreating a missing or stopped VM restores the saved Git work and archived native agent state. R2 is **not a complete disk or memory backup**: ignored files, local databases and other VM-only state are a different durability requirement. Cloud conversation storage and the desktop's local transcript are also separate projections; fixing native recovery does not automatically fix desktop history.

The previous rollout proved real Claude continuity through retained-VM pause/resume and replacement-VM Git/R2 recovery, including a failed-save case that preserved the VM. These are material improvements. Exact resource cleanup targets, explicit pause admission, cloud-owned GitHub renewal, credential exclusions, and ordered template/backend deployment should remain.

The [AGNT production release](https://github.com/zvadaadam/AGNT/actions/runs/34000569975) succeeded at the reviewed commit. Its pinned candidate is `agnt-base:47d98fd`. Deus #333 is merged and its post-merge CI passed, but the desktop release was not run. The latest published GitHub desktop release found during this audit remains [v0.3.8](https://github.com/zvadaadam/deus-machine/releases/tag/v0.3.8), published May 18. Merged source and a new public installer are separate milestones.

## Highest-priority findings

Effort: S = hours, M = roughly a day or two, L = several days or a separate project. These are planning sizes, not promises. Risk describes implementing the fix.

| ID  | Finding                                                                         | Gate                                                        | Effort / risk | Confidence                  |
| --- | ------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------- | --------------------------- |
| F1  | GitHub installation linking does not prove the caller controls the installation | Before unrelated customer onboarding                        | M / medium    | High, source-confirmed      |
| F2  | Session snapshots fail at 101 stored messages                                   | Before invited beta                                         | S / low       | High, reproduced in workerd |
| F3  | Desktop ignores cloud history accumulated while it was offline                  | Before promising cross-device continuity                    | L / medium    | High, source-confirmed      |
| F4  | Desktop error and device snapshot consumers use incorrect event shapes          | Before beta; device portion before device access            | S / low       | High, source-confirmed      |
| F5  | Successful turns hide failed Git saves in Deus                                  | Before unattended real work                                 | M / medium    | High, source-confirmed      |
| F6  | No atomic org-wide compute admission or durable usage settlement                | Cap before unattended beta; metering before paid/public use | M–L / medium  | High, source-confirmed      |
| F7  | Cloud setup has no complete required-secret entry/readiness workflow            | Before self-service arbitrary repositories                  | M–L / medium  | High, source-confirmed      |

### F1 — Close the GitHub installation ownership boundary

Implementation follow-up: [AGNT #188](https://github.com/zvadaadam/AGNT/pull/188)
is a draft fix with GitHub owner authorization, explicit destination consent,
and transactional Deus membership checks. The original bug was reproduced before
the fix. Validation includes 76 product-backend tests, real PostgreSQL concurrency
checks and browser confirmation against that database, with GitHub responses
provided by fixtures. Production still needs the App OAuth callback and Worker
client credentials configured, live GitHub qualification, and review of existing
links before this launch blocker can be marked closed.

[AGNT github.ts:164](https://github.com/zvadaadam/AGNT/blob/47d98fdfea8c40ba9c1365f2f37d0873f0835864/apps/deus-cloud/src/routes/github.ts#L164) verifies signed state for a Deus org and performs an App-authenticated installation existence lookup. It then links the installation to that org. It never verifies that the signed-in human is associated with that GitHub installation.

The global uniqueness constraint prevents reassignment of an already linked installation. It does not protect an unclaimed installation from being linked by the wrong Deus account. Downstream repository-token minting trusts that stored link. The file itself documents this gap at line 11, but its historical claim that only one org uses the deployment was not independently verified.

GitHub explicitly requires verifying the installation against a user access token in its [setup URL guidance](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-setup-url). Complete that user-authorization check before recording the association; bind it to the initiating Deus identity/org and recheck membership. Test two unrelated orgs, an unclaimed installation, wrong-user callback, replay, and legitimate repeat completion. This is a concrete authorization repair.

### F2 — Remove the snapshot query's parameter ceiling

[AGNT sql.ts:239](https://github.com/zvadaadam/AGNT/blob/47d98fdfea8c40ba9c1365f2f37d0873f0835864/apps/backend/src/agent-session/sql.ts#L239) loads every message and passes every ID into an `IN (...)` parts query. Each ID adds a SQL parameter. [Cloudflare limits these queries to 100 bound parameters](https://developers.cloudflare.com/durable-objects/platform/limits/).

The audit imported production `getParts`, captured its generated SQL, and ran it inside an in-memory SQLite Durable Object with installed Miniflare/workerd. 100 IDs succeeded; 101 produced `too many SQL variables … SQLITE_ERROR`.

Both REST snapshots and WebSocket reconnect use this path. Query session parts by their existing session ID or a join instead. Test a real Workers snapshot and reconnect with more than 100 messages. This is a small, high-value correction.

### F3 — Make reconnect restore the desktop transcript

[Deus driver.ts:430](https://github.com/zvadaadam/deus-machine/blob/1766aa56d5183f18526c83b18399b768924bd989/apps/backend/src/services/agent/cloud/driver.ts#L430) uses snapshots only to settle a turn the desktop already believes is live. With no live turn it returns. Snapshot messages and compactions are not imported. [query-engine.ts:437](https://github.com/zvadaadam/deus-machine/blob/1766aa56d5183f18526c83b18399b768924bd989/apps/backend/src/services/query-engine.ts#L437) still serves desktop messages from local SQLite.

The direct browser does reconstruct history from the cloud snapshot. Consequently desktop → backend closed → browser conversation → desktop produces different transcripts. This is missing product history, not proof of lost native agent context.

Add one idempotent reconciliation path for canonical messages, parts, compactions and terminal accounting. Preserve pending local admission and stable IDs; do not replay side effects or duplicate turns. Verify equality after offline browser work, a mid-turn network gap, repeated reconnect and account change. The existing direct-browser reconstruction and shared persistence model are references, not a reason to introduce another conversation protocol.

There is also an existing opt-in desktop direct lane (`deus.cloudDirect`; `SessionPanel.tsx:122`). Before committing to a large SQLite import, compare qualifying that lane as the default against completing the current backend projection, including search/export/retry/accounting consumers. Choose one cloud transcript read path. Flipping the flag alone does not prove those dependent features work; implementing both alternatives would add avoidable maintenance.

### F4 — Repair the two existing wire contracts

[AGNT's published snapshot schema](https://github.com/zvadaadam/AGNT/blob/47d98fdfea8c40ba9c1365f2f37d0873f0835864/packages/api/src/schemas/ws-events.ts#L145) puts simulator mirrors at the top level. [Deus driver.ts:385](https://github.com/zvadaadam/deus-machine/blob/1766aa56d5183f18526c83b18399b768924bd989/apps/backend/src/services/agent/cloud/driver.ts#L385) and the direct-session hook look inside `state`. If a known device changes while disconnected, reconnection can leave its old stream/status cached. The desktop's cold-start REST fallback limits the impact; not every restart fails.

Likewise, [the session error schema](https://github.com/zvadaadam/AGNT/blob/47d98fdfea8c40ba9c1365f2f37d0873f0835864/packages/api/src/schemas/ws-events.ts#L252) nests `code/message` under `error`, while Deus driver line 522 reads flat fields. A useful terminal cause can then be replaced by a generic cloud error.

Correct the field reads and test the real producer payload. Current cloud-driver fixtures reproduce the wrong nesting/flattening, which explains why green tests miss these defects. Preserve per-platform device reconciliation and error turn attribution.

### F5 — Show whether completed work was saved

AGNT [turn-lifecycle.ts:672](https://github.com/zvadaadam/AGNT/blob/47d98fdfea8c40ba9c1365f2f37d0873f0835864/apps/backend/src/agent-session/turn-lifecycle.ts#L672) emits `gitSync` independently of agent success. A targeted search found no consumer in Deus frontend/backend/shared source.

An agent can finish successfully while its Git save fails. The VM-preservation barrier is correct, but the user sees completion without an unsaved-work warning. Persist and display the acknowledged save outcome independently of turn status, including after reconnect. Keep a failed save visible until a later acknowledged save replaces it; expose a useful retry/recovery action.

The existing cloud plan already identifies the durability indicator and Recover work surface at [lines 415–429](https://github.com/zvadaadam/deus-machine/blob/1766aa56d5183f18526c83b18399b768924bd989/docs/cloud-workspaces-plan.md#L415). Complete that product layer without reopening the proven Git/R2 restore implementation.

### F6 — Bound cost at the organization boundary

[AGNT ensureWorkspace](https://github.com/zvadaadam/AGNT/blob/47d98fdfea8c40ba9c1365f2f37d0873f0835864/apps/backend/src/workspace/create-workspace.ts#L346) can admit many independent workspaces. Existing per-session queue and per-workspace device limits do not cap one organization's total compute.

Start with a small atomic reservation limit covering provisioning, active VMs, resume and disposal. A count followed by create is racy. Coordinate reservations with the existing lifecycle owner; do not introduce a general scheduling framework.

The [usage_records table](https://github.com/zvadaadam/AGNT/blob/47d98fdfea8c40ba9c1365f2f37d0873f0835864/packages/db/src/schema/pg/usage-records.ts#L5) has no runtime writer. Costs and tokens do survive in DO state/event history, so this is not total loss of usage data; it is missing org-level settlement and enforceable spending policy. Add idempotent turn settlement and compute intervals before charging or opening access. Stripe can follow the ledger.

Decide explicitly whether inference is BYOK or platform-funded. The sidecar still allows an ambient Anthropic key fallback; its actual production configuration was not inspected. Missing credentials should not silently choose a different payer.

### F7 — Finish setup for ordinary repositories

[CloudEnvironmentBlock.tsx:59](https://github.com/zvadaadam/deus-machine/blob/1766aa56d5183f18526c83b18399b768924bd989/apps/web/src/features/settings/ui/sections/CloudEnvironmentBlock.tsx#L59) calls a saved recipe configured and lists required environment names. The cloud agent tells users to provide these values in Settings, but that cloud-specific entry workflow is absent. The nearby local manifest editor does not provide it.

Add scoped secret entry and distinguish recipe saved, missing values, lookup unavailable, and setup verified. Preserve secret ownership and provide retry after configuration changes. Prepared repositories can support an assisted beta while this is built.

## Capabilities that must be described accurately

| Journey                                    | Current state                                                                                      | Recommendation                                                 |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Claude pause/recreate with Git and R2      | Implemented and previously proven against real providers                                           | Keep; include in a short regression journey                    |
| Desktop → browser chat while Mac is closed | Browser path implemented; return-to-desktop history incomplete                                     | Complete F3 before promising continuity                        |
| Browser as a complete cloud IDE            | Discovery/chat companion; creation, environment settings and content tabs deliberately unavailable | Desktop-first beta is valid; full browser IDE is separate work |
| Cloud Codex basic coding/resume            | Native path and archives implemented; full live continuity/renewal unqualified                     | Qualify before unattended support                              |
| Codex internal product tools/MCP/hooks     | Claude-only bridges; requested Codex MCP/hooks are logged and ignored                              | Gate actions by actual harness capabilities                    |
| Managed EAS iOS build/install/run          | Implemented; full live qualification still missing                                                 | Opt-in until exercised including cleanup                       |
| Android device with an existing APK        | Separate install/device path exists                                                                | Qualify and describe explicitly                                |
| Managed EAS Android build                  | Explicitly rejected; keystore/build flow absent                                                    | Mark unavailable; separate implementation                      |

For Codex, two specific issues need attention:

- **Credential rotation is discarded.** [engine.ts:370](https://github.com/zvadaadam/AGNT/blob/47d98fdfea8c40ba9c1365f2f37d0873f0835864/apps/sidecar/src/agents/engine.ts#L370) writes the original org import each turn; line 446 deletes the materialized auth file. The dispatch resolver rereads the unchanged secret. Any refreshed pair is lost. An [OpenAI maintainer explains](https://github.com/openai/codex/issues/10332#issuecomment-3831635259) that old refresh tokens have a limited reuse window. The discarded renewal is source-confirmed; exact failure timing is not live-proven. Use one trusted renewal owner with version/revocation checks, not arbitrary sandbox writes to the canonical secret. Effort L, implementation risk medium.
- **SDK default-mode approvals have no return path.** The native engine emits `permission.requested` and waits, while [AGNT drops that event](https://github.com/zvadaadam/AGNT/blob/47d98fdfea8c40ba9c1365f2f37d0873f0835864/apps/backend/src/agent-session/turn-lifecycle.ts#L526) and routes responses through its separate Claude bridge. Normal Deus cloud turns use bypass mode, so this is not a claim that every Deus Codex turn hangs. Reject unsupported permission modes first (S/low), or implement and test the bridge (M/medium).

Hosted builds also need durable submission ownership. [eas-build-broker.ts:155](https://github.com/zvadaadam/AGNT/blob/47d98fdfea8c40ba9c1365f2f37d0873f0835864/apps/backend/src/agent-session/eas-build-broker.ts#L155) submits, logs and replies without a durable build receipt. A lost result followed by retry can start a second paid build; completed-artifact reuse does not coalesce the first in-flight build. Record stable submission identity/result and reconcile ambiguous acceptance before exposing this broadly. Effort M–L, medium implementation risk, high confidence in the failure path.

## Operational follow-ups before widening access

These are concrete paths, but the conditional failures below were not observed in production.

| Issue                                                                  | Evidence and impact                                                                                                                                                                                                                                                                                                                                    | Smallest useful direction                                                                                                                                                        | Effort / risk / confidence                                |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Created VM loses cleanup ownership if both attach and cleanup RPC fail | [provisioning.ts:139,223](https://github.com/zvadaadam/AGNT/blob/47d98fdfea8c40ba9c1365f2f37d0873f0835864/apps/backend/src/workspace/provisioning.ts#L139). Isolated production-handler probe created one VM, failed both handoffs, then acknowledged the queue message. Default one-hour pause bounds active duration but does not recover ownership. | Preserve the concrete VM ID durably before acknowledging. Retrying create alone cannot repair a consumed claim. Reuse the existing cleanup mechanism.                            | M / medium / high                                         |
| Burst queue waiting consumes setup timeout                             | [provisioning.ts:43](https://github.com/zvadaadam/AGNT/blob/47d98fdfea8c40ba9c1365f2f37d0873f0835864/apps/backend/src/workspace/provisioning.ts#L43), batch size 10, deadline armed before enqueue. Full setup is serial within a batch. Earlier setup time can expire healthy later requests before they start.                                       | Bound parallelism or reduce batch size; separate queued waiting from active setup time. Coordinate with org admission.                                                           | M / medium / medium-high                                  |
| Failed lifecycle status writes never reconcile                         | [Workspace status sync](https://github.com/zvadaadam/AGNT/blob/47d98fdfea8c40ba9c1365f2f37d0873f0835864/apps/backend/src/workspace/do/workspace.ts#L180) and AgentSession line 334 log and discard failures; discovery reads PG. A paused/finished resource can appear running after an outage.                                                        | Persist a latest desired revision and retry via existing flush/alarm ownership; never replay obsolete status over new state.                                                     | M / medium / high                                         |
| Product Worker DB pools lack request ownership                         | [deus-cloud middleware](https://github.com/zvadaadam/AGNT/blob/47d98fdfea8c40ba9c1365f2f37d0873f0835864/apps/deus-cloud/src/middleware/dashboard-auth.ts#L44) and many handlers each create pools without ending them. The execution Worker already has request-scoped cleanup.                                                                        | Apply one request DB owner throughout the product Worker. This is a concrete resource-lifetime inconsistency; production connection exhaustion was not reproduced in this audit. | M / low-medium / high on ownership, medium on load impact |

## What I would build next

1. **Correct the small deterministic failures:** F2 and F4, with real Workers and published-wire tests.
2. **Close customer trust boundaries:** F1 before onboarding unrelated accounts, and a small enforced org compute cap before unattended use.
3. **Complete the product's durable-state story:** F3 plus F5. The user should see the same conversation and the last acknowledged save everywhere.
4. **Run a narrow invited beta:** desktop-first, Claude-first, explicitly prepared repositories. Include the actual packaged desktop and browser in qualification, then publish the intended installer.
5. **Expand only as the chosen lane is complete:** F7 for self-service setup; Codex renewal/capabilities for unattended Codex; live iOS/device checks and durable build submission for hosted builds; metering/spend policy and the operational follow-ups before broader access.

F1 can proceed independently of the SQL/consumer fixes. History reconciliation should consume the corrected contract. Increased queue concurrency should follow compute admission. Native MCP support belongs upstream if needed; AGNT owns its platform bridge and Deus owns truthful action availability.

The most useful maintainability investment is **boundary verification**: use schema-valid producer fixtures across AGNT and Deus, preserve one canonical snapshot/reconciliation path, and keep lifecycle/resource ownership explicit. Another generic retry framework, a larger node mesh, or broad file reshuffling would not resolve the demonstrated failures.

## Plan and launch-policy cleanup

Three direction changes are worth making alongside delivery:

- **Publish one current capability ledger.** The cloud plan mixes historical status snapshots; it still calls some shipped preview work absent and leaves promised handoff/secret work unfinished. Keep the historical reasoning, but give current status, owner and validation evidence one obvious home.
- **Make organization identity explicit before team workflows.** Desktop picks the first returned org; browser discovery combines memberships without useful org labels. Reviewed provider routes do enforce org ownership, so this is a product/control gap, not proven cross-org access.
- **Define persistent-data and upgrade promises before onboarding real work.** Desktop startup still rejects old prelaunch schemas with a manual delete/reset hint ([database.ts:123](https://github.com/zvadaadam/deus-machine/blob/1766aa56d5183f18526c83b18399b768924bd989/apps/backend/src/lib/database.ts#L123)); it does not silently delete the DB. Choose a supported upgrade baseline and migrate future changes. Workspace deletion currently retains conversation/recipe data while disposing VM/R2 resources; define retention/erasure intentionally. Update the README's local-only cloud/storage claims when exposing managed cloud.

Production PG backup/PITR and whole-platform disaster recovery were not inspected. A working R2 VM recovery journey is not evidence that a destroyed database/control plane can be restored. This is a verification task, not a claim that backups are absent.

## Verification and limits

This audit ran **519 passing deterministic tests**: 78 Deus backend cloud-driver, 27 Deus frontend cloud suites, 350 AGNT sidecar, and 64 selected upstream engine tests. The backend suite passed under installed Node 22, which matches its native SQLite ABI.

It also ran three isolated probes: actual generated SQL at 100/101 bindings in workerd; created-VM handoff failure through the production provisioning handler; and serial queue admission with a held first operation. Only the first is a real platform-limit reproduction; the latter two use synthetic provider/DO behavior.

Previous live Git/R2/native-Claude evidence remains relevant at the reviewed code. This audit did not rerun live providers, native Codex renewal/resume, EAS builds, device control, an unattended full GitHub lease interval, or the full desktop/browser UI journey. Large unit counts alone do not prove these journeys; F4 is a direct example.

Before the beta verdict changes, the acceptance journey should include: two unrelated accounts linking GitHub; over 100 messages then reconnect; desktop closed while browser work completes; a rejected Git save that stays visibly unsaved while retaining the VM; pause/recreate/Stop with cleanup; and the cap boundary under concurrent creation. Add real Codex/EAS qualification only for the features being enabled.

No source files were intentionally changed by this review. One unrelated untracked `.claude/skills/detail-bugs/SKILL.md` appeared in the linked AGNT worktree during the audit and was left untouched; provenance is unconfirmed. The only intended output is this report.
