# Cloud reliability implementation — 2026-09-05

The implementation focuses on preserving work and making cleanup dependable. It changes Deus and AGNT; the generic agent-server remains at 0.3.2 because these failures belong to the product/platform lifecycle around it.

The [original review](cloud-environment-review-2026-09-05.md) and [roadmap](cloud-reliability-plan-2026-09-05.md) describe the baseline. This document records what was actually implemented and tested.

## What changed

**Reconnect preserves the existing machine.** AGNT no longer converts pause errors, missed heartbeats, or sidecar reconnect timeouts into destructive replacement. The provider must confirm absence before a ready VM is replaced. Incomplete provisioning attempts retain their existing replacement path.

**Replacement uses the backups already present.** The provisioning recipe carries the acknowledged Git save and R2 object key. Clone restores the WIP ref before agent admission, preserves user commit history, and leaves synthetic WIP changes dirty. A missing expected backup blocks readiness. Conditional Git pushes prevent an old checkout from overwriting newer saved work.

**Trace backups cover Claude and Codex.** Versioned tar archives preserve native state paths, exclude canonical login credentials, per-turn Codex configuration, and regenerated shell caches containing environment exports. Restore applies the exclusions to older archives too, while preserving native rollout bytes. Captures share one owner; a final Stop capture is fresh, and deletion waits for pending uploads. Unused VMs can save and restore a valid empty checkpoint.

**Stop waits for work to be saved.** The sidecar owns cancellation from receipt through preparation and execution. Successor preparation waits for its predecessor's cleanup. Authenticated `/drain` waits for execution wrappers, recordings and Git operations. Workspace then captures traces and queues termination. Failed saves retain the VM. Concurrent Stops share one operation, and a restarted DO can repeat the barrier.

**Archive, Unarchive and explicit Wake use one serialized service in Deus.** Both WebSocket Archive and HTTP PATCH await manual cloud pause before marking the workspace archived. A wake requested during Archive rechecks archived membership after Pause; an earlier wake finishes before Archive can suspend the VM. AGNT persists an admission hold, drains active work, settles queued turns, and suspends the VM. New work and background probes cannot release the hold; explicit Resume does. Errors preserve the VM and reach the caller. Unarchive opens the row before invoking the existing Wake operation, allowing early runtime events to update its status; a failed wake restores archived membership. Resume responses never overwrite a newer runtime projection. An online refresh clears stale sleep status and leaves active session sockets intact.

**New VMs stay paused under preview traffic.** E2B creation disables automatic HTTP wake. Existing VMs keep their original provider setting and full memory/filesystem; a legacy preview may still wake compute, although platform agent admission remains held. No destructive retrofit or repause polling was added.

**Cleanup has one durable owner.** Workspace persists captured VM/device IDs and retry deadlines. Cleanup survives parked or deleted state, never retargets a replacement VM, and reports pending cleanup. Simulator Start/Stop reconcile the billing ledger; cancellation shares one teardown result. Rejected late provisioning attachments enter the same cleanup ledger.

**GitHub App renewal belongs to the cloud.** The API accepts an explicit credential source separately from environment configuration. Workspace SQLite owns the current source and expiring lease; PG retains the immutable initial recipe. A private service binding asks deus-cloud to mint a token scoped to the workspace's organization and repository. Workspace renews before provisioning/resume/save barriers and near expiry on its existing heartbeat, applying the result to both Git and gh. A failed file write is retried even after minting succeeded; a mint outage cannot prevent idle suspension. Caller-managed PATs remain separate. Missing desktop authentication cannot disable an existing cloud lease.

## Verification

| Check                                                                     | Result                            |
| ------------------------------------------------------------------------- | --------------------------------- |
| Deus backend, including integration tests                                 | 916 passed                        |
| AGNT backend unit suite                                                   | 629 passed                        |
| AGNT Workers DO suite                                                     | 199 passed                        |
| AGNT sidecar unit suite                                                   | 350 passed                        |
| deus-cloud unit suite, including broker scope and HTTP routes             | 53 passed                         |
| AGNT SDK unit suite                                                       | 214 passed                        |
| Deus app/backend and AGNT backend/sidecar typechecks                      | Passed                            |
| AGNT backend deployment dry run and candidate sidecar build/isolated boot | Passed                            |
| Disposable live E2B recovery smoke                                        | Passed; recorded test VMs removed |

The merge review added regressions for healthy heartbeats postponing token renewal, credentials in Codex shell caches, an older Stop overwriting a newer Resume, and simulator cleanup skipped by failed reconciliation. Repeated failed Pause/Stop attempts also re-pause retained VMs and refresh the provider URL before retrying. Simulator Stop attempts known cleanup and still reports an unavailable ledger. These cases failed before their fixes and pass now; the heartbeat case exercises the actual Workers alarm schedule.

The September 6 review also reproduced and fixed stale cached Git acknowledgments, a failed local recovery-marker write, credentials in legacy Claude archives, automation retirement interrupted by pending cleanup, and Stop rejected for retained VMs marked stopped. A fresh drain now decides the save outcome after prior Git operations settle; terminal receipts trigger one snapshot. Mint routes close their pools, and cleanup failures preserve the original provisioning error. Explicit Wake/Archive races are covered through HTTP. The proposed named-environment fix was rejected: the installed SDK and backend intentionally accept IDs or names. Failed drains keep admission closed until explicit Resume; unavailable Workspace RPCs reject new admission.

The ordered release workflows passed actionlint. Local probes exercised the real template build/promotion CLIs with provider calls intercepted and network disabled: candidates publish only their commit tag, shared aliases move together, and conflicting candidate/promotion arguments fail. The backend dry run accepts the candidate pin. These checks do not deploy the workflow.

The live smoke ran the candidate sidecar's drain endpoint and production clone/archive code. It verified an empty checkpoint, dirty/untracked project files, drained admission rejection, preview traffic leaving a new VM paused, same-VM resume, deliberate loss of the owned test VM, and recovery into a replacement. The extended run also created a real Claude conversation and resumed the same session on the replacement; Claude recalled the test phrase from its earlier context. The Git remote was a preserved test repository and R2 was a byte-preserving stand-in. Codex traces were synthetic. All recorded test VMs were removed.

The September 5 provider-smoke receipt is `.context/cloud-implementation/agnt/.context/cloud-smoke-b53af27c-872a-4b15-8ff2-7cd8158c4909/result.json` (local, gitignored), with an empty `.context/cloud-implementation/agnt/.context/cloud-smoke-b53af27c-872a-4b15-8ff2-7cd8158c4909/owned-vms.json` (local, gitignored). This proves the native Claude archive path, not the complete deployed Deus/AGNT conversation journey.

### Deployed validation — September 6 (Europe/Prague)

AGNT runtime commit `454363bb` was built into an E2B candidate without moving production/default/latest tags. An isolated backend Worker used separate DO namespaces, queue and R2 bucket, with a disposable workspace in the existing organization's private Expo test repository. PG/Hyperdrive and the real GitHub App installation were shared; only owned test rows and a uniquely named Git WIP ref were written. The backward-compatible deus-cloud broker entrypoint was deployed first using its existing Cloudflare secrets. Production VM provisioning and the desktop were not switched during this validation.

| Live check                                       | Result                                                                                                                                                                                    |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub App private-repository clone and WIP push | Passed; a request for a repository outside the installation's grant was also rejected before VM creation.                                                                                 |
| Cloud-owned renewal through the deployed broker  | Passed; a real Cloudflare alarm minted a new token and Git/gh read its matching fingerprint from the VM files. Only the test lease's expiry timestamp was accelerated.                    |
| Manual Pause/Resume                              | Passed; same VM identity and matching dirty/untracked file hashes.                                                                                                                        |
| Saved VM deliberately removed, then replaced     | Passed; real Git/R2 restore preserved file hashes and native Claude conversation memory.                                                                                                  |
| Stop, then recreate through Resume               | Passed; Stop wrote a fresh R2 object before confirmed termination; a new VM restored files and Claude memory again.                                                                       |
| Owned resource cleanup                           | Passed; workspaces were tombstoned first, then test rows and the Git WIP ref removed. All three VMs were confirmed absent; the temporary Workers, queue and empty R2 bucket were deleted. |

The test's native Claude requests went through the deployed API, session DO, sidecar and embedded engine using the SDK. The follow-up prompts contained no recovery phrase; the restored conversations recalled it. The Git recovery tree changed only the intended README and untracked test file. Raw receipts, rollback targets and the empty ownership ledger remain in the local, gitignored `.context/cloud-rollout-2026-09-06/` directory; they are not published artifacts. The live run above predates the September 6 review fixes; those have separate regression coverage.

**Still not verified live:** an unattended full GitHub lease lifetime with the client disconnected, native Codex conversation resume, and EAS build/device execution. The Codex attempt reached the runtime but failed explicitly because this organization has no `CODEX_AUTH_JSON` credential. This is a remaining configuration/test prerequisite, not proof that Codex continuation works. The deployed API journey also does not substitute for a desktop/browser UI test.

The initial broad Deus run exposed an Electron/Node SQLite ABI mismatch; running the repository's `test:backend` script under Node 22 rebuilt the native module and passed the entire suite. AGNT's Workers tests required local Vitest 3 internals to avoid resolving the SDK's Vitest 4 dependencies. Both are reflected in the reproducible commands/tooling, not hidden by skipped assertions.

## Maintenance assessment

- **Additions:** Domain-specific in-flight operations and one durable cleanup record stay inside Workspace. No generic retry scheduler, new service tier, or harness protocol translation was added. The private broker lives in the existing product worker; its HTTP app stays separately testable.
- **Premises:** Removed “unreachable means lost,” “archive discards recovery,” and “a later state transition will retry cleanup.” Verified and removed the unused snapshot-key helper and obsolete recovery decision module. Also removed client-side wake/recreate status inference and duplicate PG ownership of mutable credential source.
- **Spread:** Deus has one archive service; AGNT owns pause admission, replacement and cleanup. The shared WIP constants keep save and restore aligned. Tests cross the existing boundaries rather than introducing a second implementation.
- **Duplicates:** Final backups share the capture owner; cancelled boots share a stop result; provisioning no longer duplicates orphan termination after the DO accepts responsibility. Git/gh rotation shares one existing writer.

Workspace now constructs three private owners for GitHub credentials, snapshots, and cleanup. Each owns complete operations and shares Workspace's cached SQLite access; Workspace retains lifecycle transitions, admission, and the single alarm. The follow-up fixes stay within these boundaries and add no state machine or retry framework.

## Rollout and next priorities

1. AGNT's single `Deploy Cloud Runtime` workflow builds the candidate without moving shared aliases, deploys deus-cloud's named `GitHubTokens` entrypoint, deploys the backend pinned to that candidate, and then promotes `production/default/latest` together. Release Deus afterward. Older paused VMs may retain an older sidecar; `/drain` 404 preserves them, attempts to restore their pause, and reports failure. The additive API/SDK contract has a minor changeset. Deus uses the installed SDK's supported raw client API to carry the field, so a package publish is not required for this consumer patch.
2. Complete an unattended private-repository push across a full GitHub lease lifetime with the Mac closed. Deployed renewal with an accelerated near-expiry timestamp, private-repo Git recovery, R2 restore and native Claude continuation passed on September 6; an actual hour-long expiry journey remains distinct.
3. Desktop transcript recovery now shares the browser's snapshot projection and restores messages, parts, compactions, order and available turn accounting in one SQLite transaction. It publishes the restored fold to the desktop cache without replaying historical completion effects. Automated tests cover browser-written history after a database restart, repeated recovery, continued streaming, a pending prompt, write rollback and cancellation/accounting reconciliation. A real local WebSocket test verifies that subsequent message deltas still arrive after reordering. A deployed browser-to-desktop UI journey remains to be verified; this change adds no provider rollout or migration.
4. Complete Codex's internal tool bridge upstream and the managed Android debug build lane, then run the real EAS build/device cleanup journey. These remain tracked in the eight Hivenet threads recorded in the roadmap.

Git/R2 recovery is not a full disk backup. Ignored files, local databases and memory still depend on retaining the original VM or a future broader backup policy.

The upstream implementation is [AGNT PR #187](https://github.com/zvadaadam/AGNT/pull/187), including its [runtime contract](https://github.com/zvadaadam/AGNT/blob/zvadaadam/cloud-reliability/docs/cloud-reliability.md) and [recovery smoke](https://github.com/zvadaadam/AGNT/blob/zvadaadam/cloud-reliability/scripts/cloud-recovery-smoke.ts). AGNT work is isolated in the local, gitignored `.context/cloud-implementation/agnt` worktree. The linked AGNT and agent-server worktrees were not edited.
