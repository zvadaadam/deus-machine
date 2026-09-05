# Cloud reliability: implementation plan — 2026-09-05

Start with **preserving the existing cloud computer and safely recovering its saved work**. Follow with truthful Archive/Stop and device cleanup, then cloud-owned GitHub renewal. These changes strengthen the current architecture and remove duplicated ownership. Codex tool parity and managed Android builds should follow on that foundation.

This follows the [cross-repository review](cloud-environment-review-2026-09-05.md), against Deus `df40aaf600`, AGNT `eefc1fa2`, and agent-server `6207d7f` / installed engine `0.3.2`. This is the original roadmap. The first implementation and its actual validation are recorded in [implementation results](cloud-reliability-results-2026-09-05.md); unimplemented acceptance criteria below remain follow-up work. Eight feedback reports were delivered through Hivenet; receipts are below.

**First, clarify the product promise**

You were right about pause: E2B retains a paused sandbox's filesystem and memory indefinitely. A successful resume should return to the same machine, including files and processes. Paused machines do not routinely expire. [E2B persistence](https://docs.e2b.dev/sandbox/persistence)

The recovery reference is a separate Git backup of project work that has not necessarily been committed or pushed to the normal branch. It matters when a machine really must be replaced. It is not what normal pause/resume uses, and it is not a backup of the entire disk. Ignored files, local databases and process state are reasons to preserve the VM itself.

| User action                           | Intended behavior                                                                                                                                                             |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stop an agent                         | Cancel that turn, including preparation. Keep the workspace and other chats usable.                                                                                           |
| Pause the cloud computer              | Suspend execution and preserve the same VM. Resume it when explicitly requested or when an allowed idle-wake action requires it.                                              |
| Archive a workspace                   | Prevent new work, cancel its active/preparing turns, stop hosted devices, and pause the VM. Preserve files, conversations and recovery data for unarchive.                    |
| Unarchive                             | Restore access to the existing workspace. Resume on use; cancelled turns must not restart.                                                                                    |
| Permanently delete / explicitly reset | Apply a deliberate destructive lifecycle and retention policy. The existing platform `/stop` kills the VM and should not be used as the implementation of reversible Archive. |

“Browser-written history” means a person continues a chat in the browser while the Mac is closed, then returns to desktop. The desktop should show those same messages. “Cancel during preparation” means pressing Stop while the system is preparing Git/credentials must prevent the agent from starting afterward.

**1. First work package: preserve and recover cloud work — AGNT**

The immediate danger is in our fallback logic:

- [pauseSandbox](/Users/zvada/conductor/workspaces/agnt/tbilisi/apps/backend/src/workspace/do/workspace.ts:1306) turns a provider pause error into shutdown/termination.
- [resumeSandbox](/Users/zvada/conductor/workspaces/agnt/tbilisi/apps/backend/src/workspace/do/workspace.ts:1340), heartbeat timeout and resume-wait timeout can turn connectivity failure into reprovisioning.
- The [provisioning consumer](/Users/zvada/conductor/workspaces/agnt/tbilisi/apps/backend/src/workspace/provisioning.ts:100) then terminates the previous sandbox. An unreachable sidecar does not establish that its disk is lost.
- [repo-clone](/Users/zvada/conductor/workspaces/agnt/tbilisi/apps/backend/src/workspace/steps/repo-clone.ts) ignores the saved WIP ref. The next autosave can replace the recovery pointer with the fresh checkout; this was reproduced with the real Git functions.

**Original prefactor proposal (superseded by the implementation assessment):** Extend the existing [sandbox-recovery.ts](/Users/zvada/conductor/workspaces/agnt/tbilisi/apps/backend/src/workspace/do/sandbox-recovery.ts) decision seam to cover the scattered recovery triggers. Move decisions, keep provider effects in Workspace, and preserve behavior in this preparatory commit. Characterize the affected decisions and provisioning-epoch guards. Do not introduce a lifecycle framework or split the whole Workspace class.

**Then change behavior in small commits:**

1. Give the provider boundary an explicit observation/result that distinguishes running, paused, confirmed absent, and temporarily unavailable. Preserve the sandbox ID on timeouts, rate limits, auth failures and ambiguous provider errors. Retry/reconnect or expose a recoverable connection problem. A pause error must not authorize a kill; a missed heartbeat must not authorize replacement. Resume/repair the same VM first, keeping stale-operation/epoch guards around every awaited result.
2. Admit replacement only for initial creation, confirmed loss, or an explicit reset. Carry the reason into the provisioning claim; a queued stale recovery cannot kill a VM that has since recovered. The current `exists(): boolean` catches errors as false, so it cannot serve as proof of absence. Remove the comments attributing routine failures to paused-VM garbage collection.
3. Make recovery a provisioning dependency before setup/agent admission. Save explicit recovery metadata, including the last confirmed remote snapshot SHA, whether it is a clean HEAD or a synthetic worktree snapshot, and its base HEAD. Fetch and restore the saved project state while preserving real branch history; do not put synthetic autosave commits into the user's PR. Existing refs without new metadata require a deliberate compatibility path, including clean snapshots that point straight at HEAD.
4. Distinguish “no prior snapshot” from “snapshot fetch/auth/restore failed.” When previous recovery is expected, block readiness and autosave until it is reconciled. A fresh checkout must never silently become the replacement backup. Use a compare-and-swap update of the known remote ref so an older sandbox cannot overwrite a newer recovery save. Keep the acknowledged recovery pointer until the new snapshot is confirmed remotely.
5. Surface save/restore failure separately from an agent's successful reply. A completed chat turn is not evidence its files are safely backed up. Do not delete recovery data during Archive.

**Done when:** transient pause/connect/heartbeat failure produces zero kill/create calls; normal pause/resume retains sandbox ID and a test file; real-Git dirty and clean snapshots recover the correct files and branch history; failed recovery blocks a new autosave; stale provisioning and old-sandbox pushes cannot overwrite the current machine's state. Reuse the saved WIP reproduction as a regression. Full-disk disaster backup remains a separate policy; this package must not claim Git snapshots restore ignored files or memory.

**2. Truthful Archive/Stop and durable device cleanup — Deus + AGNT**

First fix the small [sidecar cancellation gap](/Users/zvada/conductor/workspaces/agnt/tbilisi/apps/sidecar/src/agents/controller.ts): install a turn-owned record before the first preparation await, mark that exact turn cancelled, check ownership/cancellation after each await, and never call `runtime.run` after cancellation. Cleanup must not remove a successor turn's credentials. Preserve the engine's existing confirmed/unconfirmed cancellation semantics once it owns the turn.

Then introduce one Deus archive service used by both `q:archiveWorkspace` and PATCH/update. Consolidating those different behaviors is part of the feature change, not a behavior-preserving refactor. Keep transport validation at the edges. The service must request cloud suspension and local cleanup, preserve recovery data, and publish pending/failure/completed state honestly. Do not copy the PATCH route's kill-and-delete-ref behavior into the actual UI path.

Store the desired execution state in AGNT Workspace, so closing the Mac cannot discard the archive intent. Block new turn admission and automatic wake for a user-parked workspace; cancel its existing turns before freezing the VM so they cannot resume later. Leave product archive/list presentation in Deus; the platform owns durable suspension and resource cleanup. Retry cloud cleanup from durable intent, and do not show “stopped” while provider execution remains unresolved.

There is a specific wake-policy issue to solve: the provider currently creates VMs with `autoResume: true`, so a request to an old preview URL can wake a paused VM. Merely hiding an archived workspace or adding a local flag is insufficient. New machines can use platform-controlled explicit wake, with preview wake gated by workspace policy. The pinned E2B `2.20.0` SDK exposes auto-resume at creation, not a pause-time toggle; verify a supported state-preserving path for existing machines before promising archived VMs cannot wake. Never solve that transition by killing and recloning their work. [E2B auto-resume behavior](https://docs.e2b.dev/sandbox/auto-resume)

Hosted devices need two small ownership changes:

- In `SimulatorManager`, consolidate the boot promise into its existing operation record, then make Start, reconnect adoption and Stop share per-platform ownership. Recheck after provider awaits. Share one teardown result between the boot and Stop paths. This removes the hidden-second-device race and false double-stop error.
- In Workspace's existing device ledger, persist stop intent before provider I/O and retain it until confirmed terminal. Schedule retries even when the VM is paused or the workspace deleted. Keep old failed-stop resources addressable; a single display slot must not erase a billed resource.

Keep one Workspace alarm owner. Its physical deadline must be the earliest lifecycle, device-cleanup or credential-renewal deadline. Deleting a workspace clears lifecycle monitoring, but must not erase pending device cleanup. This is required behavior, not a new scheduler package. After correctness lands, publish a revisioned Workspace device snapshot and make per-chat/device caches compatibility projections; then remove Deus's older-chat fallbacks and duplicate arbitration.

**Done when:** the actual UI archive mutation prevents new cloud work, cancels preparation, preserves files and recovery refs, and reports cleanup truthfully; unarchive resumes the same computer without restarting cancelled turns; failed device stop retries after pause/delete without waking a VM; reconnect/Start cannot hide a second device; boot cancellation ends stopped after a single confirmed teardown. Test stale preview traffic as part of Archive acceptance.

**3. Renew GitHub access in the cloud — deus-cloud policy, AGNT timing**

The clean fix is a per-workspace credential source, separate from environment recipes and static secrets. An environment describes setup; a credential lease expires and must be renewed. Recreating a workspace to refresh credentials mixes those responsibilities.

Use an optional top-level `repositoryAuth: { type: "provider" }` contract for both inline and named-environment workspaces. AGNT resolves it through a private Worker service binding to deus-cloud. The request uses the persisted organization and repository; deus-cloud owns installation lookup, repository authorization and minting. AGNT receives an expiring lease and owns installing it into the VM. No product-specific GitHub keys or mint policy belongs in agent-server.

One useful preparation commit extracts deus-cloud's existing org/repository mint policy into a function shared by the current route and the new private entrypoint. Preserve the current authentication and scope checks. Reuse `writeGithubAuthFiles` and `configureGitAuth`; there is no need to invent another secret store.

Resolve/install fresh access immediately before private clone, after thaw before admitting a turn, and near expiry while continuously running. Refresh both Git and `gh` auth files. Track actual expiry and fence installation by sandbox/generation; use the same alarm scheduling owner as device cleanup. Stop refreshing while paused. Renewal failures preserve the VM and distinguish temporary outage from denied access.

Publish the additive API/SDK contract before switching Deus. Attach it to existing workspaces with a configuration-only operation that does not wake or reprovision them. Remove desktop mint/upsert/re-create refresh from the new path. Keep static PAT and managed-repository behavior; do not delete ambiguous existing `github_token` secrets, whose provenance is not recorded.

Defer an on-demand Git credential helper: it would add sandbox transport and image rollout and would still leave `gh` stale unless more work is added. Expiry-aware installation through existing Git/gh files is the smaller complete first fix.

**Done when:** with the Mac closed, a private repo can resume after expiry and fetch/push/autosave; a continuously running turn crosses expiry and subsequent Git and `gh` commands still work; named/inline environments behave equally; token refresh never clones/replaces a machine or modifies unrelated secrets; auth-provider failure remains visible and retryable. Cover timing/identity in unit and DO tests, then verify actual file readers in staging.

**4. Conversation continuity and capability completion**

Desktop history is an independent Deus fix that can proceed alongside the platform work. Extract/reuse the browser's pure snapshot projection, then reconcile messages, parts, compactions, ordering and accounting into desktop persistence. Keep hydration separate from live side effects: old completion messages must not trigger PR refreshes or overwrite today's working status. Test browser → desktop, missed streaming chunks, repeated snapshots and cold restart against a real temporary SQLite database.

Codex parity has two owners. The upstream `codex-app-server` adapter advertises `mcpServers: false`; implement canonical MCP descriptor mapping there first, with session configuration compatibility and invocation tests. AGNT then exposes its existing internal tool server through a session-scoped transport that Codex can consume. Reuse the same tool definitions and provider brokers. Human Simulator controls already use a separate path. Do not describe this as Codex being unable to run cloud coding turns, or assume MCP parity automatically implements Claude hooks.

Android hosted devices and APK installation exist. The missing feature is the managed Android build lane. Expo documents debug APK builds using `withoutCredentials` and `:app:assembleDebug`; customer release-keystore plumbing is not a blanket prerequisite. Thread platform through build creation, reuse, status, artifact selection and installation. Verify the actual managed GraphQL job schema before implementing the provider request, then prove build → install → launch → interaction → cleanup. [Expo EAS configuration](https://docs.expo.dev/build/eas-json/)

Keep one tested capability description per deployment/workspace/harness. Use it for agents and UI to distinguish devices, native builds, internal tools and direct-browser operations. Backend deployment does not upgrade a paused VM's sidecar; negotiate capabilities during the backend/template/SDK rollout. Complete cloud secret entry/readiness and direct-browser workspace identity before advertising full cloud IDE parity. These are subsequent product changes, not prerequisites for the first data-safety fix.

**Prefactor assessment and boundaries**

| Lens          | Finding and disposition                                                                                                                                                                                                |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Seam fit      | Recovery already has a pure decision helper, but key triggers bypass it. Consolidate those decisions first; add new safety behavior next.                                                                              |
| Safety net    | Existing tests are green while cross-component guarantees fail. Use the saved reproductions and targeted provider/DO/SQLite tests; add lifecycle characterization before moving decisions.                             |
| Duplication   | Archive is split across transports; device state is duplicated across chats; Git mint policy would otherwise be copied into a broker. Unify with the relevant feature, except the small shared mint-policy extraction. |
| Vocabulary    | Separate pause from kill, agent cancellation from VM suspension, credential source from expiring lease, and device support from build support. Introduce the distinctions with their actual behavior.                  |
| Stale premise | “Unreachable means dead,” “Archive means discard WIP,” “the Mac renews before every wake,” and “a future transition retries cleanup” are false premises. Fix the contracts; moving files alone does not fix them.      |

Only three preparatory extractions are recommended across the staged work: recovery decisions, device boot bookkeeping, and shared Git mint policy. Perform each immediately before its feature, not as a cleanup week. Snapshot projection can be extracted within the independent continuity patch. Keep the three repositories, canonical engine protocol, existing provider brokers, and current DO ownership. Defer a broad Workspace/SimulatorManager rewrite, new generic orchestration frameworks, and a full direct-web expansion.

**Implementation update — second pass**

VM preservation, Git/trace recovery, consolidated cleanup, manual Pause/Resume admission, and autonomous GitHub App leases are implemented in the companion draft PRs. The final API spelling is `repositoryAuth: { type: "github_app" | "secret" }`. Current source has one authority in Workspace SQLite; PG retains only the captured initial recipe. Existing paused VMs retain their provider auto-resume setting. See the [implementation results](cloud-reliability-results-2026-09-05.md) for current tests, real Claude replacement-resume evidence, rollout order, and the remaining staging acceptance checks. The proposals above document the earlier plan and are not a substitute for those results.

**Hivenet delivery record**

All eight reports returned `delivered: true` for `--to deus`. Auto-collected environment telemetry was disabled. Reports distinguish local reproductions, source inspection and staging work still required.

| Report                           | Thread                             |
| -------------------------------- | ---------------------------------- |
| Codex tool bridge                | `6f2da7cd689d9febdd1c227d7793f22e` |
| Managed Android debug builds     | `528c5f37d927654ab57a1238be906d91` |
| VM preservation and WIP recovery | `e9a2900d20f5be7b9d770b821f76a567` |
| Archive lifecycle                | `74de4531e8fbd3a17c5d2e7ba08ec1b5` |
| Preparation cancellation         | `e00267ab4e2cfcaf5a31d5f4341c7406` |
| Device lifecycle                 | `485ed966e6f3c66e0189675e8951cebd` |
| GitHub renewal                   | `18570e50457e86db65eab46a1b19830b` |
| Desktop history                  | `0363235823427febca1b11c96b61408a` |

Exact payloads and receipts: [.context/cloud-review/hivenet-reports.json](/Users/zvada/conductor/workspaces/deus-machine/sao-tome/.context/cloud-review/hivenet-reports.json), [hivenet-results.ndjson](/Users/zvada/conductor/workspaces/deus-machine/sao-tome/.context/cloud-review/hivenet-results.ndjson). Detailed landing-zone plans: [GitHub renewal](/Users/zvada/conductor/workspaces/deus-machine/sao-tome/.context/cloud-review/github-renewal-plan.md), [devices](/Users/zvada/conductor/workspaces/deus-machine/sao-tome/.context/cloud-review/device-lifecycle-plan.md), [continuity and Codex](/Users/zvada/conductor/workspaces/deus-machine/sao-tome/.context/cloud-review/agent-continuity-plan.md).

The initial review validated 287 selected Deus tests and five local bug reproductions. Implementation and later validation supersede that baseline; use the [results document](cloud-reliability-results-2026-09-05.md) for current evidence. Deployed GitHub/R2 and EAS acceptance cases remain staging work.
