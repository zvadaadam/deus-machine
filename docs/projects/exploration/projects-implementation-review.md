**Implementation update — 14 September 2026.** The working local version is now implemented. The checked-in [local Projects guide](../../../docs/local-projects.md) and source code describe what exists; the design below remains the broader local/cloud target. Local scope includes one repository and Claude harness per Project, managed worktrees, durable inputs/dispatches/outcome delivery, seven tools, immutable content/report versions, PR associations/provenance, and Project UI. Fresh managed conversations, folder coordinators, multiple repositories and cloud ownership/execution remain deferred.

Validation: 1,088 backend tests, 88 agent-server tests (7 optional live tests skipped), type checks, web build, two real model Project workflows, real Pause/Continue/Resume, idle owner process restart, UI report acceptance and versioned-document publication. Active-owner crash behavior has deterministic wire coverage, not a complete OS-process kill matrix. Desktop-shell qualification is recorded in the local guide.

**Projects — imagined implementation review and feedback**

14 September 2026. Review of the [consolidated report](projects-implementation-report.md) and [schema specification](projects-implementation-schema.md), following the earlier local and cloud source investigations. This was a source-backed walkthrough and three independent review lenses: local lifecycle/engine boundaries, relational model/identity, and cloud authority/recovery. No feature was implemented and no software tests were run. Findings below are corrections to the proposal, not observed failures of a built Projects feature.

**Verdict**

The design is a good local fit and has a credible cloud implementation path. It is a substantial coordination feature, not a small MCP wrapper. The first experiment can be bounded to one coordinator and one child; reliable parallel operation needs the receipts, execution gates and recovery already specified. Cloud adds product hosting/auth and source enforcement work, but does not require rewriting the harness into a Project engine.

The useful simplification is stable Agent/workspace identity plus explicit conversation/execution identity. Keep one current runnable conversation for dedicated Agents; preserve ordinary multi-chat workspaces. Reuse existing session transcripts/accounting and UI renderers. Add Project ownership and scheduling where those responsibilities actually live.

**Walking through the implementation**

1. **Create locally with the UI closed.** Move identity/row reservation and preparation out of route/UI ownership. Begin an operation transaction, insert the initializing workspace shell, membership, initial input and assignment, then commit before provisioning. A process exit after any subsequent effect resumes using reserved identities. No selected SessionPanel or pending React Map is needed to launch Project work.
2. **A coordinator publishes and starts a child in one turn.** Editing a local file alone does not publish it. PublishContext returns a committed immutable revision; CreateAgent pins that revision. The child materializes precisely that snapshot. Competing publication gets an expected-head conflict. ReportResult commits references only after the bytes are durable.
3. **A child asks a question and yields.** SendToAgent records an attributed question before returning. Its source turn ends; the immutable terminal envelope settles that dispatch. The owner batches the waiting question with the child outcome into eligible coordinator work. A correlated reply targets the original child conversation; duplicate events cannot create another answer or silently retarget a replacement.
4. **The coordinator finishes handling the answer.** Its own terminal closes its dispatch and releases capacity. It produces no self-wake input. The prior child inputs remain admitted in delivery history, so releasing reservations does not schedule them again.
5. **Pause races a delayed remote send.** Commit Pause before cancellation. Cancel/revoke by stable dispatch key, including a request that has not arrived yet. If admission/writer quiescence is uncertain, display stopping/uncertain and keep capacity occupied. A timeout or synthetic error cannot authorize another writer.
6. **Start fresh while another client has an old tab.** Local execution advances the workspace pointer/generation transactionally after quiescence. AGNT execution seals the old source, creates a staged replacement, switches the Workspace binding by CAS, then activates the replacement. Every public send/interaction path enforces managed policy. A stale browser token cannot reactivate history. Crash between steps repairs the same operation.
7. **A cloud result is committed around turn end or owner eviction.** Tool ingress captures the exact active source turn and records the mutation grant. The owner may finish an already-accepted publication after normal terminal, subject to cancellation/replacement policy. Terminal retries use frozen bytes; a later publication emits a distinct result_available input. Source delivery and Project due-work alarms both survive eviction, and read/ack repair removes stale delivery obligations.
8. **Archive or lose the runtime.** Admission closes and execution is reconciled. Archive retains workspace/session/Project records. Published content and PR sources remain usable independently of runtime files. Repository deletion cannot silently cascade through managed membership. Explicit history deletion may make transcripts unavailable while their original source identities remain in reports.

**Findings and corrections applied**

| Finding from the coding pass                                                | Why the draft would fail                                                              | Correction now in report/schema                                                                             |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Local membership before workspace insertion                                 | Immediate FK rejects CreateAgent's first transaction                                  | Insert initializing workspace shell first; preserve it on preparation failure                               |
| Assignment/input circular linkage                                           | Neither fully linked row can be inserted first                                        | Input with nullable assignment link, assignment insertion, then complete link before the same commit        |
| Replacement described by owner location                                     | Local owner controlling remote execution still crosses source boundaries              | Choose protocol by execution target; only local execution has the single-database swap                      |
| New cloud session described as sealed                                       | Activation could accidentally reopen historical execution                             | New session is staged; source-local staged→active CAS; sealed is permanent                                  |
| Managed policy only enforced by Project routes                              | Existing REST/WS/session creation or automation paths bypass the owner                | Protected Workspace/Session bindings and final source admission checks, including after awaits              |
| Every terminal creating coordinator work                                    | Coordinator can wake itself indefinitely                                              | Reconcile all outcomes; only actionable child interests generate wake inputs                                |
| Reservation release mistaken for input eligibility                          | Successful instructions run again when their turn ends                                | Preserve admitted delivery history; replay needs an explicit authorized operation                           |
| Terminal retry enriched with later report/question data                     | Same dedup key arrives with a conflicting payload                                     | Freeze envelope/hash at first terminal; owner joins presentation; later result uses a separate input        |
| Only ProjectDO scheduling specified                                         | Source outbox may overwrite watchdog alarm or never retry                             | Combine source delivery/watchdog/flush deadlines and add exact source read/ack repair                       |
| Tool scope inferred from membership/session alone                           | Contributor can overwrite a brief or stale invocation borrows a newer turn            | Seven explicit contracts, path/assignment scopes, captured source-turn grants before asynchronous relay     |
| Mixed local-owner/cloud-child mode assumed to share private cloud transport | Mac cannot call a Worker binding; ordinary credentials cannot override managed policy | Defer managed mixed execution until authenticated controller delegation and outbound delivery are specified |

The follow-up consistency check additionally narrowed replacement lifetime: an unresolved replacement remains an Agent lifecycle lock through activation and owner acknowledgement. A newly staged source cannot be sealed by a second replacement while the first is activating. Human Pause still commits immediately and blocks dispatch. Uncertain activation is reconciled before another replacement starts.

**Feedback on the earlier plan**

I had understated how much enforcement belongs in the execution platform. An owner service and durable inbox are necessary, but insufficient if public session APIs can still start writers. This is now a build gate, not a vague future hardening task.

I had also overgeneralized local atomicity to remote execution and under-specified source scheduling. The platform already supplies useful creation/replay/receipt machinery; Projects must compose it with clear staged handoffs and outcome obligations rather than assume one transaction spans services.

Several apparent abstractions would add duplication: another local current-session pointer, a universal task engine, a globally canonical PR row spanning Project DOs, or a separate SQL document-body authority. The revised design uses a host adapter for the existing pointer, finite domain operations, Project-local PR associations with stable external keys, and immutable file manifests. The ordinary welcome Map refactor is deferred unless its independent durable kickoff owner is designed.

The cloud exercise improves local behavior too: UI-independent launch, explicit publication, exact-source attribution, durable Pause, no implicit replay and recovery after process restart all matter on a Mac. Local execution remains simpler because its metadata and lifecycle receipts can share deus.db and source outcomes can commit locally.

**What remains to prove by implementation**

- The first local end-to-end loop, including a closed UI, process restart, bounded transcript read and one actual coordinator wake.
- Tool transport parity and source-turn capture for the selected Claude/Codex harnesses; cloud Codex MCP support cannot be assumed from generic engine capabilities.
- Cancellation/admission uncertainty and writer quiescence, with delayed sends and every replacement crash boundary exercised.
- Shared-core behavior on SQLite and ProjectDO, directory reservation/projection repair, source and owner alarm recovery, and Mac-disconnected cloud operation.
- Cloud authorization/revocation, organization discovery/push, bounded transcript APIs, and version compatibility between released platform, consumer and provisioned sidecar.
- Archive/history behavior and matching desktop/web/mobile/Pencil UI once implementation begins. Live PR/CI ingestion remains a separate later capability.

These are proposed acceptance gates. No statement in the report certifies that they have passed. The Cursor comparison remains limited to inspected client implementation/protocol and local storage shape; its private database and cloud scheduler were not reconstructed. The [capability tracker](projects-capability-tracker.md) preserves that distinction.

**Subsequent Cursor recheck**

The [fresh Cursor inspection](cursor-implementation-followup.md) adds current official documentation and exact client branches for completion retries, explicit-await suppression and generation guards. The report/schema now explicitly keep reads observational and distinguish source acceptance, executor admission, transcript append evidence and model outcome. Qualification additionally covers abort after append without implicit replay, and an old finalizer arriving after conversation replacement without clearing new execution state. Future cursor-based subscriptions must not skip earlier unfinished entries. These findings clarify existing records; they add no generic scheduler or consumption table to v1.

**Buildability and over-engineering challenge**

A further independent scope audit agrees that the full target is credible but would overburden the first local milestone. Three reductions are now applied: begin with local core modules and extract the shared package at the second host; retain PR URLs/provenance in reports and add aggregation tables with the actual PR collection; keep folder coordinators, replacement, richer interactions, provider parity and full UI after the first one-coordinator/one-child proof. Nine core tables remain, preserving distinct creation, input, delivery, assignment and publication facts. This is less implementation surface, not a claim that coordination becomes a tiny feature.

The source recheck found existing initialization and command services already provide part of the proposed boundary. Use them: caller-reserved session IDs and request-independent send/stop policy justify narrow changes; the service names in the report do not require extra facade classes. Source references: workspace-init.service.ts's session stage and initializeWorkspace; services/agent/commands.ts's handleSendMessage/handleStopSession; agents/core/engine.ts's Claude MCP setup. No product source was edited.

The root walkthrough also found a missing total-work bound: concurrency alone permits indefinite follow-ups. A finite dispatch allowance now gates reservation, derives usage from retained dispatch rows and requires human authorization to raise. It is not a per-turn spend guarantee. The final implementation must exercise limit exhaustion across restart and transport retry, while preserving queued input and allowing cancellation/publication/reconciliation.

The remaining user-facing policy question is whether the first release handles a defined result then pauses for review, or autonomously chooses new work. A question was sent; the report records the recommended bounded mode and proposed child/final acceptance split as pending direction. There is enough information for the internal proof, but no live evidence yet for exact effort, harness tool parity, admission/quiescence and process recovery. These need coding qualification, not another speculative rewrite.
