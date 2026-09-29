**Shared UI qualification — 15 September 2026.** [Latest report](projects-ui-simplification-report.md) records sidebar-only Projects, shared workspace creation/shell/composer, folder-based Documents, pinned previews, publication/creation retry checks, and actual queued/foreground process cancellation. It supersedes older UI descriptions and validation counts below; cloud targets remain deferred.

**Rigorous qualification update — 14 September 2026.** The [actual-use report](projects-rigorous-report.md) supersedes the earlier validation counts: 1,127 backend tests, 88 Deus agent-server tests (seven conditional skips), 739 upstream engine tests, and a two-contributor dashboard delivered, used and accepted through the UI. It records fixed queue/provenance/recovery issues, the reproducible temporary engine patch, live background-notification and process-cancellation qualification, and remaining local/cloud limits. The broader design below remains a target, not a claim that deferred cloud features exist.

**Deus Projects — build-plan index**

**Implementation update — 14 September 2026.** The working local version is now implemented. The checked-in [local Projects guide](../../../docs/local-projects.md) and source code describe what exists; the design below remains the broader local/cloud target. Local scope includes one repository and Claude harness per Project, managed worktrees, durable inputs/dispatches/outcome delivery, seven tools, immutable content/report versions, PR associations/provenance, and Project UI. Fresh managed conversations, folder coordinators, multiple repositories and cloud ownership/execution remain deferred.

Validation: 1,088 backend tests, 88 agent-server tests (7 optional live tests skipped), type checks, web build, two real model Project workflows, real Pause/Continue/Resume, idle owner process restart, UI report acceptance and versioned-document publication. Active-owner crash behavior has deterministic wire coverage, not a complete OS-process kill matrix. Desktop-shell qualification is recorded in the local guide.

**Broader design references**

1. [Implementation report](projects-implementation-report.md): local and cloud architecture, creation/replacement, messaging, outcome delivery, tools, content, PRs, UI, retention and build stages.
2. [Schema specification](projects-implementation-schema.md): proposed fields, relationships, constraints, indexes, authority boundaries and transaction/deletion rules.
3. [Coding-pass review](projects-implementation-review.md): imagined end-to-end implementation, gaps found, corrections applied, self-feedback and remaining qualification.
4. [Capability tracker](projects-capability-tracker.md): Deus today, verified Cursor evidence, build-next scope and future additions.

For shipped behavior, use the checked-in local guide and current code. The report and schema retain the cloud/future target and supersede older proposals within that scope. Earlier source findings remain evidence within their stated limits. All four documents are saved in this workspace's gitignored .context directory; they are not committed repository documentation.

**Decisions to preserve**

- Project identity/content/coordination persist independently of execution. Agent is a dedicated workspace handle with one current runnable conversation and readable history. Ordinary workspaces retain multiple runnable chats. One managing Project per dedicated workspace; arbitrary adoption and reusable persona entities are deferred.
- CreateAgent composes existing workspace preparation, membership, assignment and first dispatch. There is no separate coordinator CreateWorkspace tool. Use durable reserved identities and immutable operation requests.
- Local workspaces.current_session_id remains the sole local pointer, with a generation. Cloud Project state keeps an acknowledged pointer backed by protected Workspace/Session enforcement bindings. Remote replacement is recoverable steps, never a cross-service SQL transaction.
- Start core/contracts as bounded local modules. Validate and extract the shared product package when the ProjectDO second host enters at C. Reuse existing execution, transcript and accounting stores; expose only the required seams in existing workspace initialization/send/stop services. No prerequisite generic scheduler framework or Project-aware harness.
- Seven scoped tools: CreateAgent, GetAgentStatus, ReadAgentTranscript, SendToAgent, ReportResult, StopAgent and PublishContext. Owner checks permissions and exact source-turn identity. Human Pause/Resume, replacement, acceptance and approval answers have explicit owner APIs.
- Accepted inputs, dispatches and source outcomes have stable identities. One unsettled dispatch per dedicated Agent; no implicit redelivery, silent retargeting or coordinator self-wakeup. Questions and results are durable; parked human interactions remain source-owned.
- A finite total dispatch allowance accompanies the concurrency limit in the experiment. Same-dispatch retries reuse their reservation; only an authorized human can raise limits. This bounds attempts, not money or tokens inside a turn.
- Documents live in one versioned file namespace with immutable manifests/blobs. Notes views the same files. Reports pin assignment/execution/artifact revisions. Git autosave is separate execution recovery.
- Each Project stores PR associations/cache and provenance, using stable external PR identity. Links open GitHub. Merge state does not automatically accept assignments. Archive retains history; destructive runtime/history cleanup is separate.
- Local v1 is local-owner/local-execution; cloud v1 is cloud-owner/cloud-execution. A desktop may view/control a cloud-owned Project through that owner. Managed local-owner/cloud-child execution and owner migration are deferred until delegated control and reconnectable outcome delivery are specified.
- The [Cursor follow-up](cursor-implementation-followup.md) also tracks future cloud-owner/local-verification execution, observational status/transcript reads, distinct receipt stages, and external-event coalescing/rereads. It rechecks installed implementation and adds official public evidence; these refinements are incorporated into the report/schema.

**Execution order**

| Stage                                                      | Build                                                                                                             | Gate                                                                                                             |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| A — implemented                                            | Expose the needed request-independent seams in existing preparation/send/stop                                     | Preserve standalone behavior; actual cancellation; identified policy entrypoints                                 |
| B — implemented                                            | Local modules, repository-backed coordinator/child, one qualified harness, published content and nine core tables | Works without mounted UI; actual restart/retry/stop; finite dispatch allowance; no self-wake/replay loop         |
| C                                                          | Host same core on ProjectDO with fake executor and extract shared package                                         | Host portability; directory/alarm/repair cases before a large UI build                                           |
| D — partly implemented; folder/fresh conversation deferred | Local parallelism, durable questions, Pause UI/fresh history, folder coordinator, PR aggregation and Project UI   | No overlapping writers; provenance/retention; shared renderers and Pencil parity                                 |
| E                                                          | Real managed AGNT execution and source tool/outcome contracts                                                     | Public bypass rejected; delayed admission/revocation; source alarm coexistence; every replacement crash boundary |
| F                                                          | Cloud product content/discovery/push and browser flows                                                            | Authorized Mac-disconnected progress; auth revocation; results survive VM loss                                   |

Each stage has detailed obligations in the report. The first real cloud test uses one child before parallelism. Engine/package changes belong in their existing upstream ownership; release and pin required platform changes before claiming consumer support. No live test or production guarantee follows from inspecting source alone.

B is an internal proof, not the complete local release. It keeps PR locators/execution provenance in reports; D adds the two PR association/source tables before the Project PR collection ships. B retains a durable stop gate even though the complete Pause UI arrives later. Fresh-conversation, folder and parked-interaction features do not enter B merely because the target schema names them.

Implemented local policy: defined result followed by human review; ongoing autonomous new work is not enabled. Coordinator evaluation/acceptance of child assignments and human acceptance of the final Project outcome are the proposed default; no merge/deploy authority is implied. See report section 11 for confidence, complexity and remaining live qualification. More competitive research is not a prerequisite for the first local proof.

**Research retained**

- [Initial feasibility](cursor-projects-feasibility.md) and [earlier cloud-ready proposal](projects-cloud-ready-architecture.md).
- [Cursor project/document/storage audit](cursor-projects-data-model.md), [Agent/workspace/PR identity](cursor-agent-workspace-relationship.md), and [notification/tool audit](cursor-project-notification-findings.md).
- [Earlier local coding walkthrough](projects-second-dry-run.md) and [AGNT cloud implementation investigation](projects-cloud-implementation-dry-run.md).

Cursor client code/protocol and local storage shape were inspected; its private server database/cloud scheduler were not. The schema above is our proposed design, not a claimed copy of Cursor tables.
