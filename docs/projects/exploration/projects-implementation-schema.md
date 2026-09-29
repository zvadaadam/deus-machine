**Rigorous qualification update — 14 September 2026.** The [actual-use report](projects-rigorous-report.md) supersedes the earlier validation counts: 1,127 backend tests, 88 Deus agent-server tests (seven conditional skips), 739 upstream engine tests, and a two-contributor dashboard delivered, used and accepted through the UI. It records fixed queue/provenance/recovery issues, the reproducible temporary engine patch, live background-notification and process-cancellation qualification, and remaining local/cloud limits. The broader design below remains a target, not a claim that deferred cloud features exist.

**Implementation update — 14 September 2026.** The working local version is now implemented. The checked-in [local Projects guide](../../../docs/local-projects.md) and source code describe what exists; the design below remains the broader local/cloud target. Local scope includes one repository and Claude harness per Project, managed worktrees, durable inputs/dispatches/outcome delivery, seven tools, immutable content/report versions, PR associations/provenance, and Project UI. Fresh managed conversations, folder coordinators, multiple repositories and cloud ownership/execution remain deferred.

Validation: 1,088 backend tests, 88 agent-server tests (7 optional live tests skipped), type checks, web build, two real model Project workflows, real Pause/Continue/Resume, idle owner process restart, UI report acceptance and versioned-document publication. Active-owner crash behavior has deterministic wire coverage, not a complete OS-process kill matrix. Desktop-shell qualification is recorded in the local guide.

**Projects — implementation schema and invariant specification**

Companion to the [implementation report](projects-implementation-report.md), 14 September 2026. Proposed v1 schema, not executed DDL, migrations or Cursor server tables. The physical local/cloud differences below are deliberate. Existing transcript/accounting stores remain authoritative; this document specifies all new Project record families and required existing-record changes for the reported scope.

This is the target schema, not one initial migration checklist. Internal slice B uses the nine core Project tables through reports; PR association/source tables enter at D before the Project PR collection ships. Folder placement, replacement and durable parked interactions enter with their features. B retains original PR locators/execution provenance in reports; pr_source_ids_json can be absent until those associations exist. Cloud-specific records enter with cloud slices. Implement only supported typed operation variants, not future no-op stubs.

**Conventions and identity**

- New internal IDs are reserved UUIDs; TEXT in SQLite, appropriate text/UUID representation in PG consistent with the host. New timestamps use epoch milliseconds at the domain boundary; adapters normalize existing host date representations.
- PK means primary key; UQ unique; FK applies only inside the same database. Cross-service references are validated through authenticated APIs and stored with a namespace, not declared as SQL FKs.
- Every Project-owned table includes project_id in its keys/queries, including a per-Project DO. This keeps scope explicit in the portable contract. Cross-Project reads are catalog/projection operations.
- ExecutionRef = authority_key, workspace_id, optional session_id and turn_id. authority_key identifies a configured execution service/node, not a user-provided URL. Agent ID is the stable dedicated-workspace handle. Locally it equals the local workspace ID; cloud creation reserves its workspace handle. Record explicit provider/native mappings even when their strings happen to match.
- PrincipalRef is either the authenticated local-owner scope or verified cloud account/org. Local-only Projects can work without cloud login. Selecting cloud execution captures its account/org principal explicitly; switching the desktop login does not retarget queued work.
- Request JSON is schema-validated, versioned and fingerprinted after normalization. Freeze effective nonsecret options and content versions. Store credential references/principal, never bearer tokens or provider secrets in request snapshots.

**1. projects**

| Field                                                                      | Type / meaning                                                                                                       |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| id                                                                         | PK                                                                                                                   |
| authority_key, scope_json, created_by_json                                 | Immutable owning service/local installation and authorization scope                                                  |
| title                                                                      | Product title; detailed objective lives only in brief.md                                                             |
| lifecycle                                                                  | creating, active, archived, deleted                                                                                  |
| coordinator_agent_id                                                       | Nullable during creation; same-Project Agent otherwise                                                               |
| paused_at, pause_revision                                                  | Durable human scheduling gate; revision increases on gate changes                                                    |
| revision                                                                   | Monotonic Project query/projection revision                                                                          |
| content_head_revision                                                      | Current published manifest; NULL only inside initialization transaction, committed as revision 0 with empty manifest |
| execution_defaults_json, execution_principal_json                          | Defaults copied/resolved when preparing Agent/dispatch; not dynamic UI settings                                      |
| child_concurrency_limit                                                    | Bounded children; coordinator work uses separate reserved capacity                                                   |
| dispatch_limit                                                             | Finite nonnegative total dispatch allowance for the experiment; raising it requires authorized human set_limits      |
| created_at, updated_at, deleted_at                                         | Lifecycle timestamps                                                                                                 |
| projection_dirty_revision, projection_synced_revision, projection_retry_at | Cloud directory sync progress; omitted/unused locally                                                                |

FK/coordinator invariant: coordinator_agent_id identifies a member of this Project; clear during creation/replacement only under defined state. Do not store an independently editable coordinator role on membership. Local transactions can enforce the composite relationship; cloud membership is in the same Project DO. Changing coordinator Agent is deferred unless required for repair; changing its current conversation is supported.

Indexes: local lifecycle/updated_at for listing; cloud global listing uses project_directory. Never infer pause from workspace power state. Operational row deletion is not v1 archive: retain a minimal routing tombstone when content/history is explicitly purged.

Local CreateProject uses a caller-reserved Project ID and operation ID. In one transaction insert the creating Project with no content head, its create_project operation, empty revision 0 and then its head pointer. This avoids an immediate Project/revision FK cycle. Duplicate IDs validate original scope/request hash. Cloud first reserves its org directory row, then initializes the same owner records. Initial coordinator CreateAgent sets coordinator_agent_id after membership exists in that transaction; only a sole coordinator request can claim the empty pointer. Project activation waits for coordinator preparation; failed initialization remains recoverable.

**2. project_agents — membership plus Project execution policy**

Common fields: project_id, agent_id (composite PK); execution_authority, execution_workspace_id; creation_operation_id; lifecycle (creating, active, archived); paused_at, pause_revision; execution_defaults_json, execution_principal_json; created_at, updated_at. These are membership/control records, not reusable agent personas.

| Host  | Physical current-conversation/title storage                                                                                                                                                |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Local | workspaces.current_session_id, new workspaces.conversation_generation and existing title are authoritative; Project Agent view joins them. Do not duplicate these fields in project_agents |
| Cloud | project_agents adds title, current_session_ref_json and conversation_generation, representing the platform-acknowledged binding                                                            |

Local: UQ(agent_id), FK agent_id → workspaces.id with DELETE RESTRICT; FK project_id → projects.id. This prevents repository/workspace cascading deletion from silently erasing managed history. User-facing deletion routes must explain and handle the restriction. Cloud: no cross-database FK to AGNT; immutable managed-workspace owner binding supplies one-Project ownership. No arbitrary attach endpoint in v1. Project scope validates every executor response.

Local creation inserts an initializing workspace shell before membership in the same transaction as the operation and initial work; reserve the initial session ID for the initializer. A failed preparation retains that shell for repair. Never insert membership before satisfying its workspace FK.

Indexes: (project_id,lifecycle), local agent_id lookup, (execution_authority,execution_workspace_id). Derive role by comparing projects.coordinator_agent_id. Current session must belong to this execution workspace. Runtime availability and execution progress come from source receipts/projections, not membership lifecycle.

**3. project_assignments**

Fields: project_id, id (PK); agent_id; initiating_input_id; brief_ref_json (Project/path/revision/hash); optional task_ref_json for a later document convention; state (open, accepted, cancelled); accepted_report_id nullable; created_at, accepted_at, cancelled_at.

FKs inside the owner to Agent, initiating input and accepted report. Service validates the accepted report belongs to this assignment. One open assignment per Agent in v1 (partial UQ project_id/agent_id WHERE state=open). A follow-up/revision can continue an assignment across turns and fresh conversations; each dispatch/report still identifies its exact execution. A new requested result after acceptance is a new assignment.

Creation avoids an immediate-FK cycle: insert the initial input with assignment_id NULL, insert its assignment referencing that input, then set the input's assignment_id before this transaction commits. Immutability starts at acceptance/commit. accepted_report_id remains NULL until a report already exists. Use composite project_id relationships to reject cross-Project references even when an ID is otherwise valid.

Instructions remain in the immutable initiating input and selected document revisions. Do not add independently editable SQL task prose or a second running/failed status: execution facts belong to turns/dispatches. Index (project_id,agent_id,state).

**4. project_operations — finite product command ledger**

Fields: project_id, id (PK); kind; actor_ref_json; target_agent_id nullable; request_json, request_hash, schema_version; state (pending, waiting, succeeded, failed, uncertain); stage; reserved_refs_json; receipt_json; attempt_version; next_attempt_at; error_json; created_at, updated_at.

Known target kinds: create_project, create_agent, replace_conversation, send_input, replay_input, publish_content, report_result, pause, resume, stop, archive, accept_report, set_limits, delete_project. This is a fixed command ledger with typed stages, not a configurable workflow engine. Cloud Project creation has its initial reservation in project_directory before this owner exists. set_limits records the human actor and changed limits; contributors/coordinators cannot enlarge their own allowance.

UQ(project_id,id): same identity plus different normalized request conflicts. Tool invocation IDs are mapped to these IDs by trusted source context; a distinct user action creates a new ID. Reserved workspace/session/replacement identities and remote receipts are persisted here before I/O. An attempt version rejects stale asynchronous completions from overwriting newer local repair state; it does not mint a new remote idempotency key.

Indexes: due (state,next_attempt_at), target_agent_id/kind for unresolved lifecycle operations. Mutating the Project and storing a successful command receipt are one owner transaction. Duplicate retries repair pending wake registration before returning where actionable work remains.

Enforce at most one unresolved create_agent/replace_conversation/archive operation per Agent, using a transaction gate and partial UQ on target Agent for pending/waiting/uncertain lifecycle operations. Hold it through source activation and owner acknowledgement. An uncertain operation cannot become terminal failed while its execution obligations remain. Pause can commit independently; another replacement/archive waits for reconciliation instead of sealing a staged replacement underneath activation.

**5. project_inputs**

Fields: project_id, id (PK); project_sequence; kind (direction, message, question, reply, turn_outcome, result_available); payload_json, payload_hash; origin (human, agent, system, automation); source_ref_json; dedup_key; recipient_json; assignment_id nullable; reply_to_input_id nullable; readdresses_input_id nullable; created_at; superseded_at/reason nullable. Question subtype additionally has resolution_state (open, answered, superseded, interrupted) and resolved_by_input_id nullable.

recipient_json is a validated union: fixed Agent/session/generation, or coordinator-role selector for Project-level direction/outcomes. A directed input is fixed at acceptance. A role selector binds in the dispatch; intentional later re-presentation may reuse it only for the same resolved conversation, otherwise create an explicitly readdressed input. Accepted payload/source/selector never mutate.

UQ(project_id,dedup_key), UQ(project_id,project_sequence). Source terminal dedup keys include authority/session/turn and stable terminal identity, not socket sequence. A replay with conflicting source content is surfaced. Replies resolve one open question with a CAS while inserting the reply input; retrying the same operation returns the previous receipt. No automatic replay of failed reasoning.

Coordinator terminal outcomes settle their dispatch receipt without generating coordinator wake inputs. Actionable child outcomes/questions/results create those inputs. Routine question dispatch eligibility also requires its exact source turn to have yielded. Source terminal envelopes remain immutable; owner batching joins question/result references without rewriting source payloads.

Indexes: (project_id,project_sequence), assignment_id, reply_to_input_id, open-question recipient lookup. No transcript messages/parts are copied here; payloads are bounded summaries plus durable references.

**6. project_dispatches and project_dispatch_inputs**

Dispatch fields: project_id, id (PK); agent_id; target_execution_ref_json, conversation_generation; assignment_id nullable; frozen_request_json, request_hash, schema_version; content_revision; principal_ref_json; pause_revision; phase (prepared, submitting, admitted, started, finished, rejected, revoked); admission_certainty (known, unknown); execution_obligation (open, uncertain, quiescent); executor_turn_id nullable; receipt_json, source_outcome_json nullable; next_check_at, last_error_json; created_at, admitted_at, started_at, ended_at, closed_at nullable.

The dispatch ID is the stable source idempotency key. Nullable executor_turn_id becomes fixed on positive admission evidence. Store an executor/source outcome summary as acknowledged evidence, not a second accounting ledger. A terminal error can coexist with uncertain execution; closed_at is set only when no source writer/admission obligation remains. Local and cloud enforce one open dispatch per dedicated Agent: partial UQ(project_id,agent_id) WHERE closed_at IS NULL.

Dispatch-input fields: project_id, dispatch_id, input_id (PK); position; replay_of_dispatch_id and replay_operation_id nullable; reserved_at; released_at nullable. UQ(dispatch_id,position); partial UQ(project_id,input_id) WHERE released_at IS NULL. This permits an explicit later delivery attempt while retaining history and prevents two unresolved dispatches claiming the same input. Transport retries reuse the dispatch and these rows. Release reservations only on confirmed rejection/revocation/quiescence, not a socket failure. FKs remain within Project storage.

Release does not make input eligible again. Automatic selection excludes inputs with any admitted delivery; replay requires a succeeded authorized replay_input operation and links to the prior delivery. Confirmed pre-admission rejection can retry the original immutable dispatch under its defined retry policy. Uncertain admission blocks reselection. Explicit revocation does not automatically authorize another send. Replays retain their original resolved conversation; replacement requires a new readdressed input. Admission evidence remains even after the dispatch closes.

Status/transcript reads never write consumption or delivery state. Source delivery acknowledgement proves owner persistence, dispatch admission proves executor acceptance, and terminal outcome describes execution; they are distinct receipts. There is no Await/implicit-consumption record in v1. Add explicit consumption identity only if that operation is introduced later.

At dispatch reservation, transactionally require COUNT(project_dispatches for this Project) < projects.dispatch_limit. Count every reserved unique dispatch, including later rejected attempts; a same-ID transport retry reuses its existing reservation. Retain this history for the allowance lifetime. No counter table is needed. Reaching the limit blocks new dispatches/Agent creation and exposes a derived limit-reached state; it does not set or clear human Pause, cancel already-reserved work, discard input or prevent settlement/publication. This is an attempt allowance, not a monetary or per-turn token guarantee. A future spend budget requires separate usage evidence and policy.

Indexes: due open dispatches (closed_at,next_check_at); executor authority/session/turn lookup; assignment; dispatch_inputs by input_id. Batch reads avoid one query per Agent or input.

**7. project_content_revisions**

Fields: project_id, revision (PK); parent_revision nullable for initial revision; manifest_json; manifest_hash; publishing_operation_id; author_ref_json; created_at.

Manifest v1 maps normalized relative paths to immutable blob references: storage namespace/key or immutable version, hash, byte length, media type. A host content adapter verifies uploaded bytes and allowed scope before the transaction compares expected head, inserts the new revision, changes projects.content_head_revision and stores the operation/report receipt. No SQL document-body table; no assumption a filesystem/object write participates in the metadata transaction.

Manifest size/path/count limits are explicit API configuration; a full-manifest snapshot is sufficient initially. If those limits are reached, introduce indexed entries without changing revision references. Directory trees/Notes/task views are projections over the same manifest. Published reports/assignments pin revisions even when a path is removed from current Context. Garbage collection traces retained references; do not implement destructive automatic revision pruning in the first experiment.

**8. project_reports**

Fields: project_id, id (PK); operation_id (UQ within Project); assignment_id; source_execution_ref_json; source_agent_id; source_generation; summary; content_revision; artifact_refs_json (path/blob/hash/version refs); original_pr_locators_json; pr_source_ids_json; submitted_at.

Immutable after submission. FK to assignment and retained content revision inside the owner; source execution references have no cascading FK to runtime/session rows. A revision can be pinned without uploading new files. Report outcome/readiness is derived by joining the exact source dispatch/terminal; acceptance belongs to assignment.accepted_report_id. Index assignment_id/submitted_at and exact source session/turn. New corrections produce a new report, not an overwrite.

**9. project_pull_requests and project_pr_sources**

PR-link fields: project_id, id (PK); normalized_locator; external_key nullable; provider, host, external_repository_identifier, pr_number nullable until verified; canonical_url; verification_state (pending, verified, error); cached_title/state/draft/head/base/checks/review JSON; checked_at, sync_error_json; linked_at, removed_at nullable.

UQ(project_id,normalized_locator); partial UQ(project_id,external_key) WHERE external_key IS NOT NULL. external_key uses provider/host/stable repository identity/PR number. PR number alone is never canonical. Each Project owns its associations/cache; another Project can track the same external key. A global SCM cache is optional later infrastructure.

Source fields: project_id, id (PK); pr_link_id; report_id nullable; source_execution_ref_json nullable; actor_ref_json; original_locator; relation (linked, reported, verified_created); source_dedup_key; created_at. UQ(project_id,source_dedup_key). Sources belong to an association; their evidence remains after runtime cleanup. If enrichment discovers duplicate PR parents, atomically reparent sources into the existing canonical association before removing the empty duplicate. Reports retain source IDs and original locators, not transient parent IDs. Removing a Project association is explicit; it does not delete GitHub state.

Indexes: PR state/checked_at for bounded enrichment; sources by parent, report and exact execution. Initial updates come from explicit links/terminal refresh and authenticated reads; full PR/CI subscription ingestion is a later cloud delivery feature.

**10. Existing local records and source interactions**

| Existing owner    | Required change                                                                                                                                                                                                                                                                                                                                                         |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| workspaces        | repository_id becomes nullable; conversation_policy multiple or managed_single_current; conversation_generation integer; current_session_id must belong to this workspace. Folder placement is explicit (e.g. kind=folder, path derived from immutable workspace ID under app data), with no fake repository. Ordinary worktree paths and cloud provider mapping remain |
| sessions          | Keep workspace FK, harness/native/provider identities and transcript history. Fresh conversation creates a new row with no old native resume ID. Current eligibility is checked against workspace/Project policy, never inferred from status=idle                                                                                                                       |
| turns             | Keep existing execution/outcome/accounting authority. Local terminal + Project input can share a transaction; alternatively retain a source recipient/pending-ack record and reconcile, using the same envelope as cloud                                                                                                                                                |
| repositories      | No automatic orphaning/deletion of managed workspaces through the current cascade. Application guard plus managed membership RESTRICT makes this visible                                                                                                                                                                                                                |
| query projections | Return owning workspace facts for historical sessions; Agent/current/history targets are explicit, unrelated to saved selected tab                                                                                                                                                                                                                                      |

Add source-owned session_interactions when durable human questions/approvals enter the implemented scope. Fields: session_id, interaction_id (PK), turn_id, kind (question, permission, hook_decision), tool_call_id, request_payload_json, state (waiting, answered, interrupted, expired), answer_payload_json nullable, answer_actor_json, generation/source identity, created_at, resolved_at. UQ on source invocation identity; index waiting interactions by session. Only an authenticated explicit human decision supplies approval answers. Persistence does not reconstruct a lost SDK promise: source recovery must either reconnect its actual waiter or mark interrupted and request a new interaction. Project inputs reference this source record and do not duplicate its mutable answer authority.

No other changes to messages, parts, turns, compactions, automation accounting or paired-device ownership are implied. Existing prelaunch reset policy governs eventual local schema implementation; this planning exercise does not reset a database.

**11. Cloud product directory and runtime enforcement records**

PG project_directory fields: project_id (PK), organization_id, created_by_account_id, creation_operation_id/request_hash/request_json, creation_state (reserved, initialized, failed); projected_title/lifecycle/revision; last_sync_at, repair_checked_at, conservative_next_due_at nullable; deletion_tombstone_at nullable. FK org/account follows product deletion policy. UQ(org,creation_operation_id); index org/lifecycle/project_id for discovery and repair_checked_at for rotating repair. Directory reservation precedes DO initialization; failed/creating rows remain recoverable. Project DO owns subsequent operational facts. Revision-guarded projection sync never overwrites a newer row. Tombstones explicitly acknowledge discarded late deliveries.

Required protected platform extensions (not user-editable workspace/session metadata):

| Owner                                      | Fields / enforcement                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Workspace DO control state                 | Managed controller kind/authority, Project ID, Agent ID; managed current session and generation; last replacement operation/receipt. Set at creation; ordinary API/session creation cannot change it. CAS replacement validates the old binding                                                                                            |
| AgentSession DO control state              | Immutable owner/workspace binding; generation; admission state staged, active or sealed; activation/sealing/replacement operation receipts. After Workspace validation, source-local CAS staged→active rechecks state after the await; sealed never reactivates. Enforce after asynchronous preparation at the final admission transaction |
| Source admission receipt/revocation record | Dispatch key, normalized request fingerprint, actual turn ID, admission/queue evidence, revoke marker and time. Revocation before arrival blocks the later request. Expose narrow trusted lookup/cancel APIs, not internal queue dumps                                                                                                     |
| Source turn delivery fields                | Trusted recipient Project/dispatch/generation; stable terminal delivery key; immutable envelope_json and envelope_hash frozen at first terminal; pending/acknowledged/discarded state; retry time, attempt count and receipt. Commit pending delivery with first terminal; retain until acknowledged                                       |
| Source tool-operation grant                | Exact session/turn/generation, mutation ID/hash, allowed operation and source acceptance evidence; new grants require an active source turn. Existing grants/receipts distinguish accepted in-flight work from stale new writes                                                                                                            |
| Source interactions                        | Durable question/permission/hook requests and response state as above; restore or explicitly interrupt on loss                                                                                                                                                                                                                             |

These extend existing state/turn stores where practical; they do not require a new Project Agent DO or a generic subscription database. Account/org auth and provider brokers stay in their current owners. Managed binding is enforced at every public and trusted execution entrypoint, regardless of token age or client UI. Source recipients are service identities, never arbitrary model-supplied webhook URLs.

Integrate source delivery retry deadlines into AgentSession's existing watchdog/flush alarm computation, preserve concurrent deadlines and repair on wake. Exact source delivery read/ack supports owner reconciliation. ProjectDO alarms alone are insufficient. Local tool invocation must capture the exact source turn/mutation identity before asynchronous relay; session-only setup cannot authorize against whichever turn happens to be latest later.

The cloud-v1 controller is a trusted product service. Managed local-owner/cloud-child operation needs an additional authenticated HTTP delegation and reconnectable outbound delivery contract; it is deferred, not implicitly authorized by ordinary org API keys. The same shared core still supports local-local and cloud-cloud hosts. No delegation-credential table is claimed implemented or specified for v1 here.

**12. Transaction and retention rules a migration/implementation must preserve**

1. Local Project metadata, lifecycle pointer changes and receipts commit together where they share deus.db. External provisioning/engine calls never occur inside that transaction.
2. Cloud Project state plus pending work/projection revision commit in Project DO; AGNT Workspace/Session changes use a durable step protocol regardless of owner placement. Never advertise a cross-DO atomic pointer swap.
3. Publication bytes precede manifest/report metadata. Lost acknowledgement retries the same operation. Precommit orphan blobs are safe to collect only after checking durable references/accepted operations.
4. First source terminal freezes its delivery obligation; first owner outcome commit records its receipt and any actionable child inputs before acknowledgement. A duplicate cannot create another input. Coordinator outcomes do not create self-wake inputs. Recovery tolerates duplicate delivery, not duplicate model reasoning guarantees.
5. Paused/archived Projects still reconcile already-accepted work. Deleted Projects retain enough routing state to acknowledge discarded source events. Runtime cleanup and explicit history deletion are different operations.
6. Local FK restrictions prevent silent cascade loss; cloud references are authenticated and checked rather than fake foreign keys. Retained report/PR evidence can say its source transcript was explicitly deleted.
7. Derived UI progress, coordinator roles, PR readiness and deadlines are projections. Each has one declared authority; no second independently editable status or objective exists.
