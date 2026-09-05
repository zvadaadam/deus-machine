# Cloud reliability implementation — 2026-09-05

The first implementation focuses on preserving work and making cleanup dependable. It changes Deus and AGNT; the generic agent-server remains at 0.3.2 because these failures belong to the product/platform lifecycle around it.

The [original review](cloud-environment-review-2026-09-05.md) and [roadmap](cloud-reliability-plan-2026-09-05.md) describe the baseline. This document records what was actually implemented and tested.

## What changed

**Reconnect preserves the existing machine.** AGNT no longer converts pause errors, missed heartbeats, or sidecar reconnect timeouts into destructive replacement. The provider must confirm absence before a ready VM is replaced. Incomplete provisioning attempts retain their existing replacement path.

**Replacement uses the backups already present.** The provisioning recipe carries the acknowledged Git save and R2 object key. Clone restores the WIP ref before agent admission, preserves user commit history, and leaves synthetic WIP changes dirty. A missing expected backup blocks readiness. Conditional Git pushes prevent an old checkout from overwriting newer saved work.

**Trace backups cover Claude and Codex.** Versioned tar archives preserve native state paths, exclude canonical login credentials and per-turn Codex configuration, and restore legacy Claude archives. Captures share one owner; a final Stop capture is fresh, and deletion waits for pending uploads. Unused VMs can save and restore a valid empty checkpoint.

**Stop waits for work to be saved.** The sidecar owns cancellation from receipt through preparation and execution. Successor preparation waits for its predecessor's cleanup. Authenticated `/drain` waits for execution wrappers, recordings and Git operations. Workspace then captures traces and queues termination. Failed saves retain the VM. Concurrent Stops share one operation, and a restarted DO can repeat the barrier.

**Archive uses one service in Deus.** Both WebSocket Archive and HTTP PATCH await cloud pause before marking the workspace archived. They retain recovery data. Cloud pause errors reach the caller. Pause admission lives in AGNT rather than relying on a potentially stale desktop/status observation.

**Cleanup has one durable owner.** Workspace persists captured VM/device IDs and retry deadlines. Cleanup survives parked or deleted state, never retargets a replacement VM, and reports pending cleanup. Simulator Start/Stop reconcile the billing ledger; cancellation shares one teardown result. Rejected late provisioning attachments enter the same cleanup ledger.

**Supplied GitHub rotations reach the running VM.** Both Git and gh files receive the latest supplied credential, including overlapping refreshes. This fixes application of refreshed credentials; it does not add autonomous minting while the Mac is closed.

## Verification

| Check                                                                     | Result                            |
| ------------------------------------------------------------------------- | --------------------------------- |
| Deus backend, including integration tests                                 | 899 passed                        |
| AGNT backend unit suite                                                   | 617 passed                        |
| AGNT Workers DO suite                                                     | 160 passed                        |
| AGNT sidecar unit suite                                                   | 342 passed                        |
| Deus app/backend and AGNT backend/sidecar typechecks                      | Passed                            |
| AGNT backend deployment dry run and candidate sidecar build/isolated boot | Passed                            |
| Disposable live E2B recovery smoke                                        | Passed; recorded test VMs removed |

The live smoke ran the candidate sidecar's drain endpoint and production clone/archive code. It verified an empty checkpoint, dirty and untracked project files, same-VM pause/resume, deliberate loss of the owned test VM, and recovery of work plus synthetic Claude/Codex traces into a replacement. The Git remote was a preserved test repository and R2 was a byte-preserving stand-in. Local Workers tests also exercised R2 deletion ordering.

**Not verified live:** the deployed R2 binding, native Claude/Codex conversation resume, expired GitHub App token minting, and real EAS build/device execution. No production backend, template, or desktop release was deployed. Do not treat the provider smoke as proof of the complete deployed user journey.

The initial broad Deus run exposed an Electron/Node SQLite ABI mismatch; running the repository's `test:backend` script under Node 22 rebuilt the native module and passed the entire suite. AGNT's Workers tests required local Vitest 3 internals to avoid resolving the SDK's Vitest 4 dependencies. Both are reflected in the reproducible commands/tooling, not hidden by skipped assertions.

## Maintenance assessment

- **Additions:** Domain-specific in-flight operations and one durable cleanup record stay inside Workspace. No generic retry scheduler, new service tier, or harness protocol translation was added.
- **Premises:** Removed “unreachable means lost,” “archive discards recovery,” and “a later state transition will retry cleanup.” Verified and removed the unused snapshot-key helper and obsolete recovery decision module.
- **Spread:** Deus has one archive service; AGNT owns pause admission, replacement and cleanup. The shared WIP constants keep save and restore aligned. Tests cross the existing boundaries rather than introducing a second implementation.
- **Duplicates:** Final backups share the capture owner; cancelled boots share a stop result; provisioning no longer duplicates orphan termination after the DO accepts responsibility. Git/gh rotation shares one existing writer.

The Workspace class remains large. Moving it into generic lifecycle abstractions would add indirection to this patch; extract another module only when it can own a complete responsibility without exposing a bag of state callbacks.

## Rollout and next priorities

1. Ship the AGNT backend and candidate sidecar before depending on confirmed Stop and idempotent pause. Older paused VMs can retain an older sidecar; `/drain` 404 preserves them rather than silently terminating without confirmation.
2. Add a durable product archive/wake policy. This patch confirms pause; it does not cancel frozen turns or prevent preview traffic from waking existing `autoResume: true` machines. Strict “archived stays stopped until unarchive” is not finished.
3. Implement cloud-owned GitHub token leases, then test private repository resume/push with the Mac closed and the previous token expired.
4. Repair browser-to-desktop transcript reconciliation. Finish Codex's internal tool bridge upstream and the managed Android debug build lane. These remain tracked in the eight Hivenet feedback threads recorded in the roadmap.

Git/R2 recovery is not a full disk backup. Ignored files, local databases and memory still depend on retaining the original VM or a future broader backup policy.

The upstream implementation is [AGNT draft PR #187](https://github.com/zvadaadam/AGNT/pull/187), commit `c34a7f57`. AGNT work is isolated in [.context/cloud-implementation/agnt](/Users/zvada/conductor/workspaces/deus-machine/sao-tome/.context/cloud-implementation/agnt) on `zvadaadam/cloud-reliability`. Its [maintenance guide](/Users/zvada/conductor/workspaces/deus-machine/sao-tome/.context/cloud-implementation/agnt/docs/cloud-reliability.md) and [repeatable provider smoke](/Users/zvada/conductor/workspaces/deus-machine/sao-tome/.context/cloud-implementation/agnt/scripts/cloud-recovery-smoke.ts) live with the implementation. The linked AGNT and agent-server worktrees were not edited.
