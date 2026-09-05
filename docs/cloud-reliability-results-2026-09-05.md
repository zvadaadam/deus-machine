# Cloud reliability implementation — 2026-09-05

The implementation focuses on preserving work and making cleanup dependable. It changes Deus and AGNT; the generic agent-server remains at 0.3.2 because these failures belong to the product/platform lifecycle around it.

The [original review](cloud-environment-review-2026-09-05.md) and [roadmap](cloud-reliability-plan-2026-09-05.md) describe the baseline. This document records what was actually implemented and tested.

## What changed

**Reconnect preserves the existing machine.** AGNT no longer converts pause errors, missed heartbeats, or sidecar reconnect timeouts into destructive replacement. The provider must confirm absence before a ready VM is replaced. Incomplete provisioning attempts retain their existing replacement path.

**Replacement uses the backups already present.** The provisioning recipe carries the acknowledged Git save and R2 object key. Clone restores the WIP ref before agent admission, preserves user commit history, and leaves synthetic WIP changes dirty. A missing expected backup blocks readiness. Conditional Git pushes prevent an old checkout from overwriting newer saved work.

**Trace backups cover Claude and Codex.** Versioned tar archives preserve native state paths, exclude canonical login credentials and per-turn Codex configuration, and restore legacy Claude archives. Captures share one owner; a final Stop capture is fresh, and deletion waits for pending uploads. Unused VMs can save and restore a valid empty checkpoint.

**Stop waits for work to be saved.** The sidecar owns cancellation from receipt through preparation and execution. Successor preparation waits for its predecessor's cleanup. Authenticated `/drain` waits for execution wrappers, recordings and Git operations. Workspace then captures traces and queues termination. Failed saves retain the VM. Concurrent Stops share one operation, and a restarted DO can repeat the barrier.

**Archive and Unarchive use one serialized service in Deus.** Both WebSocket Archive and HTTP PATCH await manual cloud pause before marking the workspace archived. AGNT persists an admission hold, drains active work, settles queued turns, and suspends the VM. New work and background probes cannot release the hold; explicit Resume does. Errors preserve the VM and reach the caller. Unarchive opens the row before invoking the existing Wake operation, allowing early runtime events to update its status; a failed wake restores archived membership. Resume responses never overwrite a newer runtime projection. An online refresh clears stale sleep status and leaves active session sockets intact.

**New VMs stay paused under preview traffic.** E2B creation disables automatic HTTP wake. Existing VMs keep their original provider setting and full memory/filesystem; a legacy preview may still wake compute, although platform agent admission remains held. No destructive retrofit or repause polling was added.

**Cleanup has one durable owner.** Workspace persists captured VM/device IDs and retry deadlines. Cleanup survives parked or deleted state, never retargets a replacement VM, and reports pending cleanup. Simulator Start/Stop reconcile the billing ledger; cancellation shares one teardown result. Rejected late provisioning attachments enter the same cleanup ledger.

**GitHub App renewal belongs to the cloud.** The API accepts an explicit credential source separately from environment configuration. Workspace SQLite owns the current source and expiring lease; PG retains the immutable initial recipe. A private service binding asks deus-cloud to mint a token scoped to the workspace's organization and repository. Workspace renews before provisioning/resume/save barriers and near expiry on its existing heartbeat, applying the result to both Git and gh. A failed file write is retried even after minting succeeded; a mint outage cannot prevent idle suspension. Caller-managed PATs remain separate. Missing desktop authentication cannot disable an existing cloud lease.

## Verification

| Check                                                                     | Result                            |
| ------------------------------------------------------------------------- | --------------------------------- |
| Deus backend, including integration tests                                 | 914 passed                        |
| AGNT backend unit suite                                                   | 622 passed                        |
| AGNT Workers DO suite                                                     | 182 passed                        |
| AGNT sidecar unit suite                                                   | 342 passed                        |
| deus-cloud unit suite, including broker scope and HTTP routes             | 49 passed                         |
| AGNT SDK unit suite                                                       | 214 passed                        |
| Deus app/backend and AGNT backend/sidecar typechecks                      | Passed                            |
| AGNT backend deployment dry run and candidate sidecar build/isolated boot | Passed                            |
| Disposable live E2B recovery smoke                                        | Passed; recorded test VMs removed |

The live smoke ran the candidate sidecar's drain endpoint and production clone/archive code. It verified an empty checkpoint, dirty/untracked project files, drained admission rejection, preview traffic leaving a new VM paused, same-VM resume, deliberate loss of the owned test VM, and recovery into a replacement. The extended run also created a real Claude conversation and resumed the same session on the replacement; Claude recalled the test phrase from its earlier context. The Git remote was a preserved test repository and R2 was a byte-preserving stand-in. Codex traces were synthetic. All recorded test VMs were removed.

The latest extended receipt is [result.json](/Users/zvada/conductor/workspaces/deus-machine/sao-tome/.context/cloud-implementation/agnt/.context/cloud-smoke-b53af27c-872a-4b15-8ff2-7cd8158c4909/result.json), with an empty [ownership ledger](/Users/zvada/conductor/workspaces/deus-machine/sao-tome/.context/cloud-implementation/agnt/.context/cloud-smoke-b53af27c-872a-4b15-8ff2-7cd8158c4909/owned-vms.json). This proves the native Claude archive path, not the complete deployed Deus/AGNT conversation journey.

**Not verified live:** the deployed R2 binding, native Codex conversation resume, expired GitHub App token minting through the deployed broker, and real EAS build/device execution. No production backend, template, or desktop release was deployed. Do not treat the provider smoke as proof of the complete deployed user journey.

The initial broad Deus run exposed an Electron/Node SQLite ABI mismatch; running the repository's `test:backend` script under Node 22 rebuilt the native module and passed the entire suite. AGNT's Workers tests required local Vitest 3 internals to avoid resolving the SDK's Vitest 4 dependencies. Both are reflected in the reproducible commands/tooling, not hidden by skipped assertions.

## Maintenance assessment

- **Additions:** Domain-specific in-flight operations and one durable cleanup record stay inside Workspace. No generic retry scheduler, new service tier, or harness protocol translation was added. The private broker lives in the existing product worker; its HTTP app stays separately testable.
- **Premises:** Removed “unreachable means lost,” “archive discards recovery,” and “a later state transition will retry cleanup.” Verified and removed the unused snapshot-key helper and obsolete recovery decision module. Also removed client-side wake/recreate status inference and duplicate PG ownership of mutable credential source.
- **Spread:** Deus has one archive service; AGNT owns pause admission, replacement and cleanup. The shared WIP constants keep save and restore aligned. Tests cross the existing boundaries rather than introducing a second implementation.
- **Duplicates:** Final backups share the capture owner; cancelled boots share a stop result; provisioning no longer duplicates orphan termination after the DO accepts responsibility. Git/gh rotation shares one existing writer.

The Workspace class remains large. Moving it into generic lifecycle abstractions would add indirection to this patch; extract another module only when it can own a complete responsibility without exposing a bag of state callbacks.

## Rollout and next priorities

1. Deploy deus-cloud's named `GitHubTokens` entrypoint, then AGNT backend/candidate sidecar, then Deus. Older paused VMs may retain an older sidecar; `/drain` 404 preserves them and reports failure. The additive API/SDK contract has a minor changeset. Deus uses the installed SDK's supported raw client API to carry the field, so a package publish is not required for this consumer patch.
2. Prove private-repository resume/push and continuous execution across real token expiry with the Mac closed, against the deployed broker and R2 binding. The local tests cover lease timing, organization/repository scope, source changes and failures; they do not establish production configuration.
3. Repair browser-to-desktop transcript reconciliation. Complete Codex's internal tool bridge upstream and the managed Android debug build lane, then run the real EAS build/device cleanup journey. These remain tracked in the eight Hivenet threads recorded in the roadmap.

Git/R2 recovery is not a full disk backup. Ignored files, local databases and memory still depend on retaining the original VM or a future broader backup policy.

The upstream implementation is [AGNT draft PR #187](https://github.com/zvadaadam/AGNT/pull/187). AGNT work is isolated in [.context/cloud-implementation/agnt](/Users/zvada/conductor/workspaces/deus-machine/sao-tome/.context/cloud-implementation/agnt) on `zvadaadam/cloud-reliability`. Its [maintenance guide](/Users/zvada/conductor/workspaces/deus-machine/sao-tome/.context/cloud-implementation/agnt/docs/cloud-reliability.md) and [repeatable provider smoke](/Users/zvada/conductor/workspaces/deus-machine/sao-tome/.context/cloud-implementation/agnt/scripts/cloud-recovery-smoke.ts) live with the implementation. The linked AGNT and agent-server worktrees were not edited.
